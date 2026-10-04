import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHATGPT_CLIENT_ID } from './clients.mjs';
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
  loginMode: 'button',
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

export function loadOAuthConfig(env = process.env, { rehearsal = false } = {}) {
  const issuerRaw = env.T3_CONNECTOR_OAUTH_ISSUER ?? (rehearsal ? undefined : null);
  const publicPort = int('T3_CONNECTOR_OAUTH_PUBLIC_PORT', env.T3_CONNECTOR_OAUTH_PUBLIC_PORT, 1, 65535) ?? DEFAULTS.publicPort;
  if (issuerRaw === null) throw new Error('T3_CONNECTOR_OAUTH_ISSUER is required (public HTTPS origin of the ingress, e.g. https://connector.example)');
  const issuer = (issuerRaw ?? `http://localhost:${publicPort}`).replace(/\/$/, '');
  const u = new URL(issuer);
  const localhostHttp = u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !localhostHttp) throw new Error('T3_CONNECTOR_OAUTH_ISSUER must be https (http://localhost only for local rehearsal)');
  if (u.origin !== issuer) throw new Error('T3_CONNECTOR_OAUTH_ISSUER must be an origin without path, query or fragment');
  const cfg = {
    issuer,
    publicPort,
    localPort: int('T3_CONNECTOR_OAUTH_LOCAL_PORT', env.T3_CONNECTOR_OAUTH_LOCAL_PORT, 1, 65535) ?? DEFAULTS.localPort,
    stateDir: env.T3_CONNECTOR_OAUTH_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 't3-connector', rehearsal ? 'oauth-rehearsal' : 'oauth'),
    idleSeconds: int('T3_CONNECTOR_OAUTH_IDLE_SECONDS', env.T3_CONNECTOR_OAUTH_IDLE_SECONDS, 60, 7 * 86400) ?? DEFAULTS.idleSeconds,
    accessTokenSeconds: int('T3_CONNECTOR_OAUTH_ACCESS_TOKEN_SECONDS', env.T3_CONNECTOR_OAUTH_ACCESS_TOKEN_SECONDS, 30, 3600) ?? DEFAULTS.accessTokenSeconds,
    refreshTokenSeconds: int('T3_CONNECTOR_OAUTH_REFRESH_TOKEN_SECONDS', env.T3_CONNECTOR_OAUTH_REFRESH_TOKEN_SECONDS, 300, 30 * 86400) ?? DEFAULTS.refreshTokenSeconds,
    maxAgeSeconds: int('T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS', env.T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS, 0, 365 * 86400) ?? DEFAULTS.maxAgeSeconds,
    loginMode: env.T3_CONNECTOR_OAUTH_LOGIN_MODE || DEFAULTS.loginMode,
    clients: list(env.T3_CONNECTOR_OAUTH_CLIENTS) ?? DEFAULTS.clients,
    allowedOrigins: list(env.T3_CONNECTOR_OAUTH_ALLOWED_ORIGINS) ?? DEFAULTS.allowedOrigins,
    verbose: env.T3_CONNECTOR_OAUTH_VERBOSE === '1',
  };
  if (!LOGIN_MODES.includes(cfg.loginMode)) throw new Error(`T3_CONNECTOR_OAUTH_LOGIN_MODE must be one of ${LOGIN_MODES.join(', ')}`);
  if (cfg.localPort === cfg.publicPort) throw new Error('public and local ports must differ');
  if (cfg.maxAgeSeconds && cfg.maxAgeSeconds < cfg.idleSeconds) throw new Error('T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS must be 0 (off) or at least the idle window');
  return cfg;
}
