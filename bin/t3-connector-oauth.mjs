#!/usr/bin/env node
// OAuth session profile of the T3 Connector (experimental): MCP over HTTP with an embedded OAuth
// authorization server and a local passkey control-plane. Independent of `t3-connector` (stdio,
// read) and `t3-connector-write` (stdio, passkey lease), which keep working unchanged.
//
//   t3-connector-oauth rehearsal   AS + RS + control-plane with harmless rehearsal tools only
//                                  (no backend). Use it to rehearse a client such as ChatGPT.
//   t3-connector-oauth --version
//
// Configuration: T3_CONNECTOR_OAUTH_* environment variables, see docs/oauth-session.md.
import { VERSAO } from '../src/servidor.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { createOAuthConnector } from '../src/oauth/connector.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';

const cmd = process.argv[2];
if (cmd === '--version') { console.log(VERSAO); process.exit(0); }

async function rehearsal() {
  const config = loadOAuthConfig(process.env, { rehearsal: true });
  const connector = createOAuthConnector({ config, registerTools: rehearsalTools(), serverInfo: { name: 't3-connector-oauth-rehearsal', version: VERSAO } });
  const ports = await connector.listen();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => connector.close().then(() => process.exit(0)));
  const lines = [
    `t3-connector-oauth ${VERSAO} (rehearsal: no backend, rehearsal tools only)`,
    `  MCP URL for the client: ${connector.resource}`,
    `  public listener: 127.0.0.1:${ports.publicPort} (put the HTTPS ingress in front of it)`,
    `  local control:   ${connector.localOrigin}/ (loopback only; never expose it)`,
    `  sessions: idle ${config.idleSeconds}s, access token ${config.accessTokenSeconds}s, login mode ${config.loginMode}`,
    `  state: ${config.stateDir}`,
  ];
  if (connector.authority.killed) lines.push('  KILL SWITCH IS ON: release it at the local control page (needs a passkey).');
  if (!connector.passkeys.credentials.size || process.argv.includes('--enroll')) {
    const ticket = connector.enrollment.issue();
    lines.push(`  enroll a passkey at ${connector.localOrigin}/enroll with ticket: ${ticket} (single use, 15 min)`);
  }
  process.stderr.write(lines.join('\n') + '\n');
}

const commands = { rehearsal };
if (!commands[cmd]) {
  process.stderr.write('usage: t3-connector-oauth rehearsal [--enroll] | --version\n');
  process.exit(2);
}
commands[cmd]().catch(e => { process.stderr.write(`t3-connector-oauth: ${e.message}\n`); process.exit(1); });
