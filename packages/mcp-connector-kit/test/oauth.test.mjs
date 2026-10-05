import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { jsonResult, strictRegistrar } from '../index.mjs';
import { createOAuthConnector, loadOAuthConfig, perRequestSource } from '../oauth/index.mjs';
import { http, startConnector } from '../testing/index.mjs';

// A connector with no T3 knowledge: one read tool and one write tool, behind the shared OAuth profile.
const notes = [];
const tools = () => ({ sources: [perRequestSource((server, principal) => {
  const register = strictRegistrar(server);
  register('demo_read', { description: 'read', annotations: { readOnlyHint: true }, shape: {} }, async () => jsonResult({ notes, sid: Boolean(principal.sid) }));
  register('demo_write', { description: 'write', annotations: { readOnlyHint: false }, shape: { text: z.string() } }, async ({ text }) => { notes.push(text); return jsonResult({ count: notes.length }); });
})] });
const brand = { name: 'Demo Connector', cookie: 'demo', passkeyUser: 'demo-oauth' };

test('full OAuth sign-in, scoped tools and refresh through the kit alone', async (t) => {
  const c = await startConnector({ create: createOAuthConnector, tools, brand });
  t.after(() => c.close());
  const prm = await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.data.resource_name, 'Demo Connector');
  assert.equal((await c.mcp(null, 'tools/list')).status, 401);

  const write = await c.signIn();
  assert.match(write.cookie, /^demo_tx=/);
  assert.match(write.auth.text, /Demo Connector sign-in/);
  const at = write.tokens.access_token;
  const listed = await c.mcp(at, 'tools/list');
  assert.deepEqual(listed.data.result.tools.map((x) => x.name).sort(), ['demo_read', 'demo_write']);
  assert.deepEqual((await c.callTool(at, 'demo_write', { text: 'hi' })).data.result.structuredContent, { count: 1 });
  assert.equal((await c.callTool(at, 'demo_write', { text: 'x', extra: 1 })).data.result.isError, true);

  const read = await c.signIn({ scope: 'connector:read' });
  const ro = read.tokens.access_token;
  assert.deepEqual((await c.callTool(ro, 'demo_read')).data.result.structuredContent.notes, ['hi']);
  assert.match((await c.callTool(ro, 'demo_write', { text: 'no' })).data.result.content[0].text, /insufficient_scope: connector:write/);

  const refreshed = await c.refresh(write.tokens.refresh_token);
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.access_token, at);
});

test('loadOAuthConfig: prefix, app state directory, defaults and connector options', () => {
  const cfg = loadOAuthConfig({ DEMO_OAUTH_ISSUER: 'https://demo.example', DEMO_OAUTH_FLAVOR: 'x', XDG_STATE_HOME: '/state' }, {
    prefix: 'DEMO_OAUTH', app: 'demo', defaults: { publicPort: 7500, localPort: 7501 },
    extend: (env, { prefix }) => ({ flavor: env[`${prefix}_FLAVOR`] }),
    validate: (c) => { if (c.flavor !== 'x') throw new Error('bad flavor'); },
  });
  assert.equal(cfg.issuer, 'https://demo.example');
  assert.equal(cfg.stateDir, '/state/demo/oauth');
  assert.deepEqual([cfg.publicPort, cfg.localPort, cfg.flavor], [7500, 7501, 'x']);
  assert.throws(() => loadOAuthConfig({}, { prefix: 'DEMO_OAUTH' }), /DEMO_OAUTH_ISSUER is required/);
  assert.throws(() => loadOAuthConfig({ DEMO_OAUTH_ISSUER: 'https://d.example', DEMO_OAUTH_FLAVOR: 'y' }, { prefix: 'DEMO_OAUTH', extend: (e) => ({ flavor: e.DEMO_OAUTH_FLAVOR }), validate: (c) => { if (c.flavor !== 'x') throw new Error('bad flavor'); } }), /bad flavor/);
});
