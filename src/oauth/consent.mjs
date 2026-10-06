// T3 wording of the OAuth consent (projects, environments, threads); the consent service itself is
// in mcp-connector-kit.
import { consentService as base } from 'mcp-connector-kit/oauth/consent';
export * from 'mcp-connector-kit/oauth/consent';

export function t3Access({ all, envs, names, scopes, canRead, canWrite, capabilities }) {
  const text = [];
  if (canRead) text.push(all ? `Read access to all current and future projects and exposed thread content of ${names}.` : 'Read access follows the configured project allowlist (restricted mode).');
  if (canWrite) text.push(all ? `Write access to all current and future projects of ${names}; actions may run up to full-access mode (the default).` : 'Write access is restricted to the inventory approved for this sign-in; actions may run up to full-access mode (the default).');
  if (canWrite && envs.some(e => e.actions?.includes('project.delete-force'))) text.push('Write access includes deleting projects: empty projects, and, only on an explicit request with force, a project together with its threads.');
  else if (canWrite && envs.some(e => e.actions?.includes('project.delete'))) text.push('Write access includes deleting empty projects.');
  if (canWrite && envs.some(e => e.actions?.includes('t3_project_create'))) text.push('Write access includes native T3 operations: creating, updating and cloning projects, changing environment preferences, and creating, changing, deleting and running scheduled tasks.');
  if (scopes.includes('connector:write') && !capabilities.write) text.push('Writing is unavailable: this deployment offers no write tools.');
  if (all && (canRead || canWrite)) text.push('New projects in these environments are included automatically.');
  return text;
}

export const consentService = opts => base({ describeAccess: t3Access, ...opts });
