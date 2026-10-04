import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, constants, randomUUID } from 'node:crypto';

// Fake OAuth client for tests: a CIMD document served through an injected fetch and private_key_jwt
// assertions signed with a generated key.
export const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
export const CLIENT = 'https://client.example/oauth/client.json';

export function clientKeys(kind = 'ES256', kid = 'k1') {
  const pair = kind === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: kind };
  const assertion = (claims = {}, header = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const h = { alg: kind, kid, typ: 'JWT', ...header };
    const c = { iss: CLIENT, sub: CLIENT, aud: 'https://as.example/token', iat: now, exp: now + 60, jti: randomUUID(), ...claims };
    const input = `${b64(h)}.${b64(c)}`;
    const opts = kind === 'ES256' ? { key: pair.privateKey, dsaEncoding: 'ieee-p1363' } : kind === 'PS256' ? { key: pair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : pair.privateKey;
    return `${input}.${sign('sha256', Buffer.from(input), opts).toString('base64url')}`;
  };
  return { jwk, assertion };
}

export function cimdFetch(docs) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    const body = typeof docs === 'function' ? docs(url) : docs[url];
    if (!body) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  f.calls = calls;
  return f;
}

