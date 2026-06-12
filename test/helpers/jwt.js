'use strict';

/** Build a structurally valid (unsigned) JWT whose exp is now + offsetSeconds. */
function makeFakeJwt(offsetSeconds = 3600) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + offsetSeconds,
        sub: 'test-user'
    })).toString('base64url');
    return `${header}.${payload}.sig`;
}

module.exports = { makeFakeJwt };
