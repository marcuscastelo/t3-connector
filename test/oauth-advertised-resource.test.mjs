import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startConnector, http, freePort } from './oauth-apoio.mjs';
import { CLIENT } from './oauth-fixtures.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';

// Tunnel mode with a locally advertised resource: the metadata names ADVERTISED (what tunnel-client
// can reach), while only ACCEPTED (the hosted tunnel's endpoint) is accepted for authorization,
// tokens and the resource server.
const ACCEPTED = 'https://tunnel-service.internal.example/v1/mcp/tunnel_abc123';
const ADVERTISED = 'https://public.example/v1/mcp/tunnel_abc123';
const base = { T3_CONNECTOR_OAUTH_ISSUER: 'https://as.example.com', T3_CONNECTOR_OAUTH_PUBLIC_PORT: '7454', T3_CONNECTOR_OAUTH_LOCAL_PORT: '7455' };

test('config: advertised resource requires tunnel mode and an exact https URL', () => {
  const tun = { ...base, T3_CONNECTOR_OAUTH_RESOURCE: ACCEPTED, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7456' };
  assert.equal(loadOAuthConfig(tun).advertisedResource, null);
  assert.equal(loadOAuthConfig({ ...tun, T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE: ADVERTISED }).advertisedResource, ADVERTISED);
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE: ADVERTISED }), /requires tunnel mode/);
  for (const bad of ['http://public.example/x', 'https://public.example', 'https://public.example/x?y', 'https://public.example/x#', 'https://PUBLIC.example/x'])
    assert.throws(() => loadOAuthConfig({ ...tun, T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE: bad }), /ADVERTISED_RESOURCE/, bad);
});

test('tunnel mode: metadata and challenge advertise the advertised resource; only the accepted one authorizes', async t => {
  const c = await startConnector({ config: { resource: ACCEPTED, advertisedResource: ADVERTISED, tunnelPort: await freePort() } }); t.after(c.close);
  const tb = c.mcpUrl.replace(/\/mcp$/, '');
  const prm = await http('GET', `${tb}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.data.resource, ADVERTISED);
  assert.deepEqual(prm.data.authorization_servers, [c.issuer]);
  const r401 = await c.mcp(null, 'initialize', {});
  assert.match(r401.headers['www-authenticate'], /resource_metadata="https:\/\/public\.example\/\.well-known\/oauth-protected-resource\/v1\/mcp\/tunnel_abc123"/);
  // The advertised value is not accepted at /authorize.
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 's', resource: ADVERTISED });
  const auth = await http('GET', `${c.issuer}/authorize?${q}`);
  assert.equal(new URL(auth.headers.location).searchParams.get('error'), 'invalid_target');
  // The accepted value signs in; a code exchange naming the advertised value is refused.
  const bad = await c.signIn({ tokenResource: ADVERTISED });
  assert.equal(bad.tokenResponse.status, 400);
  assert.equal(bad.tokenResponse.data.error, 'invalid_target');
  const s = await c.signIn();
  assert.ok(s.tokens?.access_token, JSON.stringify(s.tokenResponse?.data));
  const call = await c.callTool(s.tokens.access_token, 'rehearsal_echo', { text: 'ok' });
  assert.equal(call.status, 200);
  assert.equal(call.data.error, undefined);
  assert.deepEqual(call.data.result.content, [{ type: 'text', text: 'echo: ok' }]);
  const rt = await c.refresh(s.tokens.refresh_token, { resource: ADVERTISED });
  assert.equal(rt.status, 400);
  assert.equal(rt.data.error, 'invalid_target');
  const started = readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.event === 'started');
  assert.equal(started.resource, ACCEPTED);
});

test('default and plain tunnel mode are unchanged by the advertised setting', async t => {
  const c = await startConnector({ config: { resource: ACCEPTED, tunnelPort: await freePort() } }); t.after(c.close);
  const prm = await http('GET', `${c.mcpUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.data.resource, ACCEPTED);
});
