import { deadline } from './limits.mjs';

// Local views retain their existing order; public callers must establish UV before invoking this.
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
// Generic access lines; a connector passes `describeAccess` with its own domain wording. It returns
// the lines shown before the session terms (idle window, maximum age), which stay here.
export function genericAccess({ canRead, canWrite, scopes, capabilities }) {
  const text = [];
  if (canRead) text.push('Read access to the read-only tools of this connector.');
  if (canWrite) text.push('Write access to the write tools of this connector.');
  if (scopes.includes('connector:write') && !capabilities.write) text.push('Writing is unavailable: this deployment offers no write tools.');
  return text;
}

export function consentService({ grantProvider, capabilities = { read: true, write: true }, idleSeconds = 3600, maxAgeSeconds = 0, describeAccess = genericAccess }) {
  const grantsFor = tx => (tx.grants ??= grantProvider && (grantProvider.projectPolicy === 'all' || tx.scope.split(' ').includes('connector:write'))
    ? deadline(Promise.resolve().then(() => grantProvider())).then(value => freeze(structuredClone(value))).catch(() => ({ grants: null, unavailable: [{ reason: 'inventory_failed' }] }))
    : Promise.resolve({ grants: null, unavailable: [] }));
  function summary(g, scope) {
    const all = g.grants?.projectPolicy === 'all', envs = g.grants?.environments ?? [], names = envs.map(e => e.label ?? e.alias).join(' and '), scopes = scope.split(' ');
    const canRead = scopes.includes('connector:read') && capabilities.read, canWrite = scopes.includes('connector:write') && capabilities.write;
    const text = [...describeAccess({ grants: g, all, envs, names, scopes, canRead, canWrite, capabilities })];
    text.push(`Session expires after ${idleSeconds} seconds without authorized tool activity${idleSeconds === 3600 ? ' (one hour)' : ''}; it can be revoked locally. Revocation and the kill switch end access.`);
    text.push(maxAgeSeconds ? `Maximum session age: ${maxAgeSeconds} seconds, even with activity.` : 'No absolute maximum session age is configured.');
    return { projectPolicy: all ? 'all' : 'restricted', consent: text.join(' '), idleSeconds, maxAgeSeconds,
      environments: envs.map(e => ({ alias: e.alias, environmentId: e.environmentId, destination: e.destination, projects: e.projects?.map(p => p.name), actions: canWrite ? e.actions.length : 0 })), unavailable: g.unavailable };
  }
  return { grantsFor, async view(tx) { return { clientId: tx.clientId, clientName: tx.clientName, returnsTo: new URL(tx.redirectUri).host, scope: tx.scope, resource: tx.resource, mode: tx.mode, writes: summary(await grantsFor(tx), tx.scope) }; } };
}
