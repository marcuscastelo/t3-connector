import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, dadosPadrao } from './apoio.mjs';
import { startConnector } from './oauth-apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';
import { lerOcupacao } from '../src/escrita/project-admin.mjs';
import { NativeRpcError } from '../src/escrita/native.mjs';
import { StagingRpcTransport, projectReceipt } from '../src/escrita/transport-staging.mjs';
import { canonicalRepositoryKey, ENSURE_SCHEMA } from '../src/oauth/project-ensure.mjs';

const body = r => JSON.parse(r.data.result.content[0].text);
const errorText = r => (assert.equal(r.data.result.isError, true, JSON.stringify(r.data)), r.data.result.content[0].text);
const ISO = '2026-10-06T00:00:00.000Z';
const SSH = 'git@github.com:galm-dev/mcp.galm.ai.git', HTTPS = 'https://github.com/galm-dev/mcp.galm.ai';
const KEY = 'github.com/galm-dev/mcp.galm.ai', OTHER = 'git@github.com:someone/fork.git';
const ROOT = { local: '/Users/dev/Galm/mcp.galm.ai', remoto: '/home/dev/Galm/mcp.galm.ai' };
const NOT_FOUND = "Failed to clone repository: Cloning into 'mcp.galm.ai'...\nERROR: Repository not found.\nfatal: Could not read from remote repository.";

// Fake T3 host with the native semantics the tool relies on (T3 8ed276c2): repositoryIdentity is
// derived from the checkout's remote, clone refuses a non-empty folder, project.create replays by
// commandId and refuses a root in use, project.delete refuses live threads without force and keeps
// the folder. `disk` maps a path to { remoteUrl, remotes? } (a checkout) or { files: true }.
function host({ disk = {}, projects = [], threads = [] } = {}) {
  const h = { disk: structuredClone(disk), projects: projects.map(p => ({ title: p.id, deletedAt: null, ...p })), threads: threads.map(t => ({ archivedAt: null, deletedAt: null, latestRunId: null, status: 'idle', pendingRuntimeRequest: null, title: t.id, ...t })),
    receipts: new Map(), seq: 1, sends: [], rpcs: [], cloneError: null, loseAnswer: null, loseBefore: null, afterCreate: null };
  const identity = root => { const d = h.disk[root]; return d?.remoteUrl ? { canonicalKey: canonicalRepositoryKey(d.remoteUrl), locator: { source: 'git-remote', remoteName: d.remotes?.includes('upstream') ? 'upstream' : 'origin', remoteUrl: d.remoteUrl }, rootPath: root } : null; };
  const view = p => ({ ...p, repositoryIdentity: identity(p.workspaceRoot) });
  h.shell = () => ({ snapshotSequence: h.seq, projects: h.projects.filter(p => !p.deletedAt).map(view), threads: h.threads.filter(t => !t.deletedAt && !t.archivedAt) });
  h.archived = () => ({ snapshotSequence: h.seq, projects: [], threads: h.threads.filter(t => !t.deletedAt && t.archivedAt) });
  const apply = (method, payload) => {
    if (method === 'sourceControl.cloneRepository') {
      if (h.cloneError) throw h.cloneErrorFields ? new NativeRpcError('SourceControlRepositoryError', 'Failed to clone repository.', h.cloneErrorFields) : new NativeRpcError('SourceControlRepositoryError', h.cloneError);
      if (h.disk[payload.destinationPath]) throw new NativeRpcError('SourceControlRepositoryError', 'Failed to clone repository: Destination path already exists and is not empty.');
      const remoteUrl = payload.remoteUrl ?? `git@github.com:${payload.repository}.git`;
      h.disk[payload.destinationPath] = { remoteUrl };
      return { cwd: payload.destinationPath, remoteUrl, repository: null };
    }
    if (method === 'projects.mutate' && payload.type === 'project.create') {
      if (h.receipts.has(payload.commandId)) return h.receipts.get(payload.commandId);
      if (h.projects.some(p => !p.deletedAt && p.workspaceRoot === payload.workspaceRoot)) throw new NativeRpcError('ProjectWorkspaceConflictError', 'workspace root in use');
      const p = { id: payload.projectId, title: payload.title, workspaceRoot: payload.workspaceRoot, deletedAt: null, createdAt: ISO };
      h.projects.push(p); h.seq++;
      const r = view(p); h.receipts.set(payload.commandId, r); h.afterCreate?.(p); return r;
    }
    if (method === 'projects.mutate' && payload.type === 'project.delete') {
      const p = h.projects.find(x => x.id === payload.projectId && !x.deletedAt);
      if (!p) throw new NativeRpcError('ProjectNotFoundError', 'not found');
      if (!payload.force && h.threads.some(t => t.projectId === p.id && !t.deletedAt)) throw new NativeRpcError('ProjectNotEmptyError', 'has threads');
      p.deletedAt = ISO; h.seq++;
      return view(p);
    }
    throw new Error(`unexpected ${method}`);
  };
  h.invoke = async (method, payload) => {
    h.sends.push({ method, payload });
    if (h.loseBefore === method) { h.loseBefore = null; throw new Error('control_transport_uncertain'); }
    const r = apply(method, payload);
    if (h.loseAnswer === method) { h.loseAnswer = null; throw new Error('control_transport_uncertain'); }
    return r;
  };
  h.native = {
    rpc: async (method, payload) => {
      h.rpcs.push({ method, payload });
      assert.equal(method, 'vcs.listRefs');
      const d = h.disk[payload.cwd];
      if (!d?.remoteUrl) return { refs: [], isRepo: false, hasPrimaryRemote: false, nextCursor: null, totalCount: 0 };
      const refs = (d.remotes ?? ['origin']).map(r => ({ name: `${r}/main`, isRemote: true, remoteName: r, current: false, isDefault: false, worktreePath: null }));
      return { refs, isRepo: true, hasPrimaryRemote: refs.some(r => r.remoteName === 'origin'), nextCursor: null, totalCount: refs.length };
    },
    projects: async () => ({ projects: structuredClone(h.projects.map(view)), updatedAt: ISO }),
    thread: async () => { throw new Error('unused'); },
    environment: async () => ({}),
  };
  h.creates = () => h.sends.filter(s => s.method === 'projects.mutate' && s.payload.type === 'project.create');
  h.clones = () => h.sends.filter(s => s.method === 'sourceControl.cloneRepository');
  h.deletes = () => h.sends.filter(s => s.method === 'projects.mutate' && s.payload.type === 'project.delete');
  h.live = () => h.projects.filter(p => !p.deletedAt);
  return h;
}

async function fixture(t, hosts, { projectAdmin = true } = {}) {
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit() {} };
  const connections = reads.registros.map(r => {
    const h = hosts[r.alias] ??= host();
    data[r.alias].shell = () => h.shell();
    return { registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS },
      inventario: async () => { throw new Error('unused'); },
      cliente: async () => ({ shell: async () => structuredClone(h.shell()) }),
      adapter: { prepare: async () => {}, invoke: h.invoke, native: h.native, receipt: r => projectReceipt(r) ?? r, verifyWorkspace: async () => true,
        occupancy: projectId => lerOcupacao({ projectId, readActive: async () => structuredClone(h.shell()), readArchived: async () => structuredClone(h.archived()) }),
        reconcile: async rec => (rec.state === 'completed' && rec.receipt ? { found: true, state: 'completed' } : { found: false, state: 'unknown' }) },
      fechar() {} };
  });
  const c = await startConnector({ tools: t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all', nativeTools: true, projectAdmin }) }); t.after(c.close);
  let at = (await c.signIn()).tokens.access_token;
  const f = {
    c, hosts,
    ensure: (input, op = 'ens-1') => c.callTool(at, 't3_project_ensure', { operationId: op, input: { title: 'mcp.galm.ai', repositoryUrl: SSH, environments: { local: { workspaceRoot: ROOT.local }, remoto: { workspaceRoot: ROOT.remoto } }, ...input } }),
    signInAgain: async () => { at = (await c.signIn()).tokens.access_token; },
    list: async () => (await c.mcp(at, 'tools/list')).data.result.tools,
  };
  return f;
}
const sendCount = hosts => Object.values(hosts).reduce((n, h) => n + h.sends.length, 0);

test('ensure: canonicalRepositoryKey follows T3 normalizeGitRemoteUrl; the schema refuses ambiguous input', () => {
  for (const url of [SSH, HTTPS, `${HTTPS}.git`, `${HTTPS}/`, 'ssh://git@github.com/Galm-Dev/MCP.galm.ai.git', 'https://GitHub.com/galm-dev/mcp.galm.ai']) assert.equal(canonicalRepositoryKey(url), KEY, url);
  assert.equal(canonicalRepositoryKey('git@ssh.dev.azure.com:v3/org/proj/repo'), 'dev.azure.com/org/proj/_git/repo');
  const envs = { local: { workspaceRoot: '/a' } };
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', repositoryUrl: SSH, repository: 'a/b', environments: envs }).success, false);
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', environments: envs }).success, false);
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', repositoryUrl: SSH, environments: { local: { workspaceRoot: 'rel/path' } } }).success, false);
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', repositoryUrl: SSH, environments: envs, primaryEnvironment: 'other' }).success, false);
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', repositoryUrl: SSH, protocol: 'ssh', environments: envs }).success, false);
  assert.equal(ENSURE_SCHEMA.safeParse({ title: 't', repository: 'galm-dev/mcp.galm.ai', protocol: 'ssh', environments: envs }).success, true);
});

test('ensure: listed only for sessions granted native project create and clone', async t => {
  const f = await fixture(t, {});
  const tool = (await f.list()).find(x => x.name === 't3_project_ensure');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['input', 'operationId']);
});

test('ensure (a, j, k): both absent → cloned and registered in both, same canonicalKey; reruns send nothing', async t => {
  const hosts = { local: host(), remoto: host() };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({ primaryEnvironment: 'remoto' }));
  assert.deepEqual(r.summary, { status: 'ready', sameRepositoryIdentity: true, selectorReady: true, primaryEnvironment: 'remoto', partialSuccess: false, warnings: [] });
  assert.equal(r.repository.canonicalKey, KEY);
  assert.deepEqual(Object.keys(r.environments), ['local', 'remoto']);
  for (const alias of ['local', 'remoto']) {
    const e = r.environments[alias], h = hosts[alias];
    assert.equal(e.canonicalKey, KEY); assert.equal(e.workspaceRoot, ROOT[alias]);
    assert.equal(e.registered, true); assert.equal(e.checkoutReady, true); assert.equal(e.accessValidated, true); assert.equal(e.createdByOperation, true);
    assert.equal(e.blocker, null); assert.equal(e.remoteUrl, SSH);
    assert.deepEqual(e.actionsTaken.map(a => a.action), ['inspect_workspace', 'clone', 'register']);
    assert.deepEqual(h.clones().map(s => s.payload), [{ remoteUrl: SSH, destinationPath: ROOT[alias] }]);
    assert.deepEqual(h.creates().map(s => [s.payload.title, s.payload.workspaceRoot, 'createWorkspaceRootIfMissing' in s.payload]), [['mcp.galm.ai', ROOT[alias], false]]);
    assert.equal(e.projectId, h.creates()[0].payload.projectId);
    // Each environment keeps its own registration (different ids), same repository.
  }
  assert.notEqual(r.environments.local.projectId, r.environments.remoto.projectId);
  const sends = sendCount(hosts);
  // Same operationId: discovery finds both registrations; nothing is sent again.
  const again = body(await f.ensure({ primaryEnvironment: 'remoto' }));
  assert.equal(sendCount(hosts), sends);
  assert.equal(again.summary.selectorReady, true);
  for (const alias of ['local', 'remoto']) {
    assert.equal(again.environments[alias].projectId, r.environments[alias].projectId);
    assert.deepEqual(again.environments[alias].actionsTaken, [{ action: 'found_registration', projectId: r.environments[alias].projectId }]);
    assert.equal(again.environments[alias].createdByOperation, true);
  }
  // A new operationId: still nothing to do, no duplicate registration.
  const later = body(await f.ensure({}, 'ens-2'));
  assert.equal(sendCount(hosts), sends);
  assert.equal(later.summary.status, 'ready'); assert.equal(later.environments.local.createdByOperation, false);
  assert.equal(hosts.local.live().length, 1); assert.equal(hosts.remoto.live().length, 1);
});

test('ensure (b, c, j): only one environment registered → completes the other without touching the first', async t => {
  for (const [registered, missing] of [['remoto', 'local'], ['local', 'remoto']]) {
    const hosts = {
      [registered]: host({ disk: { [ROOT[registered]]: { remoteUrl: HTTPS } }, projects: [{ id: 'existing', title: 'mcp.galm.ai', workspaceRoot: ROOT[registered] }] }),
      [missing]: host(),
    };
    const f = await fixture(t, hosts);
    const r = body(await f.ensure({}));
    assert.equal(hosts[registered].sends.length, 0, registered);
    assert.equal(hosts[registered].rpcs.length, 0);
    assert.equal(hosts[missing].clones().length, 1); assert.equal(hosts[missing].creates().length, 1);
    const reg = r.environments[registered], mis = r.environments[missing];
    assert.equal(reg.projectId, 'existing'); assert.equal(reg.createdByOperation, false); assert.equal(reg.accessValidated, false); assert.equal(reg.remoteUrl, HTTPS);
    assert.equal(mis.createdByOperation, true); assert.equal(mis.accessValidated, true);
    // https and ssh spellings of one repository give one canonicalKey.
    assert.equal(reg.canonicalKey, KEY); assert.equal(mis.canonicalKey, KEY);
    assert.equal(r.summary.selectorReady, true); assert.equal(r.summary.sameRepositoryIdentity, true);
    assert.deepEqual(r.summary.warnings.map(w => [w.environment, w.code]), [[registered, 'access_not_validated']]);
  }
});

test('ensure (d): existing checkouts of the same repository are registered as they are, never cloned over', async t => {
  const disk = { local: { [ROOT.local]: { remoteUrl: SSH, remotes: ['origin', 'upstream'] } }, remoto: { [ROOT.remoto]: { remoteUrl: HTTPS } } };
  const hosts = { local: host({ disk: disk.local }), remoto: host({ disk: disk.remoto }) };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  for (const alias of ['local', 'remoto']) {
    assert.equal(hosts[alias].clones().length, 0); assert.equal(hosts[alias].creates().length, 1);
    assert.deepEqual(hosts[alias].disk, disk[alias]);
    assert.deepEqual(r.environments[alias].actionsTaken.map(a => a.action), ['inspect_workspace', 'register']);
    assert.equal(r.environments[alias].accessValidated, false);
  }
  assert.deepEqual(r.environments.local.actionsTaken[0], { action: 'inspect_workspace', isRepo: true, remoteNames: ['origin', 'upstream'] });
  assert.equal(r.summary.selectorReady, true);
  assert.ok(r.summary.warnings.some(w => w.environment === 'local' && w.code === 'multiple_remotes'));
});

test('ensure (e, h): divergent remote → the empty registration this operation created is deleted (never forced, folder kept); a preexisting one is left alone', async t => {
  const hosts = {
    local: host({ disk: { [ROOT.local]: { remoteUrl: OTHER } } }),
    remoto: host({ disk: { [ROOT.remoto]: { remoteUrl: OTHER } }, projects: [{ id: 'mine', workspaceRoot: ROOT.remoto }] }),
  };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  const local = r.environments.local, remoto = r.environments.remoto;
  assert.equal(local.blocker.code, 'remote_mismatch');
  assert.equal(local.blocker.compensation, 'deleted_empty_registration');
  assert.equal(local.blocker.expectedCanonicalKey, KEY); assert.equal(local.blocker.observedCanonicalKey, 'github.com/someone/fork');
  assert.equal(local.blocker.remoteName, 'origin'); assert.equal(local.blocker.workspaceKept, true);
  assert.equal(local.registered, false); assert.equal(local.checkoutReady, false);
  assert.deepEqual(hosts.local.deletes().map(s => s.payload.force), [false]);
  assert.equal(hosts.local.live().length, 0);
  assert.deepEqual(hosts.local.disk, { [ROOT.local]: { remoteUrl: OTHER } }); // remotes and content untouched
  assert.deepEqual(local.actionsTaken.map(a => a.action), ['inspect_workspace', 'register', 'compensate']);
  // Preexisting registration with the wrong repository: reported, nothing sent.
  assert.equal(remoto.blocker.code, 'remote_mismatch'); assert.equal(remoto.blocker.compensation, 'not_applicable_preexisting_registration');
  assert.equal(remoto.registered, true); assert.equal(hosts.remoto.sends.length, 0);
  assert.deepEqual(r.summary, { status: 'blocked', sameRepositoryIdentity: false, selectorReady: false, primaryEnvironment: 'local', partialSuccess: false, warnings: [] });
});

test('ensure (e): a checkout inside another repository is not taken for the requested one', async t => {
  const hosts = { local: host({ disk: { [ROOT.local]: { remoteUrl: SSH } } }), remoto: host() };
  // T3 resolves the parent checkout's identity (rootPath) for a folder inside it.
  hosts.local.native.projects = async () => ({ projects: hosts.local.projects.map(p => ({ ...p, repositoryIdentity: { canonicalKey: KEY, locator: { source: 'git-remote', remoteName: 'origin', remoteUrl: SSH }, rootPath: '/Users/dev' } })) });
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  assert.equal(r.environments.local.blocker.code, 'workspace_inside_other_repository');
  assert.equal(r.environments.local.blocker.compensation, 'deleted_empty_registration');
  assert.equal(r.summary.status, 'partial'); assert.equal(r.summary.partialSuccess, true); assert.equal(r.summary.selectorReady, false);
});

test('ensure (f): private repository answered "Repository not found" → blocker per environment, nothing created, credentials untouched', async t => {
  const hosts = { local: host(), remoto: host() };
  hosts.local.cloneError = NOT_FOUND; hosts.remoto.cloneError = NOT_FOUND;
  // T3 may keep the Git stderr in a field of its typed error rather than in the message.
  hosts.remoto.cloneErrorFields = { detail: NOT_FOUND };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  for (const alias of ['local', 'remoto']) {
    const e = r.environments[alias];
    assert.equal(e.blocker.code, 'repository_not_found_or_no_access');
    assert.match(e.blocker.message, /private repository the Git credentials of this T3 host cannot read/);
    assert.equal(e.blocker.nothingCreated, true); assert.equal(e.blocker.detail.code, 'SourceControlRepositoryError');
    assert.equal(e.registered, false); assert.equal(e.projectId, null);
    assert.equal(hosts[alias].creates().length, 0); assert.deepEqual(hosts[alias].disk, {});
  }
  assert.equal(r.summary.status, 'blocked');
  // Same operationId: the failed clone replays, it is not retried.
  body(await f.ensure({}));
  assert.equal(hosts.local.clones().length, 1);
  // After access is fixed, a new operationId clones.
  hosts.local.cloneError = null; hosts.remoto.cloneError = null;
  assert.equal(body(await f.ensure({}, 'ens-2')).summary.selectorReady, true);
});

test('ensure (f): "not found" on one host while the other reached the repository → access denied, partial success', async t => {
  const hosts = { local: host(), remoto: host() };
  hosts.remoto.cloneError = NOT_FOUND;
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({ primaryEnvironment: 'remoto' }));
  assert.equal(r.environments.remoto.blocker.code, 'repository_access_denied');
  assert.match(r.environments.remoto.blocker.message, /reachable from local, so the URL is valid/);
  assert.equal(r.environments.local.checkoutReady, true);
  assert.equal(r.summary.status, 'partial'); assert.equal(r.summary.partialSuccess, true); assert.equal(r.summary.sameRepositoryIdentity, false);
  assert.equal(hosts.remoto.creates().length, 0);
});

test('ensure: other refusals are explicit and keep existing content', async t => {
  const hosts = { local: host({ disk: { [ROOT.local]: { files: true } } }), remoto: host({ disk: { '/elsewhere': { remoteUrl: HTTPS } }, projects: [{ id: 'old', workspaceRoot: '/elsewhere' }] }) };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  assert.equal(r.environments.local.blocker.code, 'workspace_not_empty');
  assert.deepEqual(hosts.local.disk, { [ROOT.local]: { files: true } }); assert.equal(hosts.local.creates().length, 0);
  assert.equal(r.environments.remoto.blocker.code, 'repository_registered_at_other_root');
  assert.equal(r.environments.remoto.blocker.projectId, 'old'); assert.equal(hosts.remoto.sends.length, 0);
  // Refused before any effect.
  assert.match(errorText(await f.ensure({ repositoryUrl: 'not a url' }, 'bad-1')), /^invalid_request: repositoryUrl is not a Git remote URL/);
  assert.match(errorText(await f.ensure({ environments: { local: { workspaceRoot: '/a' }, 'env-local': { workspaceRoot: '/b' } } }, 'bad-2')), /^invalid_request: two environments keys name the same environment/);
  assert.match(errorText(await f.ensure({ environments: { nowhere: { workspaceRoot: '/a' } } }, 'bad-3')), /^environment_unknown/);
  // The only send is the clone T3 refused for the non-empty folder.
  assert.equal(sendCount(hosts), 1); assert.equal(hosts.local.clones().length, 1);
});

test('ensure (g): an answer lost after the registration landed → the rerun finds it, owned by the operation, without resending', async t => {
  const hosts = { local: host(), remoto: host() };
  hosts.local.loseAnswer = 'projects.mutate';
  const f = await fixture(t, hosts);
  // A lost transport fails closed (every session ends); the result is withheld.
  assert.match(errorText(await f.ensure({})), /session_expired/);
  assert.equal(hosts.local.live().length, 1); assert.equal(hosts.remoto.sends.length, 0);
  await f.signInAgain();
  const r = body(await f.ensure({}));
  assert.equal(hosts.local.creates().length, 1); assert.equal(hosts.local.clones().length, 1);
  assert.equal(r.environments.local.createdByOperation, true); assert.equal(r.environments.local.projectId, hosts.local.live()[0].id);
  assert.equal(r.summary.selectorReady, true);
});

test('ensure (g): an uncertain registration with no observable effect is reconciled, never resent', async t => {
  const hosts = { local: host(), remoto: host() };
  hosts.local.loseBefore = 'projects.mutate';
  const f = await fixture(t, hosts);
  assert.match(errorText(await f.ensure({})), /session_expired/);
  await f.signInAgain();
  const r = body(await f.ensure({}));
  const local = r.environments.local;
  assert.equal(local.blocker.code, 'write_uncertain'); assert.equal(local.blocker.operationId, 'ens-1/local/register');
  assert.deepEqual(local.actionsTaken.map(a => a.action), ['inspect_workspace', 'register', 'reconcile', 'observe_registration']);
  assert.equal(local.actionsTaken[1].state, 'uncertain'); assert.equal(local.actionsTaken[1].replayed, true);
  assert.deepEqual(local.actionsTaken[2].observation, { found: false, state: 'unknown' });
  assert.equal(hosts.local.creates().length, 1); // not resent
  assert.equal(r.summary.status, 'partial');
  // Checked and absent: a new operationId registers it.
  const next = body(await f.ensure({}, 'ens-2'));
  assert.equal(hosts.local.creates().length, 2); assert.equal(next.summary.selectorReady, true);
});

test('ensure (i): a registration that gained a thread is never deleted, even if this operation created it', async t => {
  const hosts = {
    local: host({ disk: { [ROOT.local]: { remoteUrl: OTHER } } }),
    remoto: host({ disk: { [ROOT.remoto]: { remoteUrl: OTHER } }, projects: [{ id: 'busy', workspaceRoot: ROOT.remoto }], threads: [{ id: 't1', projectId: 'busy' }] }),
  };
  // Another client launches a thread in the new project right after it is registered.
  hosts.local.afterCreate = p => { hosts.local.threads.push({ id: 't2', projectId: p.id, archivedAt: null, deletedAt: null, latestRunId: null, status: 'idle', pendingRuntimeRequest: null, title: 't2' }); };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  assert.equal(r.environments.local.blocker.code, 'remote_mismatch');
  assert.equal(r.environments.local.blocker.compensation, 'refused_project_has_threads');
  assert.equal(r.environments.local.registered, true);
  assert.equal(hosts.local.deletes().length, 0); assert.equal(hosts.local.live().length, 1);
  assert.equal(r.environments.remoto.blocker.compensation, 'not_applicable_preexisting_registration');
  assert.equal(hosts.remoto.sends.length, 0);
  for (const h of Object.values(hosts)) assert.ok(!h.sends.some(s => s.payload.force === true));
});

test('ensure (h): without project administration consent the wrong registration is reported, not deleted', async t => {
  const hosts = { local: host({ disk: { [ROOT.local]: { remoteUrl: OTHER } } }), remoto: host() };
  const f = await fixture(t, hosts, { projectAdmin: false });
  const r = body(await f.ensure({}));
  assert.equal(r.environments.local.blocker.compensation, 'not_authorized');
  assert.equal(hosts.local.deletes().length, 0); assert.equal(hosts.local.live().length, 1);
});

test('ensure: repository shorthand clones through the GitHub provider and expects its canonicalKey', async t => {
  const hosts = { local: host(), remoto: host() };
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({ repositoryUrl: undefined, repository: 'galm-dev/mcp.galm.ai', protocol: 'ssh' }));
  assert.deepEqual(hosts.local.clones()[0].payload, { provider: 'github', repository: 'galm-dev/mcp.galm.ai', destinationPath: ROOT.local, protocol: 'ssh' });
  assert.equal(r.repository.canonicalKey, KEY); assert.equal(r.summary.selectorReady, true);
});

test('transport: a synchronous clone gets T3\'s clone bound, other methods keep the default timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = { readyState: 1, url: 'ws://127.0.0.1:1/ws?orchestrationProtocol=2', addEventListener() {}, send() {} };
  let failed = 0;
  const tr = new StagingRpcTransport({ socket, allowLoopback: true, onFailure: () => failed++ });
  tr.invoke('sourceControl.cloneRepository', {}, { nativeErrors: true }).catch(() => {});
  t.mock.timers.tick(10001);
  assert.equal(failed, 0);
  t.mock.timers.tick(120000);
  assert.equal(failed, 1);
  const tr2 = new StagingRpcTransport({ socket, allowLoopback: true, onFailure: () => failed++ });
  tr2.invoke('server.getSettings', {}, { nativeErrors: true }).catch(() => {});
  t.mock.timers.tick(10001);
  assert.equal(failed, 2);
});

test('ensure: an identity T3 has not resolved yet is reported, never compensated', async t => {
  const hosts = { local: host({ disk: { [ROOT.local]: { remoteUrl: OTHER } } }), remoto: host() };
  const read = hosts.local.native.projects;
  hosts.local.native.projects = async () => ({ projects: (await read()).projects.map(p => ({ ...p, repositoryIdentity: null })) });
  const f = await fixture(t, hosts);
  const r = body(await f.ensure({}));
  assert.equal(r.environments.local.blocker.code, 'identity_unresolved');
  assert.equal(r.environments.local.registered, true); assert.equal(r.environments.local.canonicalKey, null);
  assert.equal(hosts.local.deletes().length, 0);
  assert.equal(r.summary.sameRepositoryIdentity, false); assert.equal(r.summary.status, 'partial');
});
