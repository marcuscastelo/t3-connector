import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHATGPT_CLIENT_ID } from './clients.mjs';
import { parseResourceCapture } from './resource-capture.mjs';
import { LOGIN_MODES } from './authorization-server.mjs';

// Configuration of the OAuth session profile, from environment variables (names below). The issuer
// is the public HTTPS origin of the ingress that forwards to the public listener; it is fixed
// configuration because clients bind tokens and callbacks to it.
export const DEFAULTS = {
  publicPort: 7434,
  localPort: 7435,
  idleSeconds: 3600,
  accessTokenSeconds: 60,
  refreshTokenSeconds: 86400,
  maxAgeSeconds: 0,
  loginMode: 'public',
  clients: [CHATGPT_CLIENT_ID],
  allowedOrigins: ['https://chatgpt.com'],
};

const int = (name, v, min, max) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
};
const list = v => (v === undefined || v === '' ? undefined : v.split(',').map(s => s.trim()).filter(Boolean));

// `prefix` names the environment variables (`<prefix>_ISSUER`, ...); `app` names the default state
// directory (~/.local/state/<app>/oauth). `extend(env, { int, list, prefix })` adds connector-specific
// fields and `validate(cfg, env)` checks them, both before the generic transport checks, so a
// connector keeps its own options outside this package.
export function loadOAuthConfig(env = process.env, { rehearsal = false, prefix = 'MCP_CONNECTOR_OAUTH', app = 'mcp-connector', defaults = {}, extend = () => ({}), validate = () => {} } = {}) {
  const D = { ...DEFAULTS, ...defaults }, P = prefix;
  const issuerRaw = env[`${P}_ISSUER`] ?? (rehearsal ? undefined : null);
  const publicPort = int(`${P}_PUBLIC_PORT`, env[`${P}_PUBLIC_PORT`], 1, 65535) ?? D.publicPort;
  if (issuerRaw === null) throw new Error(`${P}_ISSUER is required (public HTTPS origin of the ingress, e.g. https://connector.example)`);
  const issuer = (issuerRaw ?? `http://localhost:${publicPort}`).replace(/\/$/, '');
  const u = new URL(issuer);
  const localhostHttp = u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !localhostHttp) throw new Error(`${P}_ISSUER must be https (http://localhost only for local rehearsal)`);
  if (u.origin !== issuer) throw new Error(`${P}_ISSUER must be an origin without path, query or fragment`);
  const cfg = {
    ...extend(env, { int, list, prefix: P }),
    issuer,
    publicPort,
    localPort: int(`${P}_LOCAL_PORT`, env[`${P}_LOCAL_PORT`], 1, 65535) ?? D.localPort,
    stateDir: env[`${P}_STATE_DIR`] || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), app, rehearsal ? 'oauth-rehearsal' : 'oauth'),
    idleSeconds: int(`${P}_IDLE_SECONDS`, env[`${P}_IDLE_SECONDS`], 60, 7 * 86400) ?? D.idleSeconds,
    accessTokenSeconds: int(`${P}_ACCESS_TOKEN_SECONDS`, env[`${P}_ACCESS_TOKEN_SECONDS`], 30, 3600) ?? D.accessTokenSeconds,
    refreshTokenSeconds: int(`${P}_REFRESH_TOKEN_SECONDS`, env[`${P}_REFRESH_TOKEN_SECONDS`], 300, 30 * 86400) ?? D.refreshTokenSeconds,
    maxAgeSeconds: int(`${P}_MAX_AGE_SECONDS`, env[`${P}_MAX_AGE_SECONDS`], 0, 365 * 86400) ?? D.maxAgeSeconds,
    loginMode: env[`${P}_LOGIN_MODE`] || (localhostHttp ? 'button' : D.loginMode),
    clients: list(env[`${P}_CLIENTS`]) ?? D.clients,
    allowedOrigins: list(env[`${P}_ALLOWED_ORIGINS`]) ?? D.allowedOrigins,
    verbose: env[`${P}_VERBOSE`] === '1',
    resource: null,
    resourceCapture: parseResourceCapture(env, P),
    tunnelPort: int(`${P}_TUNNEL_PORT`, env[`${P}_TUNNEL_PORT`], 1, 65535) ?? null,
  };
  validate(cfg, env);
  // Tunnel mode: the MCP resource is served on a loopback listener for a Secure MCP Tunnel client,
  // whose hosted discovery names the resource; the issuer stays the public AS origin. The resource
  // is one exact HTTPS URL (compared verbatim everywhere), and both settings go together.
  const exactResource = (name, raw) => {
    let r;
    try { r = new URL(raw); } catch { throw new Error(`${name} must be an absolute https URL`); }
    if (r.protocol !== 'https:' || r.href !== raw || /[?#]/.test(raw) || r.search || r.hash || r.username || r.password || r.pathname === '/') throw new Error(`${name} must be an exact https URL with a path and no query, fragment or credentials`);
    return raw;
  };
  const resourceRaw = env[`${P}_RESOURCE`];
  if (resourceRaw !== undefined && resourceRaw !== '') cfg.resource = exactResource(`${P}_RESOURCE`, resourceRaw);
  // Tunnel mode only: the hosted tunnel rewrites the metadata `resource` to its own endpoint before
  // a client sees it, but tunnel-client's startup discovery reads the local metadata and must be
  // able to reach that origin. When the accepted resource is not reachable from here, advertise a
  // different exact value locally; only <prefix>_RESOURCE is ever accepted.
  const advertisedRaw = env[`${P}_ADVERTISED_RESOURCE`];
  cfg.advertisedResource = null;
  if (advertisedRaw !== undefined && advertisedRaw !== '') {
    if (!cfg.resource) throw new Error(`${P}_ADVERTISED_RESOURCE requires tunnel mode (${P}_RESOURCE)`);
    cfg.advertisedResource = exactResource(`${P}_ADVERTISED_RESOURCE`, advertisedRaw);
  }
  if (Boolean(cfg.resource) !== Boolean(cfg.tunnelPort)) throw new Error(`${P}_RESOURCE and ${P}_TUNNEL_PORT go together (tunnel mode)`);
  if (cfg.tunnelPort && (cfg.tunnelPort === cfg.publicPort || cfg.tunnelPort === cfg.localPort)) throw new Error('the tunnel port must differ from the public and local ports');
  if (!LOGIN_MODES.includes(cfg.loginMode)) throw new Error(`${P}_LOGIN_MODE must be one of ${LOGIN_MODES.join(', ')}`);
  if (cfg.loginMode === 'public' && u.protocol !== 'https:') throw new Error(`${P}_LOGIN_MODE=public requires an https issuer`);
  if (cfg.localPort === cfg.publicPort) throw new Error('public and local ports must differ');
  if (cfg.maxAgeSeconds && cfg.maxAgeSeconds < cfg.idleSeconds) throw new Error(`${P}_MAX_AGE_SECONDS must be 0 (off) or at least the idle window`);
  return cfg;
}
