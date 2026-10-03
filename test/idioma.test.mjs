import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { ambientesFalsos, conectarMcp } from './apoio.mjs';

// Tool and parameter names are the stable API; every human-readable description is English.
const PORTUGUES = /\b(não|para|com|uma|ou|somente|leitura|padrão|obrigatório|ambiente não|pedido|exige)\b/i;

function textos(tools) {
  const saida = [];
  const visitar = (nome, schema) => {
    if (!schema || typeof schema !== 'object') return;
    if (typeof schema.description === 'string') saida.push([nome, schema.description]);
    for (const filho of Object.values(schema.properties ?? {})) visitar(nome, filho);
    for (const ramo of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) visitar(nome, ramo);
  };
  for (const t of tools) {
    for (const s of [t.title, t.description]) if (s) saida.push([t.name, s]);
    visitar(t.name, t.inputSchema);
  }
  return saida;
}

test('read and write MCP descriptions are in English', async () => {
  const leitura = await conectarMcp(ambientesFalsos());
  const servidor = criarPonteEscrita({ relay: async () => ({}), aliases: ['local'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servidor.connect(b);
  const escrita = new Client({ name: 'idioma', version: '1' });
  await escrita.connect(a);
  try {
    const todos = [...textos((await leitura.listTools()).tools), ...textos((await escrita.listTools()).tools)];
    assert.ok(todos.length > 50);
    const ruins = todos.filter(([, t]) => PORTUGUES.test(t));
    assert.deepEqual(ruins, []);
  } finally {
    await escrita.close();
    await servidor.close();
  }
});
