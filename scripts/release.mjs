#!/usr/bin/env node
// Release checks and packaging. Publishing happens only in .github/workflows/release.yml;
// nothing here talks to GitHub or npm.
//
//   node scripts/release.mjs check [--tag vX.Y.Z]   version, tag, CHANGELOG and VERSAO agree
//   node scripts/release.mjs pack --tag vX.Y.Z --out <dir>
//                                                    check + npm pack + .sha256 + release notes
//   node scripts/release.mjs dry-run [--tag vX.Y.Z]  pack into a temp dir and run the package
//                                                    check against that exact artifact
//   node scripts/release.mjs verify-asset <tgz> --version X.Y.Z
//                                                    downloaded artifact: checksum and version
//
// Without --tag, `check` and `dry-run` use v<package.json version>.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SemVer 2.0.0; build metadata (`+...`) is not supported by this release flow.
const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${IDENT}(?:\\.${IDENT})*)?$`);

// Every place that declares the version, with how to read it.
export const VERSION_SOURCES = [
  ['src/servidor.mjs', /export const VERSAO\s*=\s*'([^']+)'/],
  ['src/escrita/ponte-mcp.mjs', /export const VERSAO_ESCRITA\s*=\s*'([^']+)'/],
];

// Body of the `## <version>` section, or null when the heading is missing.
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// Pure check over already-read inputs; returns the list of failures (empty = ok).
export function checkRelease({ tag, pkg, lock, sources, changelog }) {
  const failures = [];
  const version = pkg.version;
  if (!SEMVER.test(version ?? '')) failures.push(`package.json version "${version}" is not semver (build metadata is not supported)`);
  if (tag !== undefined && tag !== `v${version}`) failures.push(`tag ${tag} ≠ v${version} from package.json`);
  if (lock.version !== version || lock.packages?.['']?.version !== version)
    failures.push(`package-lock.json version ${lock.version}/${lock.packages?.['']?.version} ≠ ${version}`);
  for (const [file, value] of Object.entries(sources))
    if (value !== version) failures.push(`${file} declares ${value ?? 'no version'}, expected ${version}`);
  const section = changelogSection(changelog, version);
  if (section === null) failures.push(`CHANGELOG.md has no "## ${version}" section`);
  else if (!section) failures.push(`CHANGELOG.md section "## ${version}" is empty`);
  const unreleased = changelogSection(changelog, 'Unreleased');
  if (unreleased) failures.push('CHANGELOG.md "## Unreleased" is not empty: move its entries under the release');
  return failures;
}

export function readInputs(root = ROOT) {
  const read = (f) => readFileSync(path.join(root, f), 'utf8');
  const sources = {};
  for (const [file, re] of VERSION_SOURCES) sources[file] = read(file).match(re)?.[1];
  return {
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    sources,
    changelog: read('CHANGELOG.md'),
  };
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// npm pack into `out`, then write `<tgz>.sha256` (shasum -c format) and release-notes.md.
export function pack(out, inputs, root = ROOT) {
  mkdirSync(out, { recursive: true });
  const [info] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const tgz = path.join(out, info.filename);
  const hash = sha256(tgz);
  writeFileSync(`${tgz}.sha256`, `${hash}  ${info.filename}\n`);
  writeFileSync(path.join(out, 'release-notes.md'), `${changelogSection(inputs.changelog, inputs.pkg.version)}\n`);
  return { tgz, hash, files: info.files.length };
}

// A downloaded release asset: the .sha256 next to it must match, and so must the version.
export function verifyAsset(tgz, version) {
  const failures = [];
  const expected = readFileSync(`${tgz}.sha256`, 'utf8').trim().split(/\s+/);
  if (expected[0] !== sha256(tgz)) failures.push(`sha256 of ${path.basename(tgz)} does not match ${path.basename(tgz)}.sha256`);
  if (expected[1] !== path.basename(tgz)) failures.push(`.sha256 names ${expected[1]}, not ${path.basename(tgz)}`);
  const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }));
  if (pkg.name !== 't3-connector') failures.push(`package name ${pkg.name}, expected t3-connector`);
  if (pkg.version !== version) failures.push(`artifact version ${pkg.version}, expected ${version}`);
  return failures;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

function report(failures, ok) {
  // Throws instead of exiting so that `finally` blocks still clean up.
  if (failures.length) throw new Error(`${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join('\n')}`);
  console.log(ok);
}

async function main(argv) {
  const [command, ...args] = argv;
  const inputs = readInputs();
  const tag = option(args, '--tag') ?? (command === 'pack' ? undefined : `v${inputs.pkg.version}`);
  switch (command) {
    case 'check':
      return report(checkRelease({ tag, ...inputs }), `release ${tag} ok: package.json, lock, VERSAO and CHANGELOG agree`);
    case 'pack': {
      const out = option(args, '--out');
      if (!tag || !out) throw new Error('usage: release.mjs pack --tag vX.Y.Z --out <dir>');
      report(checkRelease({ tag, ...inputs }), `release ${tag} ok`);
      const { tgz, hash, files } = pack(path.resolve(out), inputs);
      return console.log(`${path.basename(tgz)}: ${files} files, sha256 ${hash}`);
    }
    case 'dry-run': {
      report(checkRelease({ tag, ...inputs }), `release ${tag} ok`);
      const out = mkdtempSync(path.join(tmpdir(), 't3-connector-release-'));
      try {
        const { tgz, hash } = pack(out, inputs);
        report(verifyAsset(tgz, inputs.pkg.version), `${path.basename(tgz)} sha256 ${hash}`);
        execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-package.mjs'), '--tgz', tgz], { stdio: 'inherit' });
        console.log(`dry run ok: ${tag} would publish ${path.basename(tgz)}, .sha256 and these notes:\n`);
        console.log(readFileSync(path.join(out, 'release-notes.md'), 'utf8'));
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
      return;
    }
    case 'verify-asset': {
      const tgz = args[0];
      const version = option(args, '--version');
      if (!tgz || !version) throw new Error('usage: release.mjs verify-asset <tgz> --version X.Y.Z');
      return report(verifyAsset(path.resolve(tgz), version), `${path.basename(tgz)} ok: checksum and version ${version}`);
    }
    default:
      throw new Error('usage: release.mjs check|pack|dry-run|verify-asset (see header)');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
