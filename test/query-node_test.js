'use strict';

const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const configNode = require('../nodes/sectoralarm-config.js');
const queryNode = require('../nodes/sectoralarm-query.js');
const { makeFakeJwt } = require('./helpers/jwt');

const BASE = 'https://mypagesapi.sectoralarm.net';

helper.init(require.resolve('node-red'));

describe('sectoralarm-ng-query node', function () {
    let mockAgent;
    let pool;
    let originalDispatcher;

    beforeEach(function (done) {
        originalDispatcher = getGlobalDispatcher();
        mockAgent = new MockAgent();
        mockAgent.disableNetConnect();
        setGlobalDispatcher(mockAgent);
        pool = mockAgent.get(BASE);
        pool.intercept({ path: '/api/Login/Login', method: 'POST' })
            .reply(200, { AuthorizationToken: makeFakeJwt(3600) },
                { headers: { 'content-type': 'application/json' } })
            .persist();
        helper.startServer(done);
    });

    afterEach(async function () {
        await helper.unload();
        await new Promise((resolve) => helper.stopServer(resolve));
        setGlobalDispatcher(originalDispatcher);
        await mockAgent.close();
    });

    function flow(nodeProps = {}) {
        return [
            { id: 'cfg', type: 'sectoralarm-ng-config', name: 'acct', panelId: '123' },
            {
                id: 'q', type: 'sectoralarm-ng-query', name: 'query',
                account: 'cfg', queryType: 'useMsg', pageSize: 10, wires: [['out']],
                ...nodeProps
            },
            { id: 'out', type: 'helper' }
        ];
    }

    const credentials = { cfg: { email: 'a@b.c', password: 'pw' } };

    async function run(payload, nodeProps) {
        await helper.load([configNode, queryNode], flow(nodeProps), credentials);
        helper.getNode('q').receive({ payload });
        return new Promise((resolve) => helper.getNode('out').on('input', resolve));
    }

    it('temperatures query hits GetTemperatures and passes payload through', async function () {
        pool.intercept({ path: (p) => p.startsWith('/api/Panel/GetTemperatures'), method: 'GET' })
            .reply(200, [{ Label: 'Sauna', Temperature: '70' }],
                { headers: { 'content-type': 'application/json' } });
        const msg = await run('temperatures');
        assert.equal(msg.topic, 'sectoralarm/temperatures');
        assert.equal(msg.payload[0].Label, 'Sauna');
    });

    it('status query returns normalized payload with raw attached', async function () {
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(200, { Status: 2, IsOnline: true },
                { headers: { 'content-type': 'application/json' } });
        const msg = await run('status');
        assert.equal(msg.payload.status, 'partialArmed');
        assert.equal(msg.raw.Status, 2);
    });

    it('logs query honors pageSize from msg', async function () {
        let seenPath;
        pool.intercept({
            path: (p) => { seenPath = p; return p.startsWith('/api/v2/panel/logs'); },
            method: 'GET'
        }).reply(200, { Records: [] }, { headers: { 'content-type': 'application/json' } });
        const msg = await run({ type: 'logs', pageSize: 25, pageNumber: 2 });
        assert.match(seenPath, /pageSize=25/);
        assert.match(seenPath, /pageNumber=2/);
        assert.equal(msg.topic, 'sectoralarm/logs');
    });

    it('panels query lists panels', async function () {
        pool.intercept({ path: (p) => p.startsWith('/api/account/GetPanelList'), method: 'GET' })
            .reply(200, [{ PanelId: '123', DisplayName: 'Koti' }],
                { headers: { 'content-type': 'application/json' } });
        const msg = await run('panels');
        assert.equal(msg.payload[0].DisplayName, 'Koti');
    });

    it('configured queryType used when payload is irrelevant', async function () {
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetLockStatus'), method: 'GET' })
            .reply(200, [{ Serial: 'L1', Status: 'lock' }],
                { headers: { 'content-type': 'application/json' } });
        const msg = await run('whatever-trigger', { queryType: 'locks' });
        assert.equal(msg.topic, 'sectoralarm/locks');
        assert.equal(msg.payload[0].Serial, 'L1');
    });

    it('invalid query type errors without output', async function () {
        await helper.load([configNode, queryNode], flow(), credentials);
        const q = helper.getNode('q');
        const received = [];
        helper.getNode('out').on('input', (m) => received.push(m));
        const errPromise = new Promise((resolve) => q.on('call:error', resolve));
        q.receive({ payload: 'nonsense' });
        await errPromise;
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(received.length, 0);
    });
});
