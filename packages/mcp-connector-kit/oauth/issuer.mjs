// Splits an issuer into its origin (WebAuthn origin, Host check) and mount path ('' for a bare
// origin). A mount is one or more lowercase segments, no trailing slash; with a mount, every public
// route lives under it and discovery uses RFC 8414 path insertion. Returns null when invalid.
const MOUNT = /^(\/[a-z0-9][a-z0-9-]{0,31})+$/;
export function issuerParts(issuer) {
  let u; try { u = new URL(issuer); } catch { return null; }
  const mount = u.pathname === '/' ? '' : u.pathname;
  if (u.origin + mount !== issuer || (mount && !MOUNT.test(mount))) return null;
  return { origin: u.origin, mount };
}
