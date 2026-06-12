'use strict';

/**
 * Error hierarchy for the Sector Alarm client.
 * Every error carries a stable `code` string that flows can branch on
 * (available via Catch node as `error.source` + attached msg.error).
 */

class SectorError extends Error {
    constructor(message, { code = 'sector_error', statusCode = null, cause = null } = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        if (cause) this.cause = cause;
    }
}

class AuthError extends SectorError {
    constructor(message, opts = {}) {
        super(message, { code: 'auth_failed', ...opts });
    }
}

class ApiError extends SectorError {
    constructor(message, opts = {}) {
        super(message, { code: opts.code || 'api_error', ...opts });
    }
}

class TimeoutError extends SectorError {
    constructor(message, opts = {}) {
        super(message, { code: 'timeout', ...opts });
    }
}

module.exports = { SectorError, AuthError, ApiError, TimeoutError };
