'use strict';

const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const configNode = require('../nodes/sectoralarm-config.js');
const statusNode = require('../nodes/sectoralarm-status.js');
const { makeFakeJwt } = require('./helpers/jwt');

const BASE = 'https://mypagesapi.sectoralarm.net';

helper.init(require.resolve('node-red'));

describe('sectoralarm-ng-status node', function () {
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

    function flow({ emitOnStart = false } = {}) {
        return [
            {
                id: 'cfg', type: 'sectoralarm-ng-config', name: 'acct', panelId: '123'
            },
            {
                id: 'st', type: 'sectoralarm-ng-status', name: 'status',
                account: 'cfg', interval: 60, emitOnStart, topic: 'sa/test',
                wires: [['out']]
            },
            { id: 'out', type: 'helper' }
        ];
    }

    const credentials = { cfg: { email: 'a@b.c', password: 'pw', code: '1111' } };

    function mockStatus(status, { times = 1 } = {}) {
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(200, { Status: status, IsOnline: true, StatusTime: 't' },
                { headers: { 'content-type': 'application/json' } })
            .times(times);
    }

    it('emits initial status when emitOnStart is set', async function () {
        mockStatus(3);
        await helper.load([configNode, statusNode], flow({ emitOnStart: true }), credentials);
        const out = helper.getNode('out');
        const msg = await new Promise((resolve) => out.on('input', resolve));
        assert.equal(msg.topic, 'sa/test');
        assert.equal(msg.payload.status, 'armed');
        assert.equal(msg.payload.previousStatus, null);
        assert.equal(msg.payload.changed, false);
        assert.equal(msg.payload.panelId, '123');
        assert.equal(msg.raw.Status, 3);
    });

    it('does not emit initial status by default, but input forces emission', async function () {
        mockStatus(1, { times: 2 });
        await helper.load([configNode, statusNode], flow(), credentials);
        const st = helper.getNode('st');
        const out = helper.getNode('out');

        const received = [];
        out.on('input', (msg) => received.push(msg));

        // Wait for the deploy-time poll to settle: no message expected.
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(received.length, 0);

        st.receive({});
        const msg = await new Promise((resolve) => out.on('input', resolve));
        assert.equal(msg.payload.status, 'disarmed');
        assert.equal(msg.payload.changed, false);
    });

    it('emits when status changes between polls (manual trigger)', async function () {
        mockStatus(1); // deploy poll → disarmed
        await helper.load([configNode, statusNode], flow(), credentials);
        const st = helper.getNode('st');
        const out = helper.getNode('out');
        await new Promise((r) => setTimeout(r, 200));

        mockStatus(3); // next poll → armed
        st.receive({});
        const msg = await new Promise((resolve) => out.on('input', resolve));
        assert.equal(msg.payload.status, 'armed');
        assert.equal(msg.payload.previousStatus, 'disarmed');
        assert.equal(msg.payload.changed, true);
    });

    it('reports API errors via done (Catch-compatible)', async function () {
        mockStatus(1); // deploy poll OK
        await helper.load([configNode, statusNode], flow(), credentials);
        const st = helper.getNode('st');
        await new Promise((r) => setTimeout(r, 200));

        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(500, 'boom').times(2); // both retry attempts fail

        const errPromise = new Promise((resolve) => {
            st.on('call:error', resolve);   // sinon spy hook from test-helper
        });
        st.receive({});
        await errPromise;
    }).timeout(10000);
});
