import { writeFileSync, renameSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Temporary, opt-in diagnostic for setting up tunnel mode: the hosted tunnel names the MCP resource
// and /authorize refuses any other value, logging only its hash. With both settings present, the
// refused value is ALSO written to one local file, but only when it is a plain https URL (no
// query, fragment or credentials, at most 512 characters) that contains the configured tunnel ID,
// so nothing else a request carries is ever persisted. The refusal itself is unchanged. Remove the
// settings (and the file) once the resource is configured.
const TUNNEL_ID = /^tunnel_[A-Za-z0-9]+$/;

export function parseResourceCapture(env) {
  const file = env.T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE, match = env.T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH;
  if (!file && !match) return null;
  if (!file || !match) throw new Error('T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE and T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH go together');
  if (!isAbsolute(file)) throw new Error('T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE must be an absolute path');
  if (!TUNNEL_ID.test(match)) throw new Error('T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH must be a tunnel ID (tunnel_…)');
  return { file, match };
}

// Returns the normalized value when it qualifies for capture, otherwise null.
export function capturableResource(value, match) {
  if (typeof value !== 'string' || value.length > 512 || /[?#\s]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  return u.href.includes(match) ? u.href : null;
}

export function resourceCapture(settings, { now = () => new Date() } = {}) {
  if (!settings) return () => false;
  return value => {
    const resource = capturableResource(value, settings.match);
    if (!resource) return false;
    try {
      const dir = dirname(settings.file), d = lstatSync(dir);
      if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== process.getuid() || (d.mode & 0o077)) return false;
      const tmp = join(dir, `.resource-capture-${randomBytes(6).toString('hex')}`);
      writeFileSync(tmp, JSON.stringify({ t: now().toISOString(), resource }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, settings.file);
      return true;
    } catch { return false; }
  };
}
