import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthConnector, DEFAULTS, loadOAuthConfig } from '../oauth/index.mjs';
import { CLIENT, freePort, http, startConnector } from '../testing/index.mjs';
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

// Two connectors on one host behind an ingress that routes by path: the root one (no mount) and one
// mounted at /fleet. `x-route` lets a test address one connector directly, past the routing rule.
test('two connectors on one host (root and /fleet): tokens, assertions, resources, cookies and paths do not cross', async (t) => {
  let root, fleet;
  const toFleet = p => p.startsWith('/fleet/') || /^\/\.well-known\/[^/]+\/fleet(\/|$)/.test(p);
  const proxy = createServer((req, res) => {
    const target = req.headers['x-route'] ?? (toFleet(new URL(req.url, 'http://x').pathname) ? 'fleet' : 'root');
    (target === 'fleet' ? fleet : root).connector.publicHandler(req, res);
  });
  const port = await new Promise(ok => proxy.listen(0, '127.0.0.1', () => ok(proxy.address().port)));
  t.after(() => new Promise(r => proxy.close(r)));
  const host = `http://localhost:${port}`;
  root = await startConnector({ tools, brand, config: { issuer: host } });
  fleet = await startConnector({ tools, brand: fleetBrand, config: { issuer: `${host}/fleet` } });
  t.after(() => Promise.all([root.close(), fleet.close()]));

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

  // A client assertion whose audience is the other issuer (its token endpoint or the issuer itself).
  for (const [c, aud] of [[fleet, `${root.issuer}/token`], [fleet, root.issuer], [root, `${fleet.issuer}/token`], [root, fleet.issuer]]) {
    const r = await c.token({ grant_type: 'refresh_token', refresh_token: (c === fleet ? b : a).tokens.refresh_token }, { assertion: c.assertion({ aud }) });
    assert.equal(r.status, 401, `${c.issuer} accepted aud ${aud}`); assert.equal(r.data.error, 'invalid_client');
  }

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

test('createOAuthConnector refuses an issuer with an invalid mount', () => {
  assert.throws(() => createOAuthConnector({ config: { ...DEFAULTS, issuer: 'http://localhost:1/Fleet', loginMode: 'button', stateDir: '/nonexistent' }, tools, brand: fleetBrand }), /issuer_invalid/);
});
