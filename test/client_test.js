'use strict';

const assert = require('node:assert/strict');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const { SectorClient, normalizeStatus } = require('../lib/client');
const { AuthError, ApiError, TimeoutError, SectorError } = require('../lib/errors');
const { makeFakeJwt } = require('./helpers/jwt');

const BASE = 'https://mypagesapi.sectoralarm.net';
const CREDS = { email: 'user@example.com', password: 'secret' };

describe('SectorClient', function () {
    let mockAgent;
    let pool;
    let originalDispatcher;

    beforeEach(function () {
        originalDispatcher = getGlobalDispatcher();
        mockAgent = new MockAgent();
        mockAgent.disableNetConnect();
        setGlobalDispatcher(mockAgent);
        pool = mockAgent.get(BASE);
    });

    afterEach(async function () {
        setGlobalDispatcher(originalDispatcher);
        await mockAgent.close();
    });

    function mockLogin({ times = 1, token = makeFakeJwt(3600) } = {}) {
        pool.intercept({ path: '/api/Login/Login', method: 'POST' })
            .reply(200, { AuthorizationToken: token }, { headers: { 'content-type': 'application/json' } })
            .times(times);
        return token;
    }

    it('logs in and sends Bearer token on subsequent GET', async function () {
        const token = mockLogin();
        let seenAuth;
        pool.intercept({
            path: (p) => p.startsWith('/api/panel/GetPanelStatus'),
            method: 'GET',
            headers: (h) => { seenAuth = h.authorization; return true; }
        }).reply(200, { Status: 3, IsOnline: true }, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        const result = await client.getPanelStatus('123');
        assert.equal(result.Status, 3);
        assert.equal(seenAuth, `Bearer ${token}`);
    });

    it('login posts UserId/Password JSON body', async function () {
        let seenBody;
        pool.intercept({
            path: '/api/Login/Login',
            method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, { AuthorizationToken: makeFakeJwt() }, { headers: { 'content-type': 'application/json' } });
        pool.intercept({ path: (p) => p.startsWith('/api/account/GetPanelList'), method: 'GET' })
            .reply(200, [], { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        await client.getPanelList();
        assert.deepEqual(seenBody, { UserId: CREDS.email, Password: CREDS.password });
    });

    it('throws AuthError on 401 login and suppresses retry during cool-down', async function () {
        pool.intercept({ path: '/api/Login/Login', method: 'POST' })
            .reply(401, { Error: 'incorrect_username_or_password' },
                { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        await assert.rejects(client.getPanelList(), AuthError);
        // Second call: no login interceptor registered anymore — if the client
        // tried to log in again, MockAgent would throw a different error.
        await assert.rejects(client.getPanelList(), AuthError);
    });

    it('deduplicates concurrent logins (5 parallel calls, 1 login)', async function () {
        mockLogin({ times: 1 });
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(200, { Status: 1 }, { headers: { 'content-type': 'application/json' } })
            .times(5);

        const client = new SectorClient(CREDS);
        const results = await Promise.all(
            Array.from({ length: 5 }, () => client.getPanelStatus('123'))
        );
        assert.equal(results.length, 5);
        // If more than one login had fired, the single-use login interceptor
        // would have been exhausted and the call would have failed.
    });

    it('re-logs in automatically when the token is expired', async function () {
        mockLogin({ token: makeFakeJwt(-10) }); // already expired
        mockLogin({ token: makeFakeJwt(3600) });
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(200, { Status: 1 }, { headers: { 'content-type': 'application/json' } })
            .times(2);

        const client = new SectorClient(CREDS);
        await client.getPanelStatus('123'); // uses expired-at-issue token (fetches fresh on next call)
        await client.getPanelStatus('123'); // triggers second login
        assert.deepEqual(mockAgent.pendingInterceptors(), []);
    });

    it('on 401 from a data call: re-authenticates once and retries', async function () {
        mockLogin({ times: 2 });
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(401, 'expired');
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(200, { Status: 2 }, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        const result = await client.getPanelStatus('123');
        assert.equal(result.Status, 2);
    });

    it('two consecutive 401s on a data call throw AuthError (no infinite loop)', async function () {
        mockLogin({ times: 2 });
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetPanelStatus'), method: 'GET' })
            .reply(401, 'nope').times(2);

        const client = new SectorClient(CREDS);
        await assert.rejects(client.getPanelStatus('123'), AuthError);
    });

    it('retries transient 500 once, then succeeds', async function () {
        this.timeout(5000);
        mockLogin();
        pool.intercept({ path: (p) => p.startsWith('/api/Panel/GetTemperatures'), method: 'GET' })
            .reply(500, 'boom');
        pool.intercept({ path: (p) => p.startsWith('/api/Panel/GetTemperatures'), method: 'GET' })
            .reply(200, [{ Label: 'Olohuone', Temperature: '21' }],
                { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        const result = await client.getTemperatures('123');
        assert.equal(result[0].Label, 'Olohuone');
    });

    it('maps request timeout to TimeoutError', async function () {
        mockLogin();
        pool.intercept({ path: (p) => p.startsWith('/api/panel/GetLockStatus'), method: 'GET' })
            .reply(200, { ok: true }, { headers: { 'content-type': 'application/json' } })
            .delay(500)
            .times(2);

        const client = new SectorClient({ ...CREDS, timeoutMs: 50 });
        await assert.rejects(client.getLockStatus('123'), TimeoutError);
    });

    it('disarm posts PanelId and PanelCode, and requires a code', async function () {
        mockLogin();
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Disarm',
            method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        assert.throws(() => client.disarm('123', undefined), SectorError);
        await client.disarm('123', '0000');
        assert.deepEqual(seenBody, { PanelId: '123', PanelCode: '0000' });
    });

    it('arm omits PanelCode when no code is given', async function () {
        mockLogin();
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Arm',
            method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        await client.arm('123');
        assert.deepEqual(seenBody, { PanelId: '123' });
    });

    it('lock posts both LockSerial and SerialNo', async function () {
        mockLogin();
        let seenBody;
        pool.intercept({
            path: '/api/Panel/Lock',
            method: 'POST',
            body: (b) => { seenBody = JSON.parse(b); return true; }
        }).reply(200, {}, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        await client.lock('123', 'ABC123', '0000');
        assert.deepEqual(seenBody, {
            PanelId: '123', PanelCode: '0000', LockSerial: 'ABC123', SerialNo: 'ABC123'
        });
    });

    it('getLogs uses lowercase panelid and paging params', async function () {
        mockLogin();
        let seenPath;
        pool.intercept({
            path: (p) => { seenPath = p; return p.startsWith('/api/v2/panel/logs'); },
            method: 'GET'
        }).reply(200, { Records: [] }, { headers: { 'content-type': 'application/json' } });

        const client = new SectorClient(CREDS);
        await client.getLogs('123', { pageSize: 5 });
        assert.match(seenPath, /panelid=123/);
        assert.match(seenPath, /pageNumber=1/);
        assert.match(seenPath, /pageSize=5/);
    });

    it('throws ApiError with bad_request code on 400', async function () {
        mockLogin();
        pool.intercept({ path: (p) => p.startsWith('/api/Panel/GetPanel'), method: 'GET' })
            .reply(400, 'validation failed');

        const client = new SectorClient(CREDS);
        await assert.rejects(client.getPanel('123'), (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.code, 'bad_request');
            return true;
        });
    });
});

describe('normalizeStatus', function () {
    it('maps numeric Status to strings', function () {
        assert.equal(normalizeStatus({ Status: 1 }).status, 'disarmed');
        assert.equal(normalizeStatus({ Status: 2 }).status, 'partialArmed');
        assert.equal(normalizeStatus({ Status: 3 }).status, 'armed');
        assert.equal(normalizeStatus({ Status: 99 }).status, 'unknown');
        assert.equal(normalizeStatus(null).status, 'unknown');
    });

    it('carries isOnline and raw payload', function () {
        const raw = { Status: 3, IsOnline: false, StatusTime: '2026-06-12T10:00:00' };
        const n = normalizeStatus(raw);
        assert.equal(n.isOnline, false);
        assert.equal(n.statusTime, '2026-06-12T10:00:00');
        assert.equal(n.raw, raw);
    });
});
