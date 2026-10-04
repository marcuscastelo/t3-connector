import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startConnector, http, freePort } from './oauth-apoio.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { CLIENT } from './oauth-fixtures.mjs';

// Tunnel mode: the public listener is the authorization server only; the MCP resource, whose
// canonical URL is named by the tunnel service, is served on a loopback listener for the tunnel
// client. Tokens are bound to that exact resource.
const RESOURCE = 'https://tunnel.example.com/v1/mcp/tunnel_abc123';
const tunnelConnector = async (config = {}) => startConnector({ config: { resource: RESOURCE, tunnelPort: await freePort(), ...config } });
const events = c => readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('config: tunnel mode needs an exact https resource with a path, together with the tunnel port', () => {
  const base = { T3_CONNECTOR_OAUTH_ISSUER: 'https://as.example.com', T3_CONNECTOR_OAUTH_PUBLIC_PORT: '7454', T3_CONNECTOR_OAUTH_LOCAL_PORT: '7455' };
  const cfg = loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_RESOURCE: RESOURCE, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7456' });
  assert.equal(cfg.resource, RESOURCE);
  assert.equal(cfg.tunnelPort, 7456);
  assert.equal(loadOAuthConfig(base).resource, null);
  assert.equal(loadOAuthConfig(base).tunnelPort, null);
  for (const bad of ['http://tunnel.example.com/v1/mcp/x', 'https://tunnel.example.com', 'https://tunnel.example.com/', 'https://tunnel.example.com/mcp?x=1', 'https://tunnel.example.com/mcp#f', 'https://u:p@tunnel.example.com/mcp', 'https://TUNNEL.example.com/mcp', 'https://tunnel.example.com/a/../mcp', 'not a url', 'https://tunnel.example.com:443/mcp', 'https://tunnel.example.com/v1/mcp/t?', 'https://tunnel.example.com/v1/mcp/t#', 'https://tunnel.example.com/v1/mcp/t?#']) {
    assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_RESOURCE: bad, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7456' }), /T3_CONNECTOR_OAUTH_RESOURCE/, bad);
  }
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_RESOURCE: RESOURCE }), /go together/);
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7456' }), /go together/);
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_RESOURCE: RESOURCE, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7454' }), /must differ/);
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_RESOURCE: RESOURCE, T3_CONNECTOR_OAUTH_TUNNEL_PORT: '7455' }), /must differ/);
});

test('tunnel mode: discovery on the tunnel listener names the configured resource and the public AS', async t => {
  const c = await tunnelConnector(); t.after(c.close);
  const r = await c.mcp(null, 'initialize', {});
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], /resource_metadata="https:\/\/tunnel\.example\.com\/\.well-known\/oauth-protected-resource\/v1\/mcp\/tunnel_abc123"/);
  const tunnelBase = c.mcpUrl.replace(/\/mcp$/, '');
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const prmd = await http('GET', `${tunnelBase}${path}`);
    assert.equal(prmd.status, 200, path);
    assert.equal(prmd.data.resource, RESOURCE);
    assert.deepEqual(prmd.data.authorization_servers, [c.issuer]);
  }
  // The AS is not on the tunnel listener, and the resource is not on the public listener.
  assert.equal((await http('GET', `${tunnelBase}/.well-known/oauth-authorization-server`)).status, 404);
  assert.equal((await http('GET', `${tunnelBase}/authorize`)).status, 404);
  assert.equal((await http('POST', `${c.issuer}/mcp`, { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`)).status, 404);
  const md = await http('GET', `${c.issuer}/.well-known/oauth-authorization-server`);
  assert.equal(md.data.issuer, c.issuer);
  assert.equal(md.data.authorization_endpoint, `${c.issuer}/authorize`);
});

test('tunnel mode: the tunnel listener accepts only its own loopback Host; the public listener only the issuer Host', async t => {
  const c = await tunnelConnector(); t.after(c.close);
  const port = new URL(c.mcpUrl).port;
  for (const host of [new URL(c.issuer).host, 'tunnel.example.com', `127.0.0.1:${Number(port) + 1}`, 'evil.example']) {
    const r = await http('GET', `${c.mcpUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp`, { host });
    assert.equal(r.status, 421, host);
  }
  assert.equal((await http('GET', `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, { host: `localhost:${port}` })).status, 200);
  assert.equal((await http('GET', `${c.issuer}/.well-known/oauth-authorization-server`, { host: `127.0.0.1:${port}` })).status, 421);
  assert.ok(events(c).some(e => e.event === 'tunnel_bad_host'));
});

test('tunnel mode: sign-in, tool call, refresh and audience binding with the tunnel resource', async t => {
  const c = await tunnelConnector(); t.after(c.close);
  const s = await c.signIn();
  assert.ok(s.tokens?.access_token, JSON.stringify(s.tokenResponse?.data));
  assert.equal(s.cb.searchParams.get('iss'), c.issuer);
  const init = await c.mcp(s.tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.status, 200);
  const call = await c.callTool(s.tokens.access_token, 'rehearsal_echo', { text: 'hi' });
  assert.equal(call.status, 200);
  assert.ok(events(c).some(e => e.event === 'tool_call'));
  const r = await c.refresh(s.tokens.refresh_token);
  assert.equal(r.status, 200);
  assert.ok(r.data.access_token);
  // A refresh naming another resource is refused.
  const other = await c.refresh(r.data.refresh_token, { resource: `${c.issuer}/mcp` });
  assert.equal(other.status, 400);
  assert.equal(other.data.error, 'invalid_target');
});

for (const mode of ['tunnel', 'default']) {
  test(`${mode} mode: /authorize refuses an unknown resource and logs only its hash, even a secret in a valid https path`, async t => {
    const c = mode === 'tunnel' ? await tunnelConnector() : await startConnector(); t.after(c.close);
    const s = await c.signIn();
    const secret = s.tokens.refresh_token;
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 's' });
    for (const resource of [`https://other.example/${secret}`, `https://${secret.toLowerCase().replace(/[^a-z0-9]/g, '')}.example/mcp`, mode === 'tunnel' ? `${c.issuer}/mcp` : RESOURCE]) {
      q.set('resource', resource);
      const auth = await http('GET', `${c.issuer}/authorize?${q}`);
      assert.equal(auth.status, 302);
      assert.equal(new URL(auth.headers.location).searchParams.get('error'), 'invalid_target');
    }
    const unknown = events(c).filter(e => e.event === 'authorize_unknown_resource');
    assert.equal(unknown.length, 3);
    assert.ok(unknown.every(e => /^[0-9a-f]{8}$/.test(e.requestedHash) && e.requested === undefined));
    const log = readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8');
    assert.ok(!log.includes(secret) && !log.includes(secret.toLowerCase().replace(/[^a-z0-9]/g, '')));
  });
}

test('tunnel mode: code exchange naming another resource is refused; a token for another resource is wrong_audience', async t => {
  const c = await tunnelConnector(); t.after(c.close);
  const s = await c.signIn();
  assert.ok(s.tokens?.access_token);
  // A sign-in whose code is exchanged naming the public-issuer resource is refused.
  const other = await c.signIn({ tokenResource: `${c.issuer}/mcp` });
  assert.equal(other.tokenResponse.status, 400);
  assert.equal(other.tokenResponse.data.error, 'invalid_target');
  const d = await startConnector({ config: { resource: 'https://tunnel.example.com/v1/mcp/tunnel_other', tunnelPort: await freePort() } }); t.after(d.close);
  const foreign = await d.signIn();
  const r = await c.mcp(foreign.tokens.access_token, 'initialize', {});
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], /error="invalid_token"/);
});

test('tunnel mode: after a restart with another resource, old tokens are refused and a new sign-in works', async t => {
  const tunnelPort = await freePort();
  const c = await tunnelConnector({ tunnelPort });
  const s = await c.signIn();
  const stateDir = c.connector.stateDir;
  await c.close();
  const d = await startConnector({ config: { resource: 'https://tunnel.example.com/v1/mcp/tunnel_new', tunnelPort, stateDir }, enroll: false }); t.after(d.close);
  assert.equal((await d.mcp(s.tokens.access_token, 'initialize', {})).status, 401);
  const rt = await d.refresh(s.tokens.refresh_token);
  assert.equal(rt.status, 400);
  assert.equal(rt.data.error, 'invalid_grant');
});
