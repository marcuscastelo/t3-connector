import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createOAuthConnector } from '../src/oauth/connector.mjs';
import { DEFAULTS } from '../src/oauth/config.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { consentAll } from '../src/oauth/project-policy.mjs';
import { perRequestSource } from '../src/oauth/resource-server.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';
import { freePort, http } from './oauth-apoio.mjs';
import { authenticator, memoryJournal } from './escrita-fixtures.mjs';
import { clientKeys, cimdFetch, CLIENT } from './oauth-fixtures.mjs';
import { ambientesFalsos, dadosPadrao } from './apoio.mjs';
import { thread, projecao, mensagem } from './fixtures.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';

// HTTP loopback models the ingress transport; the configured browser origin/RP remains exact
// HTTPS. No TLS exception is added to production code, and no real browser or backend is used.
export async function publicFixture(t, { config = {}, tools, fetch, limits, enroll = true, backend = false, stateDir } = {}) {
  const [publicPort, localPort] = [await freePort(), await freePort()];
  let mono = 0, wallMs = Date.now(), localCounter = 1, publicCounter = 1;
  const clock = () => mono, wall = () => wallMs;
  const state = stateDir ?? mkdtempSync(join(tmpdir(), 't3c-public-'));
  const keys = clientKeys(), cfg = { ...DEFAULTS, issuer: 'https://issuer.example.test', publicPort, localPort, stateDir: state, clients: [CLIENT], loginMode: 'public', ...config };
  const issuer = cfg.issuer, local = `http://localhost:${localPort}`;
  const doc = { client_id: CLIENT, client_name: '<img src=x onerror=alert(1)>', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [keys.jwk] } };
  const localAuth = authenticator({ rpID: 'localhost' }), publicAuth = authenticator({ rpID: new URL(issuer).hostname });
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit() {} };
  const connections = reads.registros.map(r => {
    const calls = [], d = data[r.alias];
    return { calls, registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS }, inventario: async () => d.shell.projects.map(p => ({ id: p.id, name: p.title, directory: p.workspaceRoot })), cliente: async () => ({ shell: async () => structuredClone(d.shell) }), adapter: { prepare: async () => {}, projectForThread: async id => d.shell.threads.find(t => t.id === id)?.projectId, invoke: async (method, payload) => { calls.push({ method, payload }); return { sequence: 1 }; }, receipt: r => r, reconcile: async r => ({ found: !!r.receipt }) }, fechar() {} };
  });
  const factory = tools ?? (backend ? t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all' }) : () => ({ sources: [perRequestSource(rehearsalTools())], grantProvider: Object.assign(async () => ({ grants: consentAll(reads.registros), unavailable: [] }), { projectPolicy: 'all' }) }));
  let c;
  const open = async () => {
    c = createOAuthConnector({ config: cfg, tools: factory, fetch: fetch ?? cimdFetch({ [CLIENT]: doc }), publicLimits: limits, clock, wall }); await c.listen(); return c;
  };
  await open(); t.after(async () => { await c.close(); rmSync(state, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', headers = {}, body, data } = {}) => http(method, `http://localhost:${publicPort}${path}`, { host: new URL(issuer).host, headers: Object.fromEntries(Object.entries({ connection: 'close', ...headers }).filter(([, v]) => v !== undefined)), body: data === undefined ? body : JSON.stringify(data), timeoutMs: 15_000 });
  const post = (path, data, cookie, headers = {}) => request(path, { method: 'POST', data, headers: { origin: issuer, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers } });
  const localPost = (path, data, headers = {}) => http('POST', `${local}${path}`, { headers: { connection: 'close', origin: local, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const cookieOf = r => r.headers['set-cookie']?.[0]?.split(';')[0];
  if (enroll) {
    const ticket = c.enrollment.issue(), options = await localPost('/api/enroll/options', { ticket });
    assert.equal(options.status, 200);
    assert.equal((await localPost('/api/enroll/verify', { ticket, response: localAuth.registration(options.data.challenge, { origin: local }) })).status, 200);
  }
  const admin = async (action, fields = {}) => {
    const o = await localPost('/api/credentials/options', { action, ...fields }); assert.equal(o.status, 200, o.text);
    return localPost('/api/credentials/verify', { handle: o.data.handle, response: localAuth.assertion(o.data.options.challenge, { origin: local, counter: localCounter++ }) });
  };
  const beginEnrollment = async () => {
    const issued = await admin('enroll-public'); assert.equal(issued.status, 200, issued.text);
    const ticket = new URL(issued.data.link).hash.slice('#ticket='.length), page = await request('/enroll');
    return { ticket, cookie: cookieOf(page), page, issued };
  };
  const enrollPublic = async (auth = publicAuth) => {
    const e = await beginEnrollment(), o = await post('/enroll/options', { ticket: e.ticket }, e.cookie); assert.equal(o.status, 200, o.text);
    const result = await post('/enroll/verify', { ticket: e.ticket, response: auth.registration(o.data.challenge, { origin: issuer }) }, e.cookie);
    assert.equal(result.status, 200, result.text); return { ...e, options: o, result };
  };
  const begin = async ({ scope = 'connector:read connector:write', headers = {}, resource = c.resource } = {}) => {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(12).toString('hex');
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: doc.redirect_uris[0], code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource, scope, state });
    const page = await request(`/authorize?${q}`, { headers });
    return { page, cookie: cookieOf(page), tx: /const tx="([^"]+)"/.exec(page.text)?.[1], verifier, state, scope };
  };
  const authenticate = async (flow, auth = publicAuth, extra = {}) => {
    const options = await post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie); assert.equal(options.status, 200, options.text);
    const verify = await post('/authorize/passkey/verify', { tx: flow.tx, response: auth.assertion(options.data.challenge, { origin: issuer, counter: publicCounter++, ...extra }) }, flow.cookie);
    return { options, verify };
  };
  const token = params => {
    const now = Math.floor(wallMs / 1000);
    return request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: keys.assertion({ aud: `${issuer}/token`, iat: now, exp: now + 60 }), ...params }).toString() });
  };
  const resume = async (flow, url) => {
    const r = await request(new URL(url).pathname + new URL(url).search, { headers: { cookie: flow.cookie } });
    const callback = r.headers.location && new URL(r.headers.location);
    if (!callback?.searchParams.get('code')) return { response: r, callback };
    const tok = await token({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: flow.verifier, redirect_uri: doc.redirect_uris[0], resource: c.resource });
    return { response: r, callback, token: tok };
  };
  const approve = async flow => {
    const consent = await post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie); assert.equal(consent.status, 200, consent.text);
    return { consent, ...await resume(flow, consent.data.resume) };
  };
  const signIn = async options => { const flow = await begin(options), uv = await authenticate(flow); assert.equal(uv.verify.status, 200, uv.verify.text); return { flow, uv, ...await approve(flow) }; };
  const localSignIn = async () => {
    const flow = await begin(), handoff = /#handoff=([A-Za-z0-9_-]+)/.exec(flow.page.text)?.[1];
    assert.ok(handoff);
    await localPost('/api/login/view', { handoff });
    const o = await localPost('/api/login/options', { handoff }); assert.equal(o.status, 200, o.text);
    const v = await localPost('/api/login/verify', { handoff, response: localAuth.assertion(o.data.challenge, { origin: local, counter: localCounter++ }) }); assert.equal(v.status, 200, v.text);
    return { flow, ...await resume(flow, v.data.resume) };
  };
  const mcp = (access, method, params) => request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } });
  const call = (access, name, args) => mcp(access, 'tools/call', { name, arguments: args });
  const addProject = alias => { const id = `late-${alias}`, d = data[alias]; d.shell.projects.push({ id, title: id, workspaceRoot: `/${alias}/late` }); d.shell.threads.push(thread({ id: `t-${id}`, projectId: id, title: id, latestRunId: null })); d.bounded[`t-${id}`] = { projection: projecao({ mensagens: [mensagem({ text: `message-${id}` })] }), hasMoreHistory: false }; return id; };
  return { get c() { return c; }, cfg, issuer, local, state, localAuth, publicAuth, request, post, localPost, cookieOf, admin, beginEnrollment, enrollPublic, begin, authenticate, approve, resume, signIn, localSignIn, token, mcp, call, addProject, connections, data, journal,
    advance(ms) { mono += ms; wallMs += ms; }, localAssertion(challenge) { return localAuth.assertion(challenge, { origin: local, counter: localCounter++ }); },
    publicAssertion(challenge, extra = {}) { return publicAuth.assertion(challenge, { origin: issuer, counter: publicCounter++, ...extra }); },
    async reopen(changes = {}) { await c.close(); Object.assign(cfg, changes); return open(); },
  };
}
