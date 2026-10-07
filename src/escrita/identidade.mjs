import { issuerParts } from 'mcp-connector-kit/oauth/issuer';
const trusted = new WeakSet();
// Only for the inert local gate exercise; never represents a remote MCP caller.
export function identidadeTesteLocal(bootId) {
  const identity=Object.freeze({subject:'teste-local-sem-T3',binding:`local-inert:${bootId}`});
  trusted.add(identity);return identity;
}
// Called by trusted bootstrap after validating the private relay capability.
// Identifies a configured channel, never an individual user of SecureTunnel.
// Estável entre boots: entra na chave de dedupe do journal. O boot fica só na lease.
export function identidadeCanal({organization,tunnelId}) {
  if(!organization||!/^tunnel_[a-zA-Z0-9]+$/.test(tunnelId))throw new Error('channel_binding_invalid');
  const identity=Object.freeze({subject:`canal:${organization}`,binding:`securetunnel:${tunnelId}`});
  trusted.add(identity);return identity;
}
// OAuth session profile (src/oauth/): the subject comes from the local passkey enrollment and the
// issuer is the connector's own configured issuer, both resolved server side from a verified access
// token, never from tool arguments. Stable across refresh and new sign-ins, so the journal dedupe
// key survives them; it never matches a channel or mTLS identity, so lease grants do not apply.
export function identidadeSessaoOAuth({issuer,subject}) {
  // Same issuer rule as the OAuth server (mcp-connector-kit): an origin, optionally with a mount path.
  const parts=typeof issuer==='string'?issuerParts(issuer):null;
  if(!parts||!/^https?:\/\//.test(parts.origin)||typeof subject!=='string'||!/^local:[A-Za-z0-9_-]{8,}$/.test(subject))throw new Error('oauth_identity_invalid');
  const identity=Object.freeze({subject:`oauth:${subject}`,binding:`oauth-issuer:${issuer}`});
  trusted.add(identity);return identity;
}
export function identidadeMTLS(request, allowedFingerprints) {
  const socket = request.socket;
  if (!socket.encrypted || socket.authorized !== true) throw new Error('caller_unverified');
  const cert = socket.getPeerCertificate();
  const subject = allowedFingerprints.get(cert.fingerprint256);
  if (!subject) throw new Error('caller_unverified');
  const identity = Object.freeze({ subject, binding: `mtls:${cert.fingerprint256}` });
  trusted.add(identity);
  return identity;
}
export function exigirIdentidade(identity) {
  if (!trusted.has(identity)) throw new Error('caller_unverified');
  return `${identity.subject}|${identity.binding}`;
}
