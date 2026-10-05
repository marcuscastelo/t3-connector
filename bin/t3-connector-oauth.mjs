#!/usr/bin/env node
import { carregarConfigOAuthAll } from '../src/oauth/project-policy.mjs';
// OAuth session profile of the T3 Connector (experimental): MCP over HTTP with an embedded OAuth
// authorization server and a local passkey control-plane. Independent of `t3-connector` (stdio,
// read) and `t3-connector-write` (stdio, passkey lease), which keep working unchanged.
//
//   t3-connector-oauth serve       AS + RS + control-plane with the T3 read tools (read config,
//                                  T3_CONNECTOR_CONFIG) and, when T3_CONNECTOR_OAUTH_WRITE_CONFIG
//                                  points to a write config, the T3 write tools.
//   t3-connector-oauth rehearsal   same OAuth stack with harmless rehearsal tools only (no
//                                  backend). Use it to rehearse a client such as ChatGPT.
//   t3-connector-oauth --version
//
// While running, SIGUSR2 prints a new single-use passkey enrollment ticket to stderr.
//
// Configuration: T3_CONNECTOR_OAUTH_* environment variables, see docs/oauth-session.md.
import { VERSAO } from '../src/servidor.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { createOAuthConnector } from '../src/oauth/connector.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';
import { perRequestSource } from '../src/oauth/resource-server.mjs';
import { t3Tools, parseWriteProjects } from '../src/oauth/t3-tools.mjs';
import { carregarConfig } from '../src/config.mjs';
import { carregarConfigEscrita } from '../src/escrita/config.mjs';

const cmd = process.argv[2];
if (cmd === '--version') { console.log(VERSAO); process.exit(0); }

async function start({ config, tools, serverName, banner }) {
  const connector = createOAuthConnector({ config, tools, serverInfo: { name: serverName, version: VERSAO } });
  const ports = await connector.listen();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => connector.close().then(() => process.exit(0)));
  const lines = [
    `t3-connector-oauth ${VERSAO} (${banner})`,
    ...(ports.tunnelPort
      ? [`  tunnel mode: MCP resource ${connector.resource}`,
         `  tunnel listener: http://127.0.0.1:${ports.tunnelPort}/mcp (point the tunnel client here; loopback only)`,
         `  public listener: 127.0.0.1:${ports.publicPort} (authorization server only; put the HTTPS ingress for ${config.issuer} in front of it)`]
      : [`  MCP URL for the client: ${connector.resource}`,
         `  public listener: 127.0.0.1:${ports.publicPort} (put the HTTPS ingress in front of it)`]),
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
  // A new enrollment ticket without restarting (a restart would end every session). Only a local
  // process of the same user can send the signal; the ticket goes to stderr only.
  process.on('SIGUSR2', () => process.stderr.write(`  enroll a passkey at ${connector.localOrigin}/enroll with ticket: ${connector.enrollment.issue()} (single use, 15 min)\n`));
}

async function rehearsal() {
  const config = loadOAuthConfig(process.env, { rehearsal: true });
  await start({ config, tools: () => ({ sources: [perRequestSource(rehearsalTools())] }), serverName: 't3-connector-oauth-rehearsal', banner: 'rehearsal: no backend, rehearsal tools only' });
}

async function serve() {
  const config = loadOAuthConfig(process.env);
  const readConfig = await (config.projectPolicy === 'all' ? carregarConfigOAuthAll() : carregarConfig());
  const writeFile = process.env.T3_CONNECTOR_OAUTH_WRITE_CONFIG;
  const writeConfig = writeFile ? await carregarConfigEscrita(writeFile) : null;
  const writeProjects = parseWriteProjects(process.env.T3_CONNECTOR_OAUTH_WRITE_PROJECTS);
  if (writeProjects) for (const alias of writeProjects.keys()) if (!writeConfig?.ambientes.some(a => a.alias === alias)) throw new Error(`T3_CONNECTOR_OAUTH_WRITE_PROJECTS: unknown write environment ${alias}`);
  const envs = `read ${readConfig.ambientes.map(a => a.alias).join(', ')}; ${writeConfig ? `write ${writeConfig.ambientes.map(a => a.alias).join(', ')}${writeProjects ? ` (projects limited: ${[...writeProjects].map(([a, ids]) => `${a}=${ids.size}`).join(', ')})` : ''}` : 'no writes (T3_CONNECTOR_OAUTH_WRITE_CONFIG unset)'}`;
  await start({ config, tools: t3Tools({ readConfig, writeConfig, writeProjects, projectPolicy: config.projectPolicy, projectAdmin: config.projectAdmin, nativeTools: config.nativeTools }), serverName: 't3-connector', banner: envs });
}

const commands = { serve, rehearsal };
if (!commands[cmd]) {
  process.stderr.write('usage: t3-connector-oauth serve|rehearsal [--enroll] | --version\n');
  process.exit(2);
}
commands[cmd]().catch(e => { process.stderr.write(`t3-connector-oauth: ${e.message}\n`); process.exit(1); });
