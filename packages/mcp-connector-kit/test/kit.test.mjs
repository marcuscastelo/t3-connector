import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { errorResult, jsonResult, strictRegistrar, toolErrorMapper } from '../index.mjs';

class Expected extends Error {}

async function connect(register) {
  const server = new McpServer({ name: 'kit-test', version: '0' });
  register(strictRegistrar(server));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('strictRegistrar refuses unknown parameters and passes known ones', async () => {
  const client = await connect((register) =>
    register('echo', { description: 'echo', shape: { text: z.string() } }, async ({ text }) => jsonResult({ text })));
  const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
  assert.deepEqual(ok.structuredContent, { text: 'hi' });
  assert.equal(JSON.parse(ok.content[0].text).text, 'hi');
  const bad = await client.callTool({ name: 'echo', arguments: { text: 'hi', legacy: 1 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /legacy|unrecognized/i);
  const { tools } = await client.listTools();
  assert.equal(tools[0].inputSchema.additionalProperties, false);
});

test('strictRegistrar accepts a tool without parameters', async () => {
  const client = await connect((register) => register('now', { description: 'now' }, async () => jsonResult({ ok: true })));
  assert.deepEqual((await client.callTool({ name: 'now', arguments: {} })).structuredContent, { ok: true });
});

test('toolErrorMapper passes expected messages and hides the rest behind the fallback', () => {
  const map = toolErrorMapper({ expected: [Expected], fallback: (e) => `failed: ${e.message}` });
  assert.deepEqual(map(new Expected('for the client')), errorResult('for the client'));
  assert.equal(map(new Error('boom')).content[0].text, 'failed: boom');
  assert.equal(map(new Error('boom')).isError, true);
  assert.match(toolErrorMapper()(new Error('x')).content[0].text, /unexpected error: x/);
});
