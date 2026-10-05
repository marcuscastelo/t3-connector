// T3 Connector OAuth configuration: the generic loader from mcp-connector-kit with the
// T3_CONNECTOR_OAUTH_ prefix, the t3-connector state directory and the T3 project options.
import { loadOAuthConfig as base } from 'mcp-connector-kit/oauth/config';
export * from 'mcp-connector-kit/oauth/config';

const t3Options = env => ({
  projectPolicy: env.T3_CONNECTOR_OAUTH_PROJECTS || 'restricted',
  // Opt-in project deletion tools (OAuth all only); off unless exactly "1".
  projectAdmin: env.T3_CONNECTOR_OAUTH_PROJECT_ADMIN === '1',
  // Opt-in thin wrappers over native T3 MCP tools (OAuth all only); off unless exactly "1".
  nativeTools: env.T3_CONNECTOR_OAUTH_NATIVE_TOOLS === '1',
});

function validateT3(cfg, env) {
  if (!['all', 'restricted'].includes(cfg.projectPolicy)) throw new Error('T3_CONNECTOR_OAUTH_PROJECTS must be all or restricted');
  if (cfg.nativeTools && cfg.projectPolicy !== 'all') throw new Error('T3_CONNECTOR_OAUTH_NATIVE_TOOLS=1 requires T3_CONNECTOR_OAUTH_PROJECTS=all');
  if (cfg.projectAdmin && cfg.projectPolicy !== 'all') throw new Error('T3_CONNECTOR_OAUTH_PROJECT_ADMIN=1 requires T3_CONNECTOR_OAUTH_PROJECTS=all');
  if (cfg.projectPolicy === 'all' && env.T3_CONNECTOR_OAUTH_WRITE_PROJECTS) throw new Error('T3_CONNECTOR_OAUTH_PROJECTS=all conflicts with T3_CONNECTOR_OAUTH_WRITE_PROJECTS');
}

export function loadOAuthConfig(env = process.env, { rehearsal = false } = {}) {
  return base(env, { rehearsal, prefix: 'T3_CONNECTOR_OAUTH', app: 't3-connector', extend: t3Options, validate: validateT3 });
}
