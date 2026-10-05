// Cliente mínimo do RPC WebSocket do T3 (Effect RPC, JSON), só para chamadas de leitura.
//
// Quadros (observados ao vivo contra o servidor do T3 Code, protocolo de orquestração 2):
//   → {_tag:'Request', id, tag, payload, headers:[]}
//   ← {_tag:'Chunk', requestId, values:[…]}   responder {_tag:'Ack', requestId} a cada Chunk
//   ← {_tag:'Exit', requestId, exit:{_tag:'Success', value} | {_tag:'Failure', cause}}
//   → {_tag:'Interrupt', requestId}            encerra só a própria subscription
// Subscriptions entregam itens em Chunk; RPCs unários entregam o resultado em exit.value.
// Endpoint: /ws?orchestrationProtocol=2&wsTicket=<ticket de uso único>.

import { Cancelada, ErroT3 } from './t3.mjs';

function mensagemDaFalha(exit) {
  const causas = Array.isArray(exit?.cause) ? exit.cause : [exit?.cause];
  for (const c of causas) {
    const erro = c?.error ?? c?.defect;
    if (erro) return erro.message ?? erro._tag ?? JSON.stringify(erro).slice(0, 200);
  }
  return 'failure without detail';
}

function tagDaFalha(exit) {
  const causas = Array.isArray(exit?.cause) ? exit.cause : [exit?.cause];
  for (const c of causas) {
    const erro = c?.error ?? c?.defect;
    if (erro?._tag) return erro._tag;
  }
  return null;
}

function erroDeAbort(signal, mensagemPrazo) {
  return signal.reason?.name === 'TimeoutError' ? new ErroT3(mensagemPrazo, { codigo: 'prazo' }) : new Cancelada();
}

async function abrirSocket({ baseUrl, ticket, signal, WebSocketImpl }) {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', '2');
  url.searchParams.set('wsTicket', ticket);
  const socket = new WebSocketImpl(url.toString());
  await new Promise((resolve, reject) => {
    const aoAbortar = () => { socket.close(); reject(erroDeAbort(signal, 'WS did not open within the call deadline')); };
    if (signal?.aborted) return aoAbortar();
    signal?.addEventListener('abort', aoAbortar, { once: true });
    socket.addEventListener('open', () => { signal?.removeEventListener('abort', aoAbortar); resolve(); }, { once: true });
    socket.addEventListener('error', () => { signal?.removeEventListener('abort', aoAbortar); reject(new ErroT3('T3 WS refused the connection', { codigo: 'indisponivel' })); }, { once: true });
  });
  return socket;
}

const lerQuadro = (data) => {
  try { return JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return null; }
};

/**
 * RPC unário: abre o socket, envia um Request e devolve `exit.value` do Exit de sucesso.
 * O socket é fechado em qualquer saída. Falha tipada do T3 vira ErroT3 com `codigo` igual
 * à `_tag` do erro (ex.: EnvironmentAuthorizationError).
 */
export async function chamar({ baseUrl, ticket, tag, payload, signal, WebSocketImpl = globalThis.WebSocket }) {
  const socket = await abrirSocket({ baseUrl, ticket, signal, WebSocketImpl });
  const id = '1';
  let terminado = false;
  try {
    return await new Promise((resolve, reject) => {
      const aoAbortar = () => reject(erroDeAbort(signal, 'T3 did not answer within the call deadline'));
      if (signal?.aborted) return aoAbortar();
      signal?.addEventListener('abort', aoAbortar, { once: true });
      socket.addEventListener('message', ({ data }) => {
        const msg = lerQuadro(data);
        if (msg?.requestId !== id || msg._tag !== 'Exit') return;
        terminado = true;
        signal?.removeEventListener('abort', aoAbortar);
        if (msg.exit?._tag === 'Success') return resolve(msg.exit.value);
        reject(new ErroT3(`T3 refused ${tag}: ${mensagemDaFalha(msg.exit)}`, { codigo: tagDaFalha(msg.exit) }));
      });
      socket.addEventListener('close', () => {
        if (!terminado) reject(new ErroT3(`T3 WS closed before answering ${tag}`, { codigo: 'indisponivel' }));
      });
      socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    });
  } finally {
    terminado = true;
    socket.close();
  }
}

/**
 * Abre o socket e uma subscription. `aoReceber(values)` recebe cada lote de itens.
 * Retorna {fim: Promise (rejeita em falha/fechamento), encerrar()}.
 */
export async function assinar({ baseUrl, ticket, tag, payload, aoReceber, signal, WebSocketImpl = globalThis.WebSocket }) {
  const socket = await abrirSocket({ baseUrl, ticket, signal, WebSocketImpl });
  const id = '1';
  let encerrado = false;

  const fim = new Promise((resolve, reject) => {
    socket.addEventListener('message', ({ data }) => {
      const msg = lerQuadro(data);
      if (msg?.requestId !== id) return;
      if (msg._tag === 'Chunk') {
        if (!encerrado) socket.send(JSON.stringify({ _tag: 'Ack', requestId: id }));
        try { aoReceber(msg.values ?? []); } catch (e) { reject(e); }
      } else if (msg._tag === 'Exit') {
        if (msg.exit?._tag === 'Success') resolve();
        else reject(new ErroT3(`subscription refused by T3: ${mensagemDaFalha(msg.exit)}`));
      }
    });
    socket.addEventListener('close', () => {
      if (!encerrado) reject(new ErroT3('T3 WS closed during the wait', { codigo: 'indisponivel' }));
    });
  });
  fim.catch(() => {});

  socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));

  return {
    fim,
    encerrar() {
      if (encerrado) return;
      encerrado = true;
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ _tag: 'Interrupt', requestId: id }));
      } catch {}
      socket.close();
    },
  };
}
