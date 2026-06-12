'use strict';

const { SectorError, AuthError, ApiError, TimeoutError } = require('./errors');

const DEFAULT_BASE_URL = 'https://mypagesapi.sectoralarm.net';
const AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 5000;

/**
 * Map the numeric Status field of GetPanelStatus to a stable string.
 * Mapping taken from the Sector Alarm mobile API (same as the maintained
 * Home Assistant integration): 1=disarmed, 2=partialArmed, 3=armed.
 */
function normalizeStatus(raw) {
    const map = { 1: 'disarmed', 2: 'partialArmed', 3: 'armed' };
    return {
        status: map[raw && raw.Status] || 'unknown',
        isOnline: raw ? raw.IsOnline !== false : false,
        statusTime: (raw && (raw.StatusTime || raw.StatusTimeUtc)) || null,
        raw
    };
}

/** Decode the exp claim (seconds) from a JWT without verifying it. */
function parseJwtExp(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new ApiError('Login response did not contain a valid JWT');
    let payload;
    try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch (err) {
        throw new ApiError('Unable to decode JWT payload from login response', { cause: err });
    }
    if (typeof payload.exp !== 'number') throw new ApiError('JWT from login response has no exp claim');
    return payload.exp;
}

class SectorClient {
    #email;
    #password;
    #token = null;
    #expiresAt = 0;
    #loginPromise = null;
    #authFailedUntil = 0;
    #authFailedError = null;

    constructor({ email, password, baseUrl = DEFAULT_BASE_URL, timeoutMs = 15000, log = () => {} } = {}) {
        if (!email || !password) throw new SectorError('email and password are required', { code: 'config' });
        this.#email = email;
        this.#password = password;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.log = log;
    }

    invalidateToken() {
        this.#token = null;
        this.#expiresAt = 0;
        this.#authFailedUntil = 0;
        this.#authFailedError = null;
    }

    async #getToken() {
        if (this.#token && Date.now() < this.#expiresAt) return this.#token;
        if (Date.now() < this.#authFailedUntil) {
            throw this.#authFailedError ||
                new AuthError('Login previously failed; retry suppressed by cool-down');
        }
        if (!this.#loginPromise) {
            this.#loginPromise = this.#login().finally(() => { this.#loginPromise = null; });
        }
        return this.#loginPromise;
    }

    async #login() {
        this.log('logging in');
        let response;
        try {
            response = await fetch(`${this.baseUrl}/api/Login/Login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ UserId: this.#email, Password: this.#password }),
                signal: AbortSignal.timeout(this.timeoutMs)
            });
        } catch (err) {
            throw this.#wrapNetworkError(err, 'POST', '/api/Login/Login');
        }

        if (response.status === 200) {
            const data = await response.json();
            const token = data && data.AuthorizationToken;
            if (!token) throw new ApiError('Login succeeded but no AuthorizationToken in response');
            this.#expiresAt = parseJwtExp(token) * 1000 - TOKEN_EXPIRY_MARGIN_MS;
            this.#token = token;
            this.log(`logged in, token expires ${new Date(this.#expiresAt).toISOString()}`);
            return token;
        }

        const bodyText = await response.text().catch(() => '');
        if (response.status === 401) {
            // Wrong credentials: back off so a poller cannot hammer the login
            // endpoint and trigger an account lockout.
            const err = new AuthError('Login failed: incorrect username or password', { statusCode: 401 });
            this.#authFailedError = err;
            this.#authFailedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
            throw err;
        }
        if (response.status === 400) {
            throw new ApiError(`Login request rejected (HTTP 400) — the API contract may have changed: ${bodyText}`,
                { code: 'bad_request', statusCode: 400 });
        }
        throw new ApiError(`Login failed (HTTP ${response.status}): ${bodyText}`, { statusCode: response.status });
    }

    #wrapNetworkError(err, method, path) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            return new TimeoutError(`Timeout after ${this.timeoutMs}ms during ${method} ${path}`, { cause: err });
        }
        return new SectorError(`Network error during ${method} ${path}: ${err.message}`,
            { code: 'network', cause: err });
    }

    async #request(method, path, { query = null, body = undefined, reauth = true } = {}) {
        const token = await this.#getToken();
        let url = this.baseUrl + path;
        if (query) url += '?' + new URLSearchParams(query).toString();

        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(url, init);
        } catch (err) {
            throw this.#wrapNetworkError(err, method, path);
        }

        if (response.status === 200) {
            const contentType = response.headers.get('content-type') || '';
            return contentType.includes('application/json') ? response.json() : response.text();
        }
        if (response.status === 401 || response.status === 403) {
            this.#token = null;
            this.#expiresAt = 0;
            if (reauth) {
                this.log(`HTTP ${response.status} on ${path}, re-authenticating once`);
                return this.#request(method, path, { query, body, reauth: false });
            }
            throw new AuthError(`Authentication failure during ${method} ${path} (HTTP ${response.status})`,
                { statusCode: response.status });
        }
        const bodyText = await response.text().catch(() => '');
        if (response.status === 400) {
            throw new ApiError(`Bad request during ${method} ${path} — possibly broken API support: ${bodyText}`,
                { code: 'bad_request', statusCode: 400 });
        }
        throw new ApiError(`HTTP ${response.status} during ${method} ${path}: ${bodyText}`,
            { statusCode: response.status });
    }

    /** Retry transient failures (timeout/network/5xx) once; never retry auth or 4xx. */
    async #withRetry(fn, { attempts = 2, initialDelayMs = 1000, backoff = 2, maxDelayMs = 10000 } = {}) {
        let delay = initialDelayMs;
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const transient = err instanceof TimeoutError ||
                    (err instanceof SectorError && err.code === 'network') ||
                    (err instanceof ApiError && err.statusCode >= 500);
                if (!transient || attempt >= attempts) throw err;
                this.log(`transient error (${err.code}), retrying in ${delay}ms: ${err.message}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay = Math.min(delay * backoff, maxDelayMs);
            }
        }
    }

    // --- Reads ---

    getPanelList() {
        return this.#withRetry(() => this.#request('GET', '/api/account/GetPanelList'));
    }

    getPanel(panelId) {
        return this.#withRetry(() => this.#request('GET', '/api/Panel/GetPanel', { query: { panelId } }));
    }

    getPanelStatus(panelId) {
        return this.#withRetry(() => this.#request('GET', '/api/panel/GetPanelStatus', { query: { panelId } }));
    }

    getLogs(panelId, { pageNumber = 1, pageSize = 10 } = {}) {
        // NB: this endpoint expects lowercase "panelid".
        return this.#withRetry(() => this.#request('GET', '/api/v2/panel/logs', {
            query: { panelid: panelId, pageNumber, pageSize }
        }));
    }

    getLockStatus(panelId) {
        return this.#withRetry(() => this.#request('GET', '/api/panel/GetLockStatus', { query: { panelId } }));
    }

    getTemperatures(panelId) {
        return this.#withRetry(() => this.#request('GET', '/api/Panel/GetTemperatures', { query: { panelId } }));
    }

    // --- Actions (no automatic retry: arming/locking must not silently repeat) ---

    arm(panelId, code = null) {
        return this.#request('POST', '/api/Panel/Arm', {
            body: { PanelId: panelId, ...(code ? { PanelCode: code } : {}) }
        });
    }

    partialArm(panelId, code = null) {
        return this.#request('POST', '/api/Panel/PartialArm', {
            body: { PanelId: panelId, ...(code ? { PanelCode: code } : {}) }
        });
    }

    disarm(panelId, code) {
        if (!code) throw new SectorError('disarm requires a panel code', { code: 'config' });
        return this.#request('POST', '/api/Panel/Disarm', { body: { PanelId: panelId, PanelCode: code } });
    }

    lock(panelId, lockSerial, code) {
        if (!code) throw new SectorError('lock requires a panel code', { code: 'config' });
        return this.#request('POST', '/api/Panel/Lock', {
            body: { PanelId: panelId, PanelCode: code, LockSerial: lockSerial, SerialNo: lockSerial }
        });
    }

    unlock(panelId, lockSerial, code) {
        if (!code) throw new SectorError('unlock requires a panel code', { code: 'config' });
        return this.#request('POST', '/api/Panel/Unlock', {
            body: { PanelId: panelId, PanelCode: code, LockSerial: lockSerial, SerialNo: lockSerial }
        });
    }
}

module.exports = { SectorClient, normalizeStatus, parseJwtExp, DEFAULT_BASE_URL };
