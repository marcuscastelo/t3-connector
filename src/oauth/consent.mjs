import { deadline } from './limits.mjs';

// Local views retain their existing order; public callers must establish UV before invoking this.
const freeze = value => { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
export function consentService({ grantProvider, idleSeconds = 3600, maxAgeSeconds = 0 }) {
  const grantsFor = tx => (tx.grants ??= grantProvider && (grantProvider.projectPolicy === 'all' || tx.scope.split(' ').includes('connector:write'))
    ? deadline(Promise.resolve().then(() => grantProvider())).then(value => freeze(structuredClone(value))).catch(() => ({ grants: null, unavailable: [{ reason: 'inventory_failed' }] }))
    : Promise.resolve({ grants: null, unavailable: [] }));
  function summary(g, scope) {
    const all = g.grants?.projectPolicy === 'all', envs = g.grants?.environments ?? [], names = envs.map(e => e.label ?? e.alias).join(' and '), scopes = scope.split(' ');
    const text = [];
    if (scopes.includes('connector:read')) text.push(all ? `Read access to all current and future projects and exposed thread content of ${names}.` : 'Read access follows the configured project allowlist (restricted mode).');
    if (scopes.includes('connector:write')) text.push(all ? `Write access to all current and future projects of ${names}; actions run in full-access mode.` : 'Write access is restricted to the inventory approved for this sign-in; actions run in full-access mode.');
    if (all) text.push('New projects in these environments are included automatically.');
    text.push(`Session expires after ${idleSeconds} seconds without authorized tool activity${idleSeconds === 3600 ? ' (one hour)' : ''}; it can be revoked locally. Revocation and the kill switch end access.`);
    text.push(maxAgeSeconds ? `Maximum session age: ${maxAgeSeconds} seconds, even with activity.` : 'No absolute maximum session age is configured.');
    return { projectPolicy: all ? 'all' : 'restricted', consent: text.join(' '), idleSeconds, maxAgeSeconds,
      environments: envs.map(e => ({ alias: e.alias, environmentId: e.environmentId, destination: e.destination, projects: e.projects?.map(p => p.name), actions: e.actions.length })), unavailable: g.unavailable };
  }
  return { grantsFor, async view(tx) { return { clientId: tx.clientId, clientName: tx.clientName, returnsTo: new URL(tx.redirectUri).host, scope: tx.scope, resource: tx.resource, mode: tx.mode, writes: summary(await grantsFor(tx), tx.scope) }; } };
}
