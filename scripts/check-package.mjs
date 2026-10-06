#!/usr/bin/env node
// Package check: `npm pack`, file allowlist, consistent version, scan for installation-specific
// data, isolated install and a real MCP handshake with the installed binary.
//
//   npm run test:package
//   node scripts/check-package.mjs --tgz <file>   checks an existing artifact instead of packing
//
// Never talks to a real T3 server: the test config points to a loopback port with nothing
// listening, and connections are only opened on demand.

import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tgzArg = process.argv.indexOf('--tgz');
if (tgzArg > 0 && !process.argv[tgzArg + 1]) throw new Error('usage: check-package.mjs [--tgz <file>]');
const given = tgzArg > 0 ? path.resolve(process.argv[tgzArg + 1]) : null;
const tmp = mkdtempSync(path.join(tmpdir(), 't3-connector-package-'));
const failures = [];
const fail = (m) => failures.push(m);
const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]);

try {
  // 1. Artifact and file list: a fresh `npm pack`, or the artifact given with --tgz (release).
  let info;
  if (given) {
    copyFileSync(given, path.join(tmp, path.basename(given)));
    const inner = mkdtempSync(path.join(tmp, 'list-'));
    execFileSync('tar', ['-xzf', given, '-C', inner]);
    const manifest = JSON.parse(readFileSync(path.join(inner, 'package', 'package.json'), 'utf8'));
    info = { name: manifest.name, version: manifest.version, filename: path.basename(given), size: statSync(given).size,
      files: walk(path.join(inner, 'package')).map((p) => ({ path: p })) };
  } else {
    [info] = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp], ROOT));
  }
  const files = info.files.map((f) => f.path).sort();
  const allowed = [/^bin\/[\w-]+\.mjs$/, /^src\/((escrita|oauth)\/)?[\w-]+\.mjs$/, /^web\/[\w-]+\.(js|html)$/,
    /^examples\/config\.json$/, /^examples\/oauth-all-projects\.env$/, /^docs\/adr\/\d{4}-[\w-]+\.md$/,
    /^(README|SECURITY|CHANGELOG)\.md$/, /^LICENSE$/, /^package\.json$/,
    // Shared MCP plumbing (packages/mcp-connector-kit), bundled so the release stays one artifact.
    /^node_modules\/mcp-connector-kit\/(((oauth|testing)\/)?[\w-]+\.mjs|package\.json|README\.md|LICENSE)$/];
  for (const f of files) if (!allowed.some((r) => r.test(f))) fail(`file outside the allowlist: ${f}`);
  for (const f of ['bin/t3-connector.mjs', 'bin/t3-connector-write.mjs', 'bin/t3-connector-oauth.mjs', 'LICENSE', 'README.md', 'SECURITY.md', 'web/aprovacao.html', 'node_modules/mcp-connector-kit/index.mjs', 'node_modules/mcp-connector-kit/oauth/connector.mjs'])
    if (!files.includes(f)) fail(`required file missing: ${f}`);
  if (info.name !== 't3-connector') fail(`package name ${info.name}, expected t3-connector`);
  if (info.version !== pkg.version) fail(`artifact version ${info.version} ≠ package.json ${pkg.version}`);
  const tgz = path.join(tmp, info.filename);

  // 2. Scan the packed content: no IDs, hosts or paths from a real installation.
  const extracted = path.join(tmp, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', tgz, '-C', extracted]);
  const suspicious = [
    [/\b(?!00000000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'UUID that is not a placeholder'],
    [/\b[\w-]+\.tail[0-9a-f]+\.ts\.net\b/i, 'tailnet hostname'],
    [/\/Users\/(?!dev\b)[\w.-]+|\/home\/(?!dev\b)[\w.-]+/, 'real home directory path'],
    [/\btunnel_[0-9a-f]{32}\b/, 'real tunnel_id'],
    [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  ];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      const text = readFileSync(p, 'utf8');
      for (const [re, kind] of suspicious) if (re.test(text)) fail(`${kind} in ${path.relative(extracted, p)}`);
    }
  };
  scan(extracted);

  // 3. Isolated install of the artifact: production dependencies only, no scripts.
  const target = path.join(tmp, 'installed');
  mkdirSync(target);
  writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'package-check', private: true }));
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], target);
  const binDir = path.join(target, 'node_modules', '.bin');
  for (const bin of ['t3-connector', 't3-connector-write', 't3-connector-oauth']) {
    const v = execFileSync(path.join(binDir, bin), ['--version'], { encoding: 'utf8' }).trim();
    if (v !== pkg.version) fail(`${bin} --version = ${v}, expected ${pkg.version}`);
  }

  // 4. CLI and MCP handshake with the installed binary and a fictitious config (no real T3).
  const token = path.join(tmp, 'local.token');
  writeFileSync(token, 'fictitious-token\n', { mode: 0o600 });
  const config = path.join(tmp, 'config.json');
  writeFileSync(config, JSON.stringify({ default: 'local', environments: { local: {
    environmentId: '00000000-0000-4000-8000-000000000001', url: 'http://127.0.0.1:9', tokenFile: token,
    allowedProjects: ['00000000-0000-4000-8000-0000000000a1'] } } }));
  const env = { ...process.env, T3_CONNECTOR_CONFIG: config, HOME: tmp };
  const listed = JSON.parse(execFileSync(path.join(binDir, 't3-connector'), ['environments'], { encoding: 'utf8', env }));
  if (listed.default !== 'local' || listed.environments?.[0]?.available !== false) fail('`t3-connector environments` did not list the unreachable test environment');

  const sdk = (sub) => pathToFileURL(path.join(target, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', sub)).href;
  const { Client } = await import(sdk('client/index.js'));
  const { StdioClientTransport } = await import(sdk('client/stdio.js'));
  const transport = new StdioClientTransport({ command: path.join(binDir, 't3-connector'), args: ['serve'], env, stderr: 'pipe' });
  const client = new Client({ name: 'check-package', version: '0' });
  await client.connect(transport);
  const server = client.getServerVersion();
  if (server?.name !== 't3-connector' || server?.version !== pkg.version) fail(`MCP server announces ${server?.name} ${server?.version}`);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ['t3_aguardar_thread', 't3_ambientes', 't3_atencao', 't3_buscar_threads', 't3_control_plane', 't3_mensagens', 't3_projetos', 't3_providers', 't3_thread', 't3_thread_read_batch', 't3_threads'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tools: ${names.join(', ')}`);
  if (tools.some((t) => t.annotations?.readOnlyHint !== true)) fail('read tool without readOnlyHint');
  // Public descriptions and parameter names are in English (legacy names are hidden aliases); tool names are unchanged.
  const portuguese = /\b(não|para|com|uma|ou|somente|leitura|padrão|obrigatório)\b/i;
  for (const t of tools) {
    const legacy = Object.keys(t.inputSchema?.properties ?? {}).filter((k) => ['ambiente', 'busca', 'limite', 'estado', 'incluirSemExecucao', 'correspondencia', 'maxCaracteres', 'incluirUltimaResposta', 'verificar'].includes(k));
    if (legacy.length) fail(`legacy parameter names listed in ${t.name}: ${legacy.join(', ')}`);
    const texts = [t.title, t.description, ...Object.values(t.inputSchema?.properties ?? {}).map((p) => p.description)];
    for (const text of texts.filter(Boolean)) if (portuguese.test(text)) fail(`non-English description in ${t.name}: ${text.slice(0, 60)}`);
  }
  await client.close();

  // 5. OAuth session profile from the installed artifact (bundled mcp-connector-kit): rehearsal mode
  // on loopback, no backend. Discovery metadata keeps the T3 names and /mcp challenges without a token.
  const freePort = () => new Promise((ok, ko) => { const s = net.createServer(); s.once('error', ko); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
  const [publicPort, localPort] = [await freePort(), await freePort()];
  const oauth = spawn(path.join(binDir, 't3-connector-oauth'), ['rehearsal'], { env: { ...env, T3_CONNECTOR_OAUTH_PUBLIC_PORT: String(publicPort), T3_CONNECTOR_OAUTH_LOCAL_PORT: String(localPort), T3_CONNECTOR_OAUTH_STATE_DIR: path.join(tmp, 'oauth-state') }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let banner = '';
    await new Promise((ok, ko) => {
      const timer = setTimeout(() => ko(new Error(`t3-connector-oauth rehearsal did not start: ${banner}`)), 15000);
      oauth.stderr.on('data', (d) => { banner += d; if (banner.includes('local control')) { clearTimeout(timer); ok(); } });
      oauth.once('exit', (code) => { clearTimeout(timer); ko(new Error(`t3-connector-oauth rehearsal exited ${code}: ${banner}`)); });
    });
    const base = `http://localhost:${publicPort}`, get = (p) => fetch(base + p, { headers: { host: `localhost:${publicPort}` } });
    const as = await (await get('/.well-known/oauth-authorization-server')).json();
    if (as.issuer !== base || !as.code_challenge_methods_supported?.includes('S256')) fail(`OAuth AS metadata: ${JSON.stringify(as).slice(0, 200)}`);
    const prm = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
    if (prm.resource_name !== 'T3 Connector' || prm.resource !== `${base}/mcp`) fail(`protected resource metadata: ${JSON.stringify(prm).slice(0, 200)}`);
    const challenge = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    if (challenge.status !== 401 || !/^Bearer resource_metadata=/.test(challenge.headers.get('www-authenticate') ?? '')) fail(`/mcp without a token answered ${challenge.status}`);
  } finally {
    oauth.kill('SIGTERM');
  }

  if (failures.length) {
    console.error(`artifact ${info.filename}: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`artifact ${info.filename} ok: ${files.length} files, ${(info.size / 1024).toFixed(1)} kB, ` +
      `isolated install, CLI and MCP handshake (${names.length} tools), OAuth rehearsal discovery and challenge`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
