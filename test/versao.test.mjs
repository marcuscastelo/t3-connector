import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSAO } from '../src/servidor.mjs';
import { VERSAO_ESCRITA } from '../src/escrita/ponte-mcp.mjs';

test('versões anunciadas pelos MCPs são as do package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSAO, pkg.version);
  assert.equal(VERSAO_ESCRITA, pkg.version);
});
