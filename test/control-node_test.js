'use strict';

const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const configNode = require('../nodes/sectoralarm-config.js');
const controlNode = require('../nodes/sectoralarm-control.js');
const { makeFakeJwt } = require('./helpers/jwt');

const BASE = 'https://mypagesapi.sectoralarm.net';

helper.init(require.resolve('node-red'));

describe('sectoralarm-ng-control node', function () {
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
                id: 'ctl', type: 'sectoralarm-ng-control', name: 'control',
                account: 'cfg', action: 'useMsg', lockSerial: '', wires: [['out']],
                ...nodeProps
            },
            { id: 'out', type: 'helper' }
        ];
    }

    const credsWithCode = { cfg: { email: 'a@b.c', password: 'pw', code: '1111' } };
    const credsNoCode = { cfg: { email: 'a@b.c', password: 'pw' } };

    it('disarm posts PanelId + PanelCode from config credentials', async function () {
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Disarm', method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        await helper.load([configNode, controlNode], flow(), credsWithCode);
        const ctl = helper.getNode('ctl');
        const out = helper.getNode('out');

        ctl.receive({ payload: 'disarm' });
        const msg = await new Promise((resolve) => out.on('input', resolve));
        assert.deepEqual(seenBody, { PanelId: '123', PanelCode: '1111' });
        assert.equal(msg.payload.ok, true);
        assert.equal(msg.payload.command, 'disarm');
    });

    it('msg.payload.code overrides config code', async function () {
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Disarm', method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        await helper.load([configNode, controlNode], flow(), credsWithCode);
        helper.getNode('ctl').receive({ payload: { command: 'disarm', code: '9999' } });
        await new Promise((resolve) => helper.getNode('out').on('input', resolve));
        assert.equal(seenBody.PanelCode, '9999');
    });

    it('disarm without any code errors and sends no output', async function () {
        await helper.load([configNode, controlNode], flow(), credsNoCode);
        const ctl = helper.getNode('ctl');
        const out = helper.getNode('out');

        const received = [];
        out.on('input', (m) => received.push(m));
        const errPromise = new Promise((resolve) => ctl.on('call:error', resolve));
        ctl.receive({ payload: 'disarm' });
        await errPromise;
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(received.length, 0);
    });

    it('lock uses msg-level lockSerial override', async function () {
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Lock', method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        await helper.load([configNode, controlNode], flow({ lockSerial: 'CFG-SER' }), credsWithCode);
        helper.getNode('ctl').receive({ payload: { command: 'lock', lockSerial: 'MSG-SER' } });
        const msg = await new Promise((resolve) => helper.getNode('out').on('input', resolve));
        assert.equal(seenBody.LockSerial, 'MSG-SER');
        assert.equal(seenBody.SerialNo, 'MSG-SER');
        assert.equal(msg.payload.lockSerial, 'MSG-SER');
    });

    it('configured action fires regardless of payload', async function () {
        let seenBody;
        pool.intercept({
            path: '/api/Panel/PartialArm', method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        await helper.load([configNode, controlNode], flow({ action: 'partialArm' }), credsWithCode);
        helper.getNode('ctl').receive({ payload: 'anything' });
        const msg = await new Promise((resolve) => helper.getNode('out').on('input', resolve));
        assert.equal(msg.payload.command, 'partialarm');
        assert.equal(seenBody.PanelId, '123');
    });

    it('invalid command errors without calling the API', async function () {
        await helper.load([configNode, controlNode], flow(), credsWithCode);
        const ctl = helper.getNode('ctl');
        const errPromise = new Promise((resolve) => ctl.on('call:error', resolve));
        ctl.receive({ payload: 'explode' });
        await errPromise;
    });
});
