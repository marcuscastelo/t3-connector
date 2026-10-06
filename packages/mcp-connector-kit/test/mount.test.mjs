import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthConnector, DEFAULTS, loadOAuthConfig } from '../oauth/index.mjs';
import { CLIENT, clientKeys, http, startConnector } from '../testing/index.mjs';
import { brand, publicHarness, surface, tools } from './surface.mjs';

const fleetBrand = { name: 'Fleet Connector', cookie: 'flc', passkeyUser: 'fleet-oauth' };
const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined)).toString();
const authorizeQuery = (resource, extra = {}) => form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'), code_challenge_method: 'S256', state: 's', resource, ...extra });

test('no mount: public surface identical to mcp-connector-kit 0.2.0', async () => {
  assert.deepEqual(await surface(), JSON.parse(readFileSync(new URL('./fixtures/surface-0.2.0.json', import.meta.url))));
});

test('loadOAuthConfig: issuer with a mount path', () => {
  const load = issuer => loadOAuthConfig({ X_ISSUER: issuer }, { prefix: 'X' });
  assert.deepEqual([load('https://t3-oauth.galm.ai/fleet').issuer, load('https://t3-oauth.galm.ai/fleet').mount], ['https://t3-oauth.galm.ai/fleet', '/fleet']);
  assert.equal(load('https://t3-oauth.galm.ai/fleet/').issuer, 'https://t3-oauth.galm.ai/fleet');
  assert.equal(load('https://host.example/a/b-2').mount, '/a/b-2');
  assert.deepEqual([load('https://host.example').mount, load('https://host.example/').issuer], ['', 'https://host.example']);
  for (const bad of ['https://host.example/Fleet', 'https://host.example/fleet?x=1', 'https://host.example/fleet#x', 'https://host.example/fleet?', 'https://u:p@host.example/fleet', 'https://host.example/fleet//', 'https://host.example/a%20b', 'https://host.example/-x', 'https://host.example/./fleet', `https://host.example/${'a'.repeat(33)}`]) {
    assert.throws(() => load(bad), /X_ISSUER must be an origin, optionally followed by a mount path/, bad);
  }
});

test('mount requires a brand cookie of its own (the transaction cookie is host-wide)', async () => {
  await assert.rejects(startConnector({ tools, mount: '/fleet' }), /mounted_issuer_requires_brand_cookie/);
});

for (const loginMode of ['button', '302', 'oob']) test(`mount /fleet (${loginMode}): discovery, PRMD, 401, sign-in, token, refresh and revoke under the path`, async (t) => {
  const c = await startConnector({ tools, brand: fleetBrand, loginMode, mount: '/fleet' });
  t.after(() => c.close());
  const origin = new URL(c.issuer).origin;
  assert.equal(c.issuer, `${origin}/fleet`);
  assert.equal(c.resource, `${origin}/fleet/mcp`);

  for (const p of ['/.well-known/oauth-authorization-server/fleet', '/.well-known/openid-configuration/fleet', '/fleet/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/fleet/mcp']) {
    const md = await http('GET', `${origin}${p}`);
    assert.equal(md.status, 200, p);
    assert.deepEqual([md.data.issuer, md.data.authorization_endpoint, md.data.token_endpoint, md.data.revocation_endpoint], [c.issuer, `${c.issuer}/authorize`, `${c.issuer}/token`, `${c.issuer}/revoke`]);
  }
  const prmd = await http('GET', `${origin}/.well-known/oauth-protected-resource/fleet/mcp`);
  assert.deepEqual([prmd.status, prmd.data.resource, prmd.data.authorization_servers], [200, c.resource, [c.issuer]]);
  // The host's root routes are not this connector's.
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/authorize/status', '/resume', '/mcp', '/fleetx/authorize', '/fleet']) {
    assert.equal((await http('GET', `${origin}${p}`)).status, 404, p);
  }
  for (const p of ['/token', '/revoke', '/mcp']) assert.equal((await http('POST', `${origin}${p}`, { body: '' })).status, 404, p);

  const unauthorized = await c.mcp(null, 'tools/list');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers['www-authenticate'], new RegExp(`resource_metadata="${origin}/.well-known/oauth-protected-resource/fleet/mcp"`));

  const s = await c.signIn();
  if (loginMode !== '302') {
    assert.match(s.auth.text, /fetch\('\/fleet\/authorize\/status\?tx='/);
    assert.match(s.auth.text, /location\.replace\('\/fleet\/resume\?tx='/);
  }
  assert.match(s.cookie, /^flc_tx=/);
  assert.equal(s.cb.searchParams.get('iss'), c.issuer);
  assert.equal(s.tokenResponse.status, 200, s.tokenResponse.text);
  assert.deepEqual((await c.mcp(s.tokens.access_token, 'tools/list')).data.result.tools.map(x => x.name).sort(), ['demo_read', 'demo_write']);

  const refreshed = await c.refresh(s.tokens.refresh_token);
  assert.equal(refreshed.status, 200, refreshed.text);
  const now = Math.floor(Date.now() / 1000);
  const revoke = await http('POST', `${c.issuer}/revoke`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: c.keys.assertion({ aud: `${c.issuer}/revoke`, iat: now, exp: now + 60 }), token: refreshed.data.refresh_token }) });
  assert.equal(revoke.status, 200, revoke.text);
  assert.equal((await c.mcp(refreshed.data.access_token, 'tools/list')).status, 401);
});

test('mount /fleet (public): bare WebAuthn origin, enrollment link and login routes under the path', async (t) => {
  const h = await publicHarness({ issuer: 'https://issuer.example.test/fleet', connectorBrand: fleetBrand });
  t.after(() => h.close());
  assert.equal(h.origin, 'https://issuer.example.test');
  assert.equal(h.c.publicPasskeys.origin, 'https://issuer.example.test');
  assert.equal(h.c.publicEnrollment.origin, 'https://issuer.example.test');
  assert.equal((await h.request('/fleet/authorize/vendor/swa.js')).status, 200);
  assert.equal((await h.request('/authorize/vendor/swa.js')).status, 404);

  const flow = await h.begin();
  assert.equal(flow.page.status, 200);
  assert.match(flow.page.headers['set-cookie'][0], /^__Host-flc_tx=.*; Secure; SameSite=Lax; Path=\//);
  for (const p of ['src="/fleet/authorize/vendor/swa.js"', "api('/fleet/authorize/passkey/options'", "api('/fleet/authorize/passkey/verify'", "api('/fleet/authorize/consent'"]) assert.ok(flow.page.text.includes(p), p);
  assert.doesNotMatch(flow.page.text, /'\/authorize\//);
  // Root-path login routes are not served; the Origin header never carries the mount.
  assert.equal((await h.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie)).status, 404);
  assert.equal((await h.post('/fleet/authorize/passkey/options', { tx: flow.tx }, flow.cookie, { origin: h.issuer })).status, 403);

  await h.enrollLocal();
  const e = await h.enrollPublic();
  assert.match(e.link, /^https:\/\/issuer\.example\.test\/fleet\/enroll#ticket=[A-Za-z0-9_-]{22}$/);
  assert.equal(e.page.status, 200);
  for (const p of ['src="/fleet/authorize/vendor/swa.js"', "api('/fleet/enroll/options'", "api('/fleet/enroll/verify'"]) assert.ok(e.page.text.includes(p), p);
  assert.match(e.page.headers['set-cookie'][0], /^__Host-flc_enroll=/);
  assert.equal(e.verify.status, 200, e.verify.text);
  assert.equal(h.c.publicPasskeys.credentials.size, 1);

  const s = await h.publicSignIn();
  assert.equal(s.verify.status, 200, s.verify.text);
  assert.equal(s.consent.data.resume.startsWith('https://issuer.example.test/fleet/resume?h='), true);
  assert.equal(s.token.status, 200, s.token.text);
  const sid = h.c.tokens.resolveAccess(s.token.data.access_token).sid;
  assert.deepEqual([h.c.authority.check(sid).credentialOrigin, h.c.authority.check(sid).resource], ['https://issuer.example.test', 'https://issuer.example.test/fleet/mcp']);
  assert.equal((await h.mcp(s.token.data.access_token)).status, 200);
});

test('mount /fleet (public): a WebAuthn assertion for a path-bearing origin is refused', async (t) => {
  const h = await publicHarness({ issuer: 'https://issuer.example.test/fleet', connectorBrand: fleetBrand });
  t.after(() => h.close());
  await h.enrollLocal(); assert.equal((await h.enrollPublic()).verify.status, 200);
  const flow = await h.begin(), o = await h.post('/fleet/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const v = await h.post('/fleet/authorize/passkey/verify', { tx: flow.tx, response: h.publicAuth.assertion(o.data.challenge, { origin: h.issuer }) }, flow.cookie);
  assert.equal(v.status, 400);
});

// Two connectors on one host behind an ingress that routes by the raw request-target with the
// documented rule: the root one (no mount) and one mounted at /fleet, with one client (same
// client_id, CIMD document and key) registered at both. `x-route` addresses one connector directly,
// past the rule.
const INGRESS = /^\/(fleet|\.well-known\/(oauth-authorization-server|openid-configuration|oauth-protected-resource)\/fleet)(\/.*)?$/;
async function twoConnectors(t) {
  let root, fleet;
  const proxy = createServer((req, res) => {
    const target = req.headers['x-route'] ?? (INGRESS.test(req.url.split('?')[0]) ? 'fleet' : 'root');
    (target === 'fleet' ? fleet : root).connector.publicHandler(req, res);
  });
  const port = await new Promise(ok => proxy.listen(0, '127.0.0.1', () => ok(proxy.address().port)));
  t.after(() => new Promise(r => proxy.close(r)));
  const host = `http://localhost:${port}`, keys = clientKeys();
  root = await startConnector({ tools, brand, keys, config: { issuer: host } });
  fleet = await startConnector({ tools, brand: fleetBrand, keys, config: { issuer: `${host}/fleet` } });
  t.after(() => Promise.all([root.close(), fleet.close()]));
  return { root, fleet, host, port };
}

// HTTP request with the request-target sent byte for byte (fetch and testing's http normalize it).
const raw = (port, target, { method = 'GET', host } = {}) => new Promise((ok, ko) => {
  const req = request({ host: '127.0.0.1', port, method, path: target, headers: { host } }, res => {
    res.resume(); res.on('end', () => ok({ status: res.statusCode, cookie: res.headers['set-cookie'] }));
  });
  req.on('error', ko); req.end();
});

test('two connectors on one host (root and /fleet): tokens, resources, cookies and paths do not cross', async (t) => {
  const { root, fleet, host } = await twoConnectors(t);
  const a = await root.signIn(), b = await fleet.signIn();
  assert.equal(a.tokenResponse.status, 200, a.tokenResponse.text);
  assert.equal(b.tokenResponse.status, 200, b.tokenResponse.text);
  assert.equal((await root.mcp(a.tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await fleet.mcp(b.tokens.access_token, 'tools/list')).status, 200);

  // Token of one -> invalid_token at the other, both ways; refresh too.
  for (const [c, at] of [[fleet, a.tokens.access_token], [root, b.tokens.access_token]]) {
    const r = await c.mcp(at, 'tools/list');
    assert.equal(r.status, 401); assert.match(r.headers['www-authenticate'], /error="invalid_token"/);
  }
  assert.equal((await fleet.refresh(a.tokens.refresh_token)).status, 400);
  assert.equal((await root.refresh(b.tokens.refresh_token)).status, 400);

  // /authorize of one with the other's resource -> invalid_target.
  for (const [c, resource] of [[fleet, root.resource], [root, fleet.resource]]) {
    const r = await http('GET', `${c.issuer}/authorize?${authorizeQuery(resource)}`);
    assert.equal(r.status, 302); assert.equal(new URL(r.headers.location).searchParams.get('error'), 'invalid_target');
  }

  // The transaction cookie of one is ignored by the other: a fleet sign-in approved on its local
  // control plane cannot be resumed with the root connector's cookie.
  const rootAuth = await http('GET', `${root.issuer}/authorize?${authorizeQuery(root.resource)}`);
  const rootCookie = rootAuth.headers['set-cookie'][0].split(';')[0];
  const fleetAuth = await http('GET', `${fleet.issuer}/authorize?${authorizeQuery(fleet.resource)}`);
  assert.notEqual(rootCookie.split('=')[0], fleetAuth.headers['set-cookie'][0].split('=')[0]);
  const handoff = new URL(/href="([^"]+#handoff=[^"]+)"/.exec(fleetAuth.text)[1]).hash.slice('#handoff='.length);
  const opts = await fleet.localPost('/api/login/options', { handoff });
  const verify = await fleet.localPost('/api/login/verify', { handoff, response: fleet.passkey.assertion(opts.data.challenge, { origin: fleet.local, counter: fleet.nextCounter() }) });
  assert.equal(verify.status, 200, verify.text);
  const resumed = await http('GET', verify.data.resume, { headers: { cookie: rootCookie } });
  assert.equal(resumed.status, 400);

  // Each connector answers 404 on the other's paths, even when an ingress rule sends them there.
  const rootPaths = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/resume', '/mcp'];
  const fleetPaths = ['/.well-known/oauth-authorization-server/fleet', '/.well-known/openid-configuration/fleet', '/fleet/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/fleet/mcp', '/.well-known/oauth-protected-resource/fleet/mcp', '/fleet/authorize', '/fleet/resume', '/fleet/mcp'];
  for (const p of rootPaths) assert.equal((await http('GET', `${host}${p}`, { headers: { 'x-route': 'fleet' } })).status, 404, `fleet served ${p}`);
  for (const p of fleetPaths) assert.equal((await http('GET', `${host}${p}`, { headers: { 'x-route': 'root' } })).status, 404, `root served ${p}`);
  for (const p of ['/token', '/revoke']) assert.equal((await http('POST', `${host}${p}`, { headers: { 'x-route': 'fleet' }, body: '' })).status, 404);
  for (const p of ['/fleet/token', '/fleet/revoke']) assert.equal((await http('POST', `${host}${p}`, { headers: { 'x-route': 'root' }, body: '' })).status, 404);
});

test('two connectors, one client key: an assertion is accepted only where every audience is the server\'s own', async (t) => {
  const { root, fleet } = await twoConnectors(t);
  // Client authentication through /revoke with an unknown token: 200 (RFC 7009) only when the
  // assertion authenticated the client.
  const revoke = (c, assertion) => http('POST', `${c.issuer}/revoke`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, token: 'unknown' }) });
  const outcome = r => (r.status === 200 ? 'ok' : `${r.status} ${r.data.error} ${r.data.error_description}`);
  const refused = '401 invalid_client assertion_audience_invalid';
  const R = root.issuer, F = fleet.issuer;

  // Mixed audiences naming both issuers: refused by both, at revoke and at token.
  for (const aud of [[`${R}/token`, `${F}/token`], [R, F], [`${R}/revoke`, `${F}/revoke`], [`${F}/token`, `${R}/token`, R], ['https://elsewhere.example/token', `${R}/token`, `${F}/token`]]) {
    const assertion = root.assertion({ aud });
    assert.equal(outcome(await revoke(root, assertion)), refused, `root revoke ${aud}`);
    assert.equal(outcome(await revoke(fleet, assertion)), refused, `fleet revoke ${aud}`);
  }
  const a = await root.signIn(), b = await fleet.signIn();
  const mixed = root.assertion({ aud: [`${R}/token`, `${F}/token`] });
  assert.equal(outcome(await root.token({ grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token }, { assertion: mixed })), refused);
  assert.equal(outcome(await fleet.token({ grant_type: 'refresh_token', refresh_token: b.tokens.refresh_token }, { assertion: mixed })), refused);

  // One server's audiences (string or array) work there and only there, whatever the key.
  for (const [own, other] of [[root, fleet], [fleet, root]]) {
    for (const aud of [`${own.issuer}/token`, own.issuer, `${own.issuer}/revoke`, [`${own.issuer}/token`, own.issuer], [`${own.issuer}/revoke`, `${own.issuer}/token`, own.issuer]]) {
      assert.equal(outcome(await revoke(own, own.assertion({ aud }))), 'ok', `${own.issuer} refused its own aud ${aud}`);
      assert.equal(outcome(await revoke(other, own.assertion({ aud }))), refused, `${other.issuer} accepted aud ${aud}`);
    }
    for (const aud of [`${own.issuer}/token`, [`${own.issuer}/token`, own.issuer]]) {
      assert.equal(outcome(await other.token({ grant_type: 'refresh_token', refresh_token: (other === root ? a : b).tokens.refresh_token }, { assertion: own.assertion({ aud }) })), refused);
    }
    // Replay: once per server, and the other refuses it for its audience, not as a replay.
    const once = own.assertion({ aud: `${own.issuer}/token` });
    assert.equal(outcome(await revoke(own, once)), 'ok');
    assert.equal(outcome(await revoke(own, once)), '401 invalid_client assertion_replayed');
    assert.equal(outcome(await revoke(other, once)), refused);
  }
  // The refresh tokens refused above are still valid with the right audience: the refusals came
  // from client authentication.
  assert.equal((await root.refresh(a.tokens.refresh_token)).status, 200);
  assert.equal((await fleet.token({ grant_type: 'refresh_token', refresh_token: b.tokens.refresh_token, resource: fleet.resource }, { assertion: fleet.assertion({ aud: [`${F}/token`, F] }) })).status, 200);
  assert.equal(outcome(await root.token({ grant_type: 'refresh_token', refresh_token: 'x' }, { assertion: root.assertion({ aud: [] }) })), refused);
});

test('two connectors behind the ingress rule: raw request-targets never reach the other connector', async (t) => {
  const { port } = await twoConnectors(t);
  const host = `localhost:${port}`;
  // target -> [owner by the ingress rule, expected status]; 404s must not set a cookie.
  const cases = [
    ['/fleet/../authorize', 404], ['/fleet/%2e%2e/authorize', 404], ['/fleet/./authorize', 404], ['/fleet/%2e/authorize', 404],
    ['/fleet\\authorize', 404], ['/x/../fleet/authorize', 404], ['/x/%2e%2e/fleet/authorize', 404], ['//evil.example/fleet/authorize', 404],
    ['/fleet/../.well-known/oauth-authorization-server', 404], ['/.well-known/oauth-authorization-server/x/../fleet', 404],
    ['/.well-known/oauth-authorization-server/fleet/../../oauth-authorization-server', 404], ['/outside/../fleet/.well-known/openid-configuration', 404],
    ['/fleet/../.well-known/oauth-protected-resource', 404], ['/.well-known/oauth-protected-resource/x/../fleet/mcp', 404],
    ['/fleet/authorize', 400], ['/authorize', 400], ['/.well-known/oauth-authorization-server/fleet', 200], ['/.well-known/oauth-authorization-server', 200],
  ];
  for (const [target, status] of cases) {
    const r = await raw(port, target, { host });
    assert.equal(r.status, status, target);
    if (status === 404) assert.equal(r.cookie, undefined, target);
  }
  for (const [target, status] of [['/fleet/../mcp', 404], ['/x/../fleet/mcp', 404], ['/fleet/mcp', 401], ['/mcp', 401]]) assert.equal((await raw(port, target, { method: 'POST', host })).status, status, target);
});

test('mount /fleet: only canonical origin-form request-targets are routed', async (t) => {
  const h = await publicHarness({ issuer: 'https://issuer.example.test/fleet', connectorBrand: fleetBrand });
  t.after(() => h.close());
  h.c.publicEnrollment.issue(); // /fleet/enroll answers only while an enrollment is open
  const get = (target, method) => raw(h.publicPort, target, { method, host: 'issuer.example.test' });
  for (const target of [
    '/.well-known/oauth-authorization-server/outside/../fleet', '/.well-known/openid-configuration/outside/../fleet', '/outside/../fleet/.well-known/openid-configuration',
    '/outside/../fleet/enroll', '/outside/%2e%2e/fleet/enroll', '/fleet/./enroll', '/fleet/./.well-known/openid-configuration', '/fleet/%2e/enroll', '/fleet/%2E/enroll',
    '/fleet/%2e%2e/fleet/enroll', '/fleet/enroll/.', '/fleet/enroll/..', '//evil.example/fleet/enroll', '//evil.example/fleet/.well-known/openid-configuration', '//issuer.example.test/fleet/enroll',
    '/fleet\\enroll', '/fleet\\.well-known\\openid-configuration', '/fleet/../authorize', '/fleet/%2e%2e/authorize',
    'https://issuer.example.test/fleet/enroll', 'http://issuer.example.test/fleet/enroll', '*',
  ]) {
    const r = await get(target);
    assert.equal(r.status, 404, target); assert.equal(r.cookie, undefined, target);
  }
  assert.equal((await get('\\fleet/enroll')).status, 400); // refused by Node's HTTP parser, before any handler
  for (const target of ['/fleet/./token', '/fleet/%2e/revoke', '/outside/../fleet/mcp', '/fleet\\mcp']) assert.equal((await get(target, 'POST')).status, 404, target);
  // Canonical targets, including dot or encoded characters in the query, are routed as before.
  for (const [target, status] of [['/fleet/enroll', 200], ['/.well-known/oauth-authorization-server/fleet', 200], ['/.well-known/openid-configuration/fleet', 200],
    ['/fleet/.well-known/openid-configuration', 200], ['/.well-known/oauth-authorization-server/fleet/mcp', 200], ['/.well-known/oauth-protected-resource/fleet/mcp', 200],
    ['/fleet/authorize/vendor/swa.js', 200], ['/fleet/authorize?next=/../x&p=%2e%2e/..', 400], ['/fleet/authorize/status?tx=..', 403], ['/fleet/resume?tx=./', 400]]) {
    assert.equal((await get(target)).status, status, target);
  }
  assert.ok((await get('/fleet/enroll')).cookie[0].startsWith('__Host-flc_enroll='));
  assert.equal((await get('/fleet/mcp', 'POST')).status, 401);
  assert.equal((await get('/fleet/token', 'POST')).status, 400); // reached the token endpoint: form encoding required
});

test('createOAuthConnector refuses an issuer with an invalid mount', () => {
  assert.throws(() => createOAuthConnector({ config: { ...DEFAULTS, issuer: 'http://localhost:1/Fleet', loginMode: 'button', stateDir: '/nonexistent' }, tools, brand: fleetBrand }), /issuer_invalid/);
});
