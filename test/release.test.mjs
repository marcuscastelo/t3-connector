import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changelogSection, checkRelease, pack, readInputs, sha256, verifyAsset } from '../scripts/release.mjs';

const CHANGELOG = `# Changelog

## Unreleased

## 1.2.0

- Something new.

## 1.1.0

- Older.
`;

function inputs(over = {}) {
  return {
    tag: 'v1.2.0',
    pkg: { version: '1.2.0' },
    lock: { version: '1.2.0', packages: { '': { version: '1.2.0' } } },
    sources: { 'src/servidor.mjs': '1.2.0', 'src/escrita/ponte-mcp.mjs': '1.2.0' },
    changelog: CHANGELOG,
    ...over,
  };
}

test('changelogSection devolve o corpo até o próximo ##', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.0'), '- Something new.');
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), '- Older.');
  assert.equal(changelogSection(CHANGELOG, 'Unreleased'), '');
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), null);
});

test('release coerente passa', () => {
  assert.deepEqual(checkRelease(inputs()), []);
  assert.deepEqual(checkRelease(inputs({ tag: undefined })), []);
});

test('tag diferente da versão falha', () => {
  assert.match(checkRelease(inputs({ tag: 'v1.2.1' })).join('\n'), /tag v1\.2\.1 ≠ v1\.2\.0/);
  assert.match(checkRelease(inputs({ tag: '1.2.0' })).join('\n'), /tag 1\.2\.0/);
});

test('lock, VERSAO e VERSAO_ESCRITA precisam acompanhar o package.json', () => {
  assert.match(checkRelease(inputs({ lock: { version: '1.2.0', packages: { '': { version: '1.1.0' } } } })).join('\n'), /package-lock/);
  const f = checkRelease(inputs({ sources: { 'src/servidor.mjs': '1.1.0', 'src/escrita/ponte-mcp.mjs': undefined } }));
  assert.equal(f.length, 2);
  assert.match(f[0], /src\/servidor\.mjs declares 1\.1\.0/);
  assert.match(f[1], /ponte-mcp\.mjs declares no version/);
});

test('CHANGELOG precisa da seção da versão, não vazia, e Unreleased vazio', () => {
  assert.match(checkRelease(inputs({ changelog: '# Changelog\n\n## 1.1.0\n\n- x\n' })).join('\n'), /no "## 1\.2\.0" section/);
  assert.match(checkRelease(inputs({ changelog: '## 1.2.0\n\n## 1.1.0\n- x\n' })).join('\n'), /"## 1\.2\.0" is empty/);
  assert.match(checkRelease(inputs({ changelog: `## Unreleased\n\n- pending\n\n${CHANGELOG}` })).join('\n'), /Unreleased" is not empty/);
});

test('só SemVer 2.0.0 sem build metadata passa', () => {
  const comVersao = (v) => checkRelease(inputs({ tag: `v${v}`, pkg: { version: v },
    lock: { version: v, packages: { '': { version: v } } }, sources: {}, changelog: `## ${v}\n\n- x\n` }));
  for (const v of ['1.2.0', '0.6.0', '1.0.0-rc.1', '1.0.0-alpha-1.0']) assert.deepEqual(comVersao(v), [], v);
  for (const v of ['1.2', '01.2.3', '1.2.3-01', '1.2.3-rc..1', '1.2.3+build.1']) assert.match(comVersao(v).join('\n'), /not semver/, v);
});

test('as fontes reais de versão são lidas e concordam com o package.json', () => {
  const { pkg, lock, sources } = readInputs();
  assert.ok(Object.keys(sources).length >= 2);
  for (const [file, v] of Object.entries(sources)) assert.equal(v, pkg.version, file);
  assert.equal(lock.version, pkg.version);
});

test('verifyAsset confere checksum, nome do arquivo e versão do pacote', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'package'));
  writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify({ name: 't3-connector', version: '1.2.0' }));
  const tgz = path.join(dir, 't3-connector-1.2.0.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  writeFileSync(`${tgz}.sha256`, `${sha256(tgz)}  t3-connector-1.2.0.tgz\n`);

  assert.deepEqual(verifyAsset(tgz, '1.2.0'), []);
  assert.match(verifyAsset(tgz, '1.3.0').join('\n'), /artifact version 1\.2\.0, expected 1\.3\.0/);
  writeFileSync(`${tgz}.sha256`, `${'0'.repeat(64)}  t3-connector-1.2.0.tgz\n`);
  assert.match(verifyAsset(tgz, '1.2.0').join('\n'), /does not match/);
  writeFileSync(`${tgz}.sha256`, `${sha256(tgz)}  other.tgz\n`);
  assert.match(verifyAsset(tgz, '1.2.0').join('\n'), /names other\.tgz/);
});

test('pack do repositório gera tgz, .sha256 e notas que verifyAsset aceita', (t) => {
  const out = mkdtempSync(path.join(tmpdir(), 'release-pack-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const real = readInputs();
  const notas = { ...real, changelog: `## ${real.pkg.version}\n\n- notes for the test\n` };
  const { tgz, hash } = pack(out, notas);
  assert.equal(path.basename(tgz), `t3-connector-${real.pkg.version}.tgz`);
  assert.equal(hash, sha256(tgz));
  assert.deepEqual(verifyAsset(tgz, real.pkg.version), []);
  assert.equal(readFileSync(path.join(out, 'release-notes.md'), 'utf8'), '- notes for the test\n');
});
