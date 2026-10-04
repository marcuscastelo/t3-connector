import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { MAX_CREDENTIALS, TRANSPORTS } from './passkeys.mjs';

export function credentialStorage(stateDir, issuer) {
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error('credential_storage_invalid');
  const localFile = join(stateDir, 'passkeys.json'), publicFile = join(stateDir, 'passkeys-public.json');
  const load = file => {
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid() || s.size > 128 * 1024) throw new Error('credential_storage_invalid');
    let value; try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('credential_storage_invalid'); }
    return value;
  };
  if (!existsSync(localFile) && existsSync(publicFile)) throw new Error('canonical_subject_missing');
  const local = existsSync(localFile) ? load(localFile) : { subject: `local:${randomBytes(12).toString('base64url')}`, credentials: [] };
  if (!/^local:[A-Za-z0-9_-]{12,128}$/.test(local.subject ?? '')) throw new Error('credential_subject_invalid');
  const decode = value => {
    if (!Array.isArray(value.credentials) || value.credentials.length > MAX_CREDENTIALS) throw new Error('credential_storage_invalid');
    const map = new Map();
    for (const c of value.credentials) {
      if (!c || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(c.id) || typeof c.publicKey !== 'string' || !/^[A-Za-z0-9_-]{1,16384}$/.test(c.publicKey) || !Number.isSafeInteger(c.counter) || c.counter < 0 || map.has(c.id) || (c.transports !== undefined && (!Array.isArray(c.transports) || c.transports.length > 8 || c.transports.some(t => !TRANSPORTS.includes(t))))) throw new Error('credential_storage_invalid');
      const publicKey = new Uint8Array(Buffer.from(c.publicKey, 'base64url'));
      try { const cose = decodeCredentialPublicKey(publicKey); if (!(cose instanceof Map) || !cose.has(1) || !cose.has(3)) throw new Error(); } catch { throw new Error('credential_storage_invalid'); }
      map.set(c.id, { ...c, publicKey });
    }
    return map;
  };
  const persist = (file, tags, next) => {
    const tmp = `${file}.next`;
    if (existsSync(tmp)) { const s = lstatSync(tmp); if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('credential_storage_invalid'); }
    const serialized = JSON.stringify({ ...tags, subject: local.subject, credentials: [...next.values()].map(c => ({ ...c, publicKey: Buffer.from(c.publicKey).toString('base64url') })) });
    if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error('credential_storage_capacity');
    writeFileSync(tmp, serialized, { mode: 0o600 });
    renameSync(tmp, file);
  };
  const localCredentials = decode(local);
  if (!existsSync(localFile)) persist(localFile, {}, localCredentials);
  let publicStore = null;
  if (issuer.startsWith('https://')) {
    const tags = { schemaVersion: 1, origin: issuer, rpID: new URL(issuer).hostname };
    const stored = existsSync(publicFile) ? load(publicFile) : { ...tags, subject: local.subject, credentials: [] };
    if (stored.schemaVersion !== tags.schemaVersion || stored.origin !== tags.origin || stored.rpID !== tags.rpID || stored.subject !== local.subject) throw new Error('public_credential_storage_mismatch');
    const credentials = decode(stored);
    if (!existsSync(publicFile)) persist(publicFile, tags, credentials);
    publicStore = { credentials, persist: next => persist(publicFile, tags, next) };
  } else if (existsSync(publicFile)) throw new Error('public_credential_storage_mismatch');
  return { subject: local.subject, local: { credentials: localCredentials, persist: next => persist(localFile, {}, next) }, public: publicStore };
}
