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
