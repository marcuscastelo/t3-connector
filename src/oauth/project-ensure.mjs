import { z } from 'zod';
import { posix } from 'node:path';
import { chaveOperacao, stableCommandId } from '../escrita/adapters.mjs';
import { NativeToolError, NativeRpcError } from '../escrita/native.mjs';

// t3_project_ensure: one Git repository checked out and registered as a project in each listed
// environment, all resolving to the same repository identity (T3's canonicalKey). It is a
// coordinator over the existing writes and reads, never a parallel service:
// - discovery and identity: the environment's GET /api/projects (as t3_project_read);
// - workspace inspection: vcs.listRefs on the requested root (isRepo, remote ref names);
// - clone: t3_project_clone; registration: t3_project_create with workspaceRoot;
// - compensation: project.delete (never force) of a registration this operation created;
// - every write goes through the session's dispatch (journal, authorization, final check) under a
//   sub-operationId derived from the caller's operationId, so a repeated call replays instead of
//   resending; an uncertain write is reconciled, never retried.
// Limits of the primitives (no connector or T3 RPC reads or changes an existing checkout's
// remotes): a divergent remote is reported, not fixed; the remote of an existing checkout is
// known only after registration, when T3 resolves the project's repositoryIdentity.

const str = z.string().trim().min(1).max(1024);
const MAX_ENVIRONMENTS = 8;
export const ENSURE_SCHEMA = z.object({
  title: str.describe('Project title, used when a registration is created.'),
  repositoryUrl: str.optional().describe('Git remote URL of the repository (https://host/owner/name, ssh://..., or git@host:owner/name). Exactly one of repositoryUrl or repository.'),
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional().describe('GitHub owner/name; T3 picks the clone URL (protocol auto prefers SSH). Exactly one of repositoryUrl or repository.'),
  protocol: z.enum(['auto', 'ssh', 'https']).optional().describe('Only with repository.'),
  environments: z.record(str, z.object({ workspaceRoot: str.describe('Absolute path of the checkout on the T3 host of that environment.') }).strict())
    .describe('Environment alias or environmentId → its workspaceRoot. Each environment keeps its own registration; the repository is the same.'),
  primaryEnvironment: str.optional().describe('One of the environments keys; handled first and reported as primary. Default: the first key.'),
}).strict().superRefine((v, ctx) => {
  const issue = message => ctx.addIssue({ code: 'custom', message });
  if ((v.repositoryUrl === undefined) === (v.repository === undefined)) issue('pass exactly one of repositoryUrl or repository');
  if (v.protocol !== undefined && v.repository === undefined) issue('protocol applies only to repository');
  const keys = Object.keys(v.environments);
  if (!keys.length || keys.length > MAX_ENVIRONMENTS) issue(`environments needs 1 to ${MAX_ENVIRONMENTS} entries`);
  for (const k of keys) if (!v.environments[k].workspaceRoot.startsWith('/')) issue(`environments.${k}.workspaceRoot must be an absolute path`);
  if (v.primaryEnvironment !== undefined && !keys.includes(v.primaryEnvironment)) issue('primaryEnvironment must be one of the environments keys');
});

export const ENSURE_DESCRIPTION = 'Ensures that one Git repository is checked out and registered as a T3 project in each listed environment (e.g. both hosts), with the same repository identity (canonicalKey) everywhere, so T3 treats the registrations as one repository. Idempotent: an existing registration of the workspaceRoot is reused, an existing Git checkout is never overwritten, reset, cleaned or cloned over; a missing or empty folder is cloned, then registered. Never creates a remote repository, never changes credentials or Git remotes, never force-deletes. A registration this operation created whose repository turns out wrong is deleted only if it has no thread (workspace on disk kept; needs project administration consent). A clone refused as "Repository not found" is reported as a blocker for that environment (missing repository or no access from that host). Writes are journaled under sub-operationIds derived from operationId; repeating the call with the same operationId replays them and reconciles an uncertain one instead of resending. After resolving a blocker, call again with a new operationId. Result: per environment projectId, workspaceRoot, repositoryIdentity/canonicalKey, remoteUrl, registered, checkoutReady, accessValidated, blocker, actionsTaken; summary with sameRepositoryIdentity, selectorReady, primaryEnvironment, partialSuccess, warnings.';

/** The comparison key T3 derives from a Git remote URL (packages/shared/src/git.ts normalizeGitRemoteUrl, 8ed276c2). */
export function canonicalRepositoryKey(value) {
  const azure = (host, segments) => {
    if (host !== 'ssh.dev.azure.com' && host !== 'vs-ssh.visualstudio.com') return null;
    const [marker, organization, project, repository] = segments;
    if (segments.length !== 4 || marker !== 'v3' || !organization || !project || !repository) return null;
    return host === 'ssh.dev.azure.com' ? `dev.azure.com/${organization}/${project}/_git/${repository}` : `${organization}.visualstudio.com/${project}/_git/${repository}`;
  };
  const normalized = value.trim().replace(/\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const segments = url.pathname.split('/').filter(s => s.length > 0);
      if (url.hostname && segments.length > 1) return azure(url.hostname, segments) ?? `${url.hostname}/${segments.join('/')}`;
    } catch { return normalized; }
  }
  const scp = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  if (scp) return azure(scp[1], scp[2].split('/')) ?? `${scp[1]}/${scp[2]}`;
  return normalized;
}
const USABLE_KEY = /^[a-z0-9.-]+(?::\d+)?\/[^/\s]+\/[^\s]+$/;
const normalizeRoot = p => { const n = posix.normalize(p.trim()); return n.length > 1 ? n.replace(/\/+$/, '') : n; };

const MESSAGES = {
  repository_not_found_or_no_access: 'Git answered that the repository was not found. Hosts such as GitHub answer this both for a repository that does not exist and for a private repository the Git credentials of this T3 host cannot read. Check the URL, then this host\'s access to the repository (SSH key or credential helper).',
  repository_access_denied: 'Git refused access to the repository from this T3 host. Its Git credentials (SSH key or credential helper) lack access to this repository.',
  repository_host_unreachable: 'The Git host could not be reached from this T3 host.',
  invalid_repository_url: 'T3 refused the repository address.',
  workspace_not_empty: 'workspaceRoot exists, is not a Git checkout and is not empty; its content was kept and nothing was cloned. Use an empty or missing folder, or make it a checkout of the repository first.',
  clone_failed: 'The clone failed.',
  remote_mismatch: 'The checkout at workspaceRoot resolves to another repository than the requested one. Its remotes were not changed: point the remote T3 uses (repositoryIdentity.locator.remoteName; T3 prefers upstream over origin) at the requested repository on that host, then call again with a new operationId (T3 may keep the previous identity cached for up to 15 minutes).',
  workspace_inside_other_repository: 'workspaceRoot is inside another Git checkout (repositoryIdentity.rootPath), so T3 resolves that repository. Use the checkout root itself.',
  identity_unresolved: 'T3 has not resolved a Git repository identity for this registration yet (identity still loading, no Git checkout, or no remote). Nothing else was changed; call again with a new operationId to verify.',
  repository_registered_at_other_root: 'This environment already has a project for this repository at another workspaceRoot; no second registration was created. Use that workspaceRoot or remove the other registration first.',
  write_uncertain: 'A write was sent but its result could not be confirmed; it is not resent. Call again with the same operationId to reconcile it, or check the environment before using a new operationId.',
  write_refused: 'A write was refused before or by T3.',
  registration_removed: 'This operationId already registered this workspace and the registration was later removed. Call again with a new operationId.',
  environment_unavailable: 'The T3 server of this environment did not answer.',
};

/**
 * @param deps.resolve        environment key → write connection (throws for an unknown one)
 * @param deps.actions        (principal, c) → actions consented for the environment (throws if not consented)
 * @param deps.native         (principal, c, fn) → fn(native) under the consented session
 * @param deps.dispatch       session dispatch (journal, authorization, final check)
 * @param deps.reconcile      session reconcile (journal receipt; never resends)
 * @param deps.caller         principal → caller identity of the journal key
 * @param deps.code           internal error code → public code
 */
export function projectEnsure({ resolve, actions, native, dispatch, reconcile, caller, code, identityWait = { attempts: 10, delayMs: 500 } }) {
  const refusal = (c, message) => { throw new NativeToolError(c, message); };

  async function write(principal, c, action, operationId, input) {
    try {
      const r = await dispatch(principal, { environment: c.registro.alias, action, operationId, input });
      const replayed = 'reconciliationRequired' in r;
      if (r.state === 'completed') return { state: 'completed', receipt: r.receipt, replayed };
      if (r.state === 'failed' || r.state === 'rejected') return { state: r.state, error: r.error ?? null, replayed };
      return { state: 'uncertain', error: r.error ?? null, replayed };
    } catch (e) {
      if (e?.message === 'reconciliation_required') return { state: 'uncertain', error: e.native ?? null };
      if (e instanceof NativeRpcError) return { state: 'failed', error: e.native };
      if (e instanceof NativeToolError) return { state: 'rejected', error: e.native };
      return { state: 'rejected', error: { code: /^[a-z_]+$/.test(e?.message ?? '') ? code(e.message) : 'write_rejected' } };
    }
  }

  function classifyClone(error) {
    // The Git stderr tail may be in the message or in a primitive field of the typed error (e.g. detail).
    const text = Object.values(error ?? {}).filter(v => typeof v === 'string').join(' ');
    if (/already exists and is not (empty|a directory)/i.test(text)) return 'workspace_not_empty';
    if (/repository\b.*\bnot found|\b404\b/i.test(text)) return 'repository_not_found_or_no_access';
    if (/permission denied|publickey|authentication failed|could not read username|access denied|\b403\b|terminal prompts disabled/i.test(text)) return 'repository_access_denied';
    if (/could not resolve host|connection refused|connection timed out|network is unreachable/i.test(text)) return 'repository_host_unreachable';
    if (/enter a repository path|clone url|not a valid|invalid/i.test(text)) return 'invalid_repository_url';
    if (/^[a-z_]+$/.test(error?.code ?? '')) return error.code; // connector refusal before sending (scope_denied, operation_conflict, ...)
    return 'clone_failed';
  }

  async function one(principal, request, env, warn) {
    const { c, workspaceRoot } = env, { alias, environmentId, destination } = c.registro;
    const out = { environment: { alias, environmentId }, projectId: null, workspaceRoot, repositoryIdentity: null, canonicalKey: null, remoteUrl: null,
      registered: false, checkoutReady: false, accessValidated: false, createdByOperation: false, blocker: null, actionsTaken: [] };
    const block = (blocker, extra = {}) => { out.blocker = { code: blocker, message: MESSAGES[blocker] ?? blocker, ...extra }; return out; };
    const sub = step => `${request.operationId}/${alias}/${step}`;
    // A native create uses the operation's stable commandId as projectId: the registration this
    // operation creates is recognizable after a lost answer or a restart.
    const ownProjectId = stableCommandId(chaveOperacao({ environmentId, destination, caller: caller(principal), operationId: sub('register') }));
    const live = async () => (await native(principal, c, n => n.projects())).projects.filter(p => p.deletedAt === null);
    const settle = async (step, operationId, r) => {
      out.actionsTaken.push({ action: step, operationId, state: r.state, ...(r.replayed ? { replayed: true } : {}), ...(r.error ? { error: r.error } : {}) });
      if (r.state !== 'uncertain') return;
      try {
        const rec = await reconcile(principal, { environment: alias, operationId });
        out.actionsTaken.push({ action: 'reconcile', operationId, state: rec.state, observation: rec.observation ?? null });
      } catch (e) { out.actionsTaken.push({ action: 'reconcile', operationId, error: { code: /^[a-z_]+$/.test(e?.message ?? '') ? code(e.message) : 'reconcile_failed' } }); }
    };

    let projects;
    // A session that ended meanwhile withholds the whole result (resource server), so any read failure here is the environment's.
    try { projects = await live(); } catch { return block('environment_unavailable'); }
    let project = projects.find(p => typeof p.workspaceRoot === 'string' && normalizeRoot(p.workspaceRoot) === workspaceRoot);
    let cloned = false;
    if (project) out.actionsTaken.push({ action: 'found_registration', projectId: project.id });
    else {
      const elsewhere = projects.find(p => p.repositoryIdentity?.canonicalKey === request.canonicalKey);
      if (elsewhere) return block('repository_registered_at_other_root', { projectId: elsewhere.id, registeredWorkspaceRoot: elsewhere.workspaceRoot });
      if (projects.some(p => p.title === request.title)) warn(alias, 'title_in_use', 'another project of this environment has the same title (different workspaceRoot)');
      let probe;
      try { probe = await native(principal, c, n => n.rpc('vcs.listRefs', { cwd: workspaceRoot, refKind: 'remote', limit: 100 })); }
      catch (e) {
        if (!(e instanceof NativeRpcError)) return block('environment_unavailable');
        probe = { isRepo: false, error: e.native };
      }
      const remoteNames = [...new Set((probe.refs ?? []).map(r => r.remoteName ?? (r.isRemote ? r.name.split('/')[0] : null)).filter(Boolean))].sort();
      out.actionsTaken.push({ action: 'inspect_workspace', isRepo: probe.isRepo === true, ...(remoteNames.length ? { remoteNames } : {}), ...(probe.error ? { error: probe.error } : {}) });
      if (remoteNames.includes('origin') && remoteNames.includes('upstream')) warn(alias, 'multiple_remotes', 'the checkout has origin and upstream remotes; T3 resolves the repository identity from upstream');
      if (probe.isRepo !== true) {
        // Missing or empty folder: T3 clones (and refuses a non-empty folder without touching it).
        const op = sub('clone');
        const r = await write(principal, c, 't3_project_clone', op, request.clone(workspaceRoot));
        await settle('clone', op, r);
        if (r.state === 'uncertain') return block('write_uncertain', { operationId: op });
        if (r.state !== 'completed') {
          const blocker = classifyClone(r.error);
          return block(blocker, { operationId: op, ...(r.error ? { detail: r.error } : {}), ...(blocker.startsWith('repository_') ? { nothingCreated: true } : {}) });
        }
        cloned = true;
        out.accessValidated = true;
        out.remoteUrl = r.receipt?.remoteUrl ?? null;
      }
      const op = sub('register');
      const r = await write(principal, c, 't3_project_create', op, { title: request.title, workspaceRoot });
      await settle('register', op, r);
      let latest;
      try { latest = await live(); } catch { return block(r.state === 'completed' ? 'environment_unavailable' : 'write_uncertain', { operationId: op }); }
      if (r.state === 'completed') {
        project = latest.find(p => p.id === (r.receipt?.id ?? ownProjectId));
        if (!project) return block(r.replayed ? 'registration_removed' : 'environment_unavailable', { operationId: op });
      } else if (r.state === 'uncertain') {
        // The effect is observable: the operation's project id is its stable commandId.
        project = latest.find(p => p.id === ownProjectId);
        out.actionsTaken.push({ action: 'observe_registration', operationId: op, found: Boolean(project) });
        if (!project) return block('write_uncertain', { operationId: op });
        warn(alias, 'write_uncertain_effect_observed', `the registration of ${op} was not confirmed, but the project it creates exists`);
      } else return block('write_refused', { operationId: op, ...(r.error ? { detail: r.error } : {}) });
    }
    out.projectId = project.id;
    out.registered = true;
    out.createdByOperation = project.id === ownProjectId;

    // T3 resolves repositoryIdentity asynchronously after a registration.
    let identity = project.repositoryIdentity ?? null;
    for (let i = 1; !identity?.canonicalKey && i < identityWait.attempts; i++) {
      await new Promise(r => setTimeout(r, identityWait.delayMs));
      let again;
      try { again = (await live()).find(p => p.id === project.id); } catch { break; }
      if (!again) { out.registered = false; return block('registration_removed'); }
      identity = again.repositoryIdentity ?? null;
    }
    out.repositoryIdentity = identity;
    out.canonicalKey = identity?.canonicalKey ?? null;
    out.remoteUrl = identity?.locator?.remoteUrl ?? out.remoteUrl;
    if (!out.canonicalKey) return block('identity_unresolved');
    const inside = identity.rootPath && normalizeRoot(identity.rootPath) !== workspaceRoot;
    if (out.canonicalKey === request.canonicalKey && !inside) { out.checkoutReady = true; return out; }

    const reason = inside ? 'workspace_inside_other_repository' : 'remote_mismatch';
    const extra = { expectedCanonicalKey: request.canonicalKey, observedCanonicalKey: out.canonicalKey, ...(identity.locator ? { remoteName: identity.locator.remoteName } : {}) };
    // Only a registration this operation created is undone, only if it has no thread, never forced.
    if (!out.createdByOperation) return block(reason, { ...extra, compensation: 'not_applicable_preexisting_registration' });
    if (!actions(principal, c).includes('project.delete')) return block(reason, { ...extra, compensation: 'not_authorized' });
    const op = sub('compensate');
    const d = await write(principal, c, 'project.delete', op, { projectId: project.id });
    await settle('compensate', op, d);
    if (d.state === 'completed') {
      out.registered = false;
      return block(reason, { ...extra, compensation: 'deleted_empty_registration', compensatedProjectId: project.id, workspaceKept: true });
    }
    const compensation = d.state === 'uncertain' ? 'uncertain' : d.error?.code === 'project_not_empty' ? 'refused_project_has_threads' : 'refused';
    return block(reason, { ...extra, compensation, ...(d.state === 'uncertain' ? { operationId: op } : {}), ...(d.error ? { detail: d.error } : {}) });
  }

  return async function ensure(principal, { operationId, input }) {
    const p = ENSURE_SCHEMA.parse(input);
    const canonicalKey = p.repositoryUrl !== undefined ? canonicalRepositoryKey(p.repositoryUrl) : `github.com/${p.repository.toLowerCase()}`;
    if (!USABLE_KEY.test(canonicalKey)) refusal('invalid_request', 'repositoryUrl is not a Git remote URL (https://host/owner/name, ssh://git@host/owner/name or git@host:owner/name); nothing was sent');
    const keys = Object.keys(p.environments), primary = p.primaryEnvironment ?? keys[0];
    // Every environment resolved and authorized before the first effect.
    const envs = keys.map(key => ({ key, c: resolve(key), workspaceRoot: normalizeRoot(p.environments[key].workspaceRoot) }));
    if (new Set(envs.map(e => e.c.registro.alias)).size !== envs.length) refusal('invalid_request', 'two environments keys name the same environment; nothing was sent');
    for (const e of envs) { const a = actions(principal, e.c); if (!a.includes('t3_project_create') || !a.includes('t3_project_clone')) throw new Error('scope_denied'); }
    const request = { operationId, title: p.title, canonicalKey,
      clone: destinationPath => p.repositoryUrl !== undefined ? { remoteUrl: p.repositoryUrl, destinationPath } : { provider: 'github', repository: p.repository, destinationPath, ...(p.protocol ? { protocol: p.protocol } : {}) } };
    const warnings = [], results = {};
    const warn = (environment, c, message) => warnings.push({ environment, code: c, message });
    for (const e of [...envs.filter(x => x.key === primary), ...envs.filter(x => x.key !== primary)]) results[e.key] = await one(principal, request, e, warn);

    // "Not found" from one host while another reached or holds the same repository: the URL is valid.
    const reachable = Object.values(results).find(r => r.accessValidated || (r.canonicalKey === canonicalKey && r.checkoutReady));
    for (const r of Object.values(results)) if (reachable && r.blocker?.code === 'repository_not_found_or_no_access') {
      r.blocker = { ...r.blocker, code: 'repository_access_denied', message: `${MESSAGES.repository_access_denied} The same repository is reachable from ${reachable.environment.alias}, so the URL is valid.` };
    }
    const all = keys.map(k => results[k]);
    const ready = all.filter(r => r.checkoutReady && r.registered && !r.blocker);
    const sameRepositoryIdentity = all.every(r => r.registered && r.canonicalKey) && new Set(all.map(r => r.canonicalKey)).size === 1;
    if (keys.length < 2) warn(null, 'single_environment', 'only one environment was listed; there is nothing to pair');
    for (const r of all) if (r.registered && !r.accessValidated && r.checkoutReady) warn(r.environment.alias, 'access_not_validated', 'existing checkout reused; the remote was not contacted');
    const status = ready.length === all.length ? 'ready' : ready.length ? 'partial' : 'blocked';
    return {
      operationId, title: p.title,
      repository: { requested: p.repositoryUrl ?? p.repository, canonicalKey },
      environments: Object.fromEntries(keys.map(k => [k, results[k]])),
      summary: { status, sameRepositoryIdentity, selectorReady: keys.length >= 2 && status === 'ready' && sameRepositoryIdentity, primaryEnvironment: primary, partialSuccess: status === 'partial', warnings },
    };
  };
}
