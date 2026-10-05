import { deadline } from './limits.mjs';

// Local views retain their existing order; public callers must establish UV before invoking this.
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
export function consentService({ grantProvider, capabilities = { read: true, write: true }, idleSeconds = 3600, maxAgeSeconds = 0 }) {
  const grantsFor = tx => (tx.grants ??= grantProvider && (grantProvider.projectPolicy === 'all' || tx.scope.split(' ').includes('connector:write'))
    ? deadline(Promise.resolve().then(() => grantProvider())).then(value => freeze(structuredClone(value))).catch(() => ({ grants: null, unavailable: [{ reason: 'inventory_failed' }] }))
    : Promise.resolve({ grants: null, unavailable: [] }));
  function summary(g, scope) {
    const all = g.grants?.projectPolicy === 'all', envs = g.grants?.environments ?? [], names = envs.map(e => e.label ?? e.alias).join(' and '), scopes = scope.split(' ');
    const canRead = scopes.includes('connector:read') && capabilities.read, canWrite = scopes.includes('connector:write') && capabilities.write;
    const text = [];
    if (canRead) text.push(all ? `Read access to all current and future projects and exposed thread content of ${names}.` : 'Read access follows the configured project allowlist (restricted mode).');
    if (canWrite) text.push(all ? `Write access to all current and future projects of ${names}; actions run in full-access mode.` : 'Write access is restricted to the inventory approved for this sign-in; actions run in full-access mode.');
    if (canWrite && envs.some(e => e.actions?.includes('project.delete-force'))) text.push('Write access includes deleting projects: empty projects, and, only on an explicit request with force, a project together with its threads.');
    if (canWrite && envs.some(e => e.actions?.includes('t3_project_create'))) text.push('Write access includes native T3 operations: creating, updating and cloning projects, changing environment preferences, and creating, changing, deleting and running scheduled tasks.');
    if (scopes.includes('connector:write') && !capabilities.write) text.push('Writing is unavailable: this deployment offers no write tools.');
    if (all && (canRead || canWrite)) text.push('New projects in these environments are included automatically.');
    text.push(`Session expires after ${idleSeconds} seconds without authorized tool activity${idleSeconds === 3600 ? ' (one hour)' : ''}; it can be revoked locally. Revocation and the kill switch end access.`);
    text.push(maxAgeSeconds ? `Maximum session age: ${maxAgeSeconds} seconds, even with activity.` : 'No absolute maximum session age is configured.');
    return { projectPolicy: all ? 'all' : 'restricted', consent: text.join(' '), idleSeconds, maxAgeSeconds,
      environments: envs.map(e => ({ alias: e.alias, environmentId: e.environmentId, destination: e.destination, projects: e.projects?.map(p => p.name), actions: canWrite ? e.actions.length : 0 })), unavailable: g.unavailable };
  }
  return { grantsFor, async view(tx) { return { clientId: tx.clientId, clientName: tx.clientName, returnsTo: new URL(tx.redirectUri).host, scope: tx.scope, resource: tx.resource, mode: tx.mode, writes: summary(await grantsFor(tx), tx.scope) }; } };
}
