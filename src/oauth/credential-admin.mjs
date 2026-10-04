import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { stopwatch } from './session-authority.mjs';
import { CEREMONY_MS } from './passkeys.mjs';
import { boundedObject, limited } from './limits.mjs';

export function credentialAdmin({ localKeys, publicKeys, enrollment, authority, transactions, clock, wall }) {
  const proofs = new Map(), time = stopwatch({ clock, wall });
  const sweep = () => { for (const [id, p] of proofs) if (p.epoch !== authority.epoch || time.elapsed(p.at) >= CEREMONY_MS) proofs.delete(id); };
  authority.onReset(() => proofs.clear());
  const localCount = () => [...localKeys.credentials.keys()].filter(id => localKeys.current(id)).length;
  const list = () => ['local', 'public'].flatMap(rp => [...(rp === 'local' ? localKeys : publicKeys)?.credentials.values() ?? []].map(c => ({ rp, rpID: rp === 'local' ? localKeys.rpID : publicKeys.rpID, credentialId: c.id })));
  return {
    sweep,
    async options(d) {
      boundedObject(d, ['action', 'rp', 'credentialId']); sweep();
      if (!['list', 'enroll-public', 'remove'].includes(d.action)) throw limited('admin_action_invalid', 400);
      if (d.action === 'enroll-public' && (!publicKeys || authority.killed)) throw limited('public_enrollment_unavailable', 400);
      if (d.action === 'remove') {
        const keys = d.rp === 'local' ? localKeys : d.rp === 'public' ? publicKeys : null;
        if (typeof d.credentialId !== 'string' || d.credentialId.length > 2048 || !keys?.current(d.credentialId)) throw limited('credential_unknown', 400);
        if (d.rp === 'local' && localCount() <= 1) throw limited('last_local_credential', 400);
      }
      if (proofs.size >= 16) throw limited('admin_capacity');
      const handle = randomBytes(24).toString('base64url'), challenge = randomBytes(32).toString('base64url');
      const p = { action: d.action, rp: d.rp, credentialId: d.credentialId, challenge, at: time.mark(), epoch: authority.epoch, purpose: 'credential-administration', origin: localKeys.origin, rpID: localKeys.rpID };
      proofs.set(handle, p);
      return { handle, options: await localKeys.options(challenge) };
    },
    async verify(d) {
      boundedObject(d, ['handle', 'response']);
      const p = proofs.get(d.handle); proofs.delete(d.handle);
      const guard = () => { if (!p || p.epoch !== authority.epoch || time.elapsed(p.at) >= CEREMONY_MS) throw limited('admin_proof_invalid', 400); };
      guard();
      await localKeys.verify({ response: d.response, challenge: p.challenge, origin: localKeys.origin, guard }); guard();
      if (p.action === 'list') return { credentials: list() };
      if (p.action === 'enroll-public') {
        const link = enrollment.issue(), modules = QRCode.create(link, { errorCorrectionLevel: 'M' }).modules;
        const rows = Array.from({ length: modules.size }, (_, y) => Array.from({ length: modules.size }, (_, x) => modules.get(y, x) ? [x, y] : null).filter(Boolean)).flat();
        return { link, qr: { size: modules.size, cells: rows }, expiresIn: 900 };
      }
      const keys = p.rp === 'local' ? localKeys : publicKeys;
      if (p.rp === 'local' && localCount() <= 1) throw limited('last_local_credential', 400);
      await keys.remove(p.credentialId, { guard: () => {
        guard();
        if (p.rp === 'local' && ![...localKeys.credentials.keys()].some(id => id !== p.credentialId && localKeys.current(id))) throw limited('last_local_credential', 400);
      }, invalidated: () => {
        authority.revokeCredential(keys.rpID, p.credentialId, keys.origin);
        transactions.cancelCredential(keys.rpID, p.credentialId, keys.origin);
      } });
      return { removed: true, rp: p.rp, credentials: list() };
    },
  };
}
