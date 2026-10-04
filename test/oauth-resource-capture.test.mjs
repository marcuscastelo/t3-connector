import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync, chmodSync } from 'node:fs';
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

test('resource capture: only plain https URLs containing the tunnel ID qualify', () => {
  assert.equal(capturableResource(`https://edge.example.com/v1/mcp/${T}`, T), `https://edge.example.com/v1/mcp/${T}`);
  assert.equal(capturableResource(`https://EDGE.example.com/v1/mcp/${T}`, T), `https://edge.example.com/v1/mcp/${T}`);
  for (const v of [
    `http://edge.example.com/v1/mcp/${T}`, `https://edge.example.com/v1/mcp/${T}?state=s`, `https://edge.example.com/v1/mcp/${T}?`,
    `https://edge.example.com/v1/mcp/${T}#f`, `https://u:p@edge.example.com/v1/mcp/${T}`, `https://edge.example.com/v1/mcp/other`,
    `https://edge.example.com/v1/mcp/${T} x`, 'https://edge.example.com/' + 'a'.repeat(600) + T, 'not a url', 42, undefined,
  ]) assert.equal(capturableResource(v, T), null, String(v).slice(0, 80));
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
