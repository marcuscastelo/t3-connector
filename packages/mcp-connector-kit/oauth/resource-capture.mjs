import { openSync, writeSync, closeSync, renameSync, lstatSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Temporary, opt-in diagnostic for setting up tunnel mode: the hosted tunnel names the MCP resource
// and /authorize refuses any other value, logging only its hash. With both settings present, the
// refused value is ALSO written to one local file, but only when it passes the conservative shape
// below (canonical https URL, unreserved path characters only, the tunnel ID as a whole path
// segment, at most 512 characters); nothing else a request carries is persisted. Use a private
// directory reserved for this diagnostic, under trusted ancestors (the check is on the immediate
// directory only). The refusal itself is unchanged. Remove the
// settings (and the file) once the resource is configured.
const TUNNEL_ID = /^tunnel_[A-Za-z0-9]+$/;

export function parseResourceCapture(env, prefix = 'MCP_CONNECTOR_OAUTH') {
  const file = env[`${prefix}_RESOURCE_CAPTURE_FILE`], match = env[`${prefix}_RESOURCE_CAPTURE_MATCH`];
  if (!file && !match) return null;
  if (!file || !match) throw new Error(`${prefix}_RESOURCE_CAPTURE_FILE and ${prefix}_RESOURCE_CAPTURE_MATCH go together`);
  if (!isAbsolute(file)) throw new Error(`${prefix}_RESOURCE_CAPTURE_FILE must be an absolute path`);
  if (!TUNNEL_ID.test(match)) throw new Error(`${prefix}_RESOURCE_CAPTURE_MATCH must be a tunnel ID (tunnel_…)`);
  return { file, match };
}

// Returns the value when it qualifies for capture, otherwise null. Conservative on purpose: the value
// must already be in canonical form (no parser repair: backslashes, empty userinfo, IDN, unicode),
// lowercase https host with an optional port, a path of unreserved characters only (no percent
// encoding, so no encoded query/fragment/control payload), the tunnel ID as one whole path segment,
// and at most 512 characters. This is a request-supplied candidate, not trusted discovery.
const SHAPE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)+$/;
export function capturableResource(value, match) {
  if (typeof value !== 'string' || value.length > 512 || !SHAPE.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.href !== value || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  return u.pathname.split('/').includes(match) ? value : null;
}

export function resourceCapture(settings, { now = () => new Date(), random = randomBytes } = {}) {
  if (!settings) return () => false;
  return value => {
    const resource = capturableResource(value, settings.match);
    if (!resource) return false;
    let owned = null, fd = null;
    try {
      const dir = dirname(settings.file), d = lstatSync(dir);
      if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== process.getuid() || (d.mode & 0o077)) return false;
      const tmp = join(dir, `.resource-capture-${random(6).toString('hex')}`);
      fd = openSync(tmp, 'wx', 0o600);   // exclusive: an existing file is never ours to remove
      owned = tmp;
      writeSync(fd, JSON.stringify({ t: now().toISOString(), resource }) + '\n');
      closeSync(fd); fd = null;
      renameSync(owned, settings.file);
      owned = null;
      return true;
    } catch { return false; } finally {
      // Best effort: remove only the temporary file this attempt created and did not publish. An
      // interrupted process or a failed unlink can still leave one; see docs/oauth-session.md.
      if (fd !== null) try { closeSync(fd); } catch {}
      if (owned) try { rmSync(owned, { force: true }); } catch {}
    }
  };
}
