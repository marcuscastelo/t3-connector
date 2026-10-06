// Regressão dos intermitentes oauth-public/oauth-removal: outro arquivo de teste toma a porta entre
// freePort() e listen(). Antes, listen() falhava com EADDRINUSE com o listener público já aberto e
// o processo do teste nunca terminava (hang). O fixture fecha o parcial e tenta outras portas.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { publicFixture } from './oauth-public-fixtures.mjs';
import { freePort } from './oauth-apoio.mjs';

test('publicFixture: porta tomada por outro processo → fecha o parcial e sobe em portas novas', async (t) => {
  const tomada = await freePort();
  const intruso = createServer((_q, s) => s.end('intruso'));
  await new Promise((r) => intruso.listen(tomada, '127.0.0.1', r));
  t.after(() => new Promise((r) => intruso.close(r)));
  for (const firstPorts of [[await freePort(), tomada], [tomada, await freePort()]]) {
    const f = await publicFixture(t, { firstPorts });
    assert.notEqual(f.cfg.localPort, tomada);
    assert.notEqual(f.cfg.publicPort, tomada);
    // O conector que subiu responde (o enroll do fixture já usou a porta local nova).
    const page = await f.request('/enroll');
    assert.notEqual(page.text, 'intruso');
  }
});
