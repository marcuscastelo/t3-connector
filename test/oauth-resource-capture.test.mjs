import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConnector, http, freePort } from './oauth-apoio.mjs';
import { CLIENT } from './oauth-fixtures.mjs';
import { parseResourceCapture, capturableResource, resourceCapture } from '../src/oauth/resource-capture.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';

const T = 'tunnel_abc123';
const base = { T3_CONNECTOR_OAUTH_ISSUER: 'https://as.example.com', T3_CONNECTOR_OAUTH_PUBLIC_PORT: '7454', T3_CONNECTOR_OAUTH_LOCAL_PORT: '7455' };

test('resource capture: opt-in settings go together, absolute path, tunnel ID match', () => {
  assert.equal(parseResourceCapture({}), null);
  assert.equal(loadOAuthConfig(base).resourceCapture, null);
  assert.deepEqual(parseResourceCapture({ T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE: '/x/f', T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH: T }), { file: '/x/f', match: T });
  assert.throws(() => parseResourceCapture({ T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE: '/x/f' }), /go together/);
  assert.throws(() => parseResourceCapture({ T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH: T }), /go together/);
  assert.throws(() => parseResourceCapture({ T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE: 'rel/f', T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH: T }), /absolute/);
  for (const bad of ['abc', 'tunnel_', 'tunnel_a b', '.*']) assert.throws(() => parseResourceCapture({ T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE: '/x/f', T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH: bad }), /tunnel ID/, bad);
});

test('resource capture: only canonical https URLs with the tunnel ID as a path segment qualify', () => {
  const ok = `https://edge.example.com/v1/mcp/${T}`;
  assert.equal(capturableResource(ok, T), ok);
  assert.equal(capturableResource(`https://edge.example.com:8443/${T}/mcp`, T), `https://edge.example.com:8443/${T}/mcp`);
  const longOk = 'https://edge.example.com/' + 'a'.repeat(512 - 'https://edge.example.com/'.length - T.length - 1) + '/' + T;
  assert.equal(longOk.length, 512); assert.equal(capturableResource(longOk, T), longOk);
  for (const v of [
    // query/fragment/credentials, plain or percent-encoded (review F1)
    `${ok}?state=s`, `${ok}?`, `${ok}#f`, `${ok}%3Fstate%3DSYNTHETIC_STATE`, `${ok}%23code%3DSYNTHETIC_CODE`, `${ok}%253Ftoken%253DX`, `${ok}%0A`,
    `https://u:p@edge.example.com/v1/mcp/${T}`, `https://@edge.example.com/v1/mcp/${T}`, `https://%75@edge.example.com/${T}`,
    // parser repair, unicode, IDN, case, controls (review F1/F2)
    `https:\\edge.example.com\\v1\\mcp\\${T}`, `https:/edge.example.com/${T}`, `https://é.example/${T}`, `https://edge.example.com/${T}/é`,
    `https://EDGE.example.com/v1/mcp/${T}`, `${ok}\u0000`, `${ok}\u007f`, `${ok} x`, `${ok}\t`,
    'https://edge.example.com/' + 'é'.repeat(180) + '/' + T, longOk + 'a',
    // tunnel ID not a whole path segment
    `https://${T}.example/anything`, `https://edge.example.com/prefix_${T}_suffix`, `https://edge.example.com/v1/mcp/other`,
    `https://edge.example.com/v1/../${T}`, `https://edge.example.com/./${T}`,
    `http://edge.example.com/v1/mcp/${T}`, 'not a url', 42, undefined,
  ]) assert.equal(capturableResource(v, T), null, String(v).slice(0, 90));
});

test('resource capture: writes one 0600 file atomically, refuses an unsafe directory, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3c-cap-')); chmodSync(dir, 0o700);
  const file = join(dir, 'resource.json');
  const cap = resourceCapture({ file, match: T }, { now: () => new Date('2026-10-04T22:30:00Z') });
  assert.equal(cap(`https://edge.example.com/v1/mcp/${T}?code=secret`), false);
  assert.equal(existsSync(file), false);
  assert.equal(cap(`https://edge.example.com/v1/mcp/${T}`), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { t: '2026-10-04T22:30:00.000Z', resource: `https://edge.example.com/v1/mcp/${T}` });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['resource.json']);
  chmodSync(dir, 0o755);
  assert.equal(cap(`https://edge.example.com/v1/mcp/${T}/x`), false);
  chmodSync(dir, 0o700);
  // Failed publication (destination is a directory): no capture and no leftover temporary file (review F3).
  const d2 = mkdtempSync(join(tmpdir(), 't3c-cap-')); chmodSync(d2, 0o700); mkdirSync(join(d2, 'resource.json'));
  const cap2 = resourceCapture({ file: join(d2, 'resource.json'), match: T });
  for (let i = 0; i < 3; i++) assert.equal(cap2(`https://edge.example.com/v1/mcp/${T}`), false);
  assert.deepEqual(readdirSync(d2), ['resource.json']);
  assert.equal(resourceCapture(null)(`https://edge.example.com/v1/mcp/${T}`), false);
});

test('resource capture: /authorize still refuses the unknown resource; only the qualifying value is written', async t => {
  const dir = mkdtempSync(join(tmpdir(), 't3c-cap-')); chmodSync(dir, 0o700);
  const file = join(dir, 'resource.json');
  const c = await startConnector({ config: { resource: `https://tunnel.example.com/v1/mcp/${T}-configured`, tunnelPort: await freePort(), resourceCapture: { file, match: T } } }); t.after(c.close);
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'st4te' });
  q.set('resource', `https://other.example/x?token=${T}`);
  let r = await http('GET', `${c.issuer}/authorize?${q}`);
  assert.equal(new URL(r.headers.location).searchParams.get('error'), 'invalid_target');
  assert.equal(existsSync(file), false);
  q.set('resource', `https://edge.example.com/v1/mcp/${T}`);
  r = await http('GET', `${c.issuer}/authorize?${q}`);
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.location).searchParams.get('error'), 'invalid_target');
  const saved = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(saved).resource, `https://edge.example.com/v1/mcp/${T}`);
  for (const leak of ['st4te', 'a'.repeat(43), 'client.example', 'token=']) assert.ok(!saved.includes(leak), leak);
  const events = readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'authorize_unknown_resource');
  assert.deepEqual(events.map(e => e.captured), [undefined, true]);
  assert.ok(events.every(e => /^[0-9a-f]{8}$/.test(e.requestedHash) && e.requested === undefined));
});
