// Cliente mínimo do RPC WebSocket do T3 (Effect RPC, JSON), só para subscriptions de leitura.
//
// Quadros (observados ao vivo contra o servidor do T3 Code, protocolo de orquestração 2):
//   → {_tag:'Request', id, tag, payload, headers:[]}
//   ← {_tag:'Chunk', requestId, values:[…]}   responder {_tag:'Ack', requestId} a cada Chunk
//   ← {_tag:'Exit', requestId, exit:{_tag:'Success'|'Failure', cause}}
//   → {_tag:'Interrupt', requestId}            encerra só a própria subscription
// Endpoint: /ws?orchestrationProtocol=2&wsTicket=<ticket de uso único>.

import { Cancelada, ErroT3 } from './t3.mjs';

function mensagemDaFalha(exit) {
  const causas = Array.isArray(exit?.cause) ? exit.cause : [exit?.cause];
  for (const c of causas) {
    const erro = c?.error ?? c?.defect;
    if (erro) return erro.message ?? erro._tag ?? JSON.stringify(erro).slice(0, 200);
  }
  return 'falha sem detalhe';
}

/**
 * Abre o socket e uma subscription. `aoReceber(values)` recebe cada lote de itens.
 * Retorna {fim: Promise (rejeita em falha/fechamento), encerrar()}.
 */
export async function assinar({ baseUrl, ticket, tag, payload, aoReceber, signal, WebSocketImpl = globalThis.WebSocket }) {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', '2');
  url.searchParams.set('wsTicket', ticket);
  const socket = new WebSocketImpl(url.toString());
  const id = '1';
  let encerrado = false;

  await new Promise((resolve, reject) => {
    const aoAbortar = () => { socket.close(); reject(signal.reason?.name === 'TimeoutError' ? new ErroT3('WS não abriu no prazo da chamada', { codigo: 'prazo' }) : new Cancelada()); };
    if (signal?.aborted) return aoAbortar();
    signal?.addEventListener('abort', aoAbortar, { once: true });
    socket.addEventListener('open', () => { signal?.removeEventListener('abort', aoAbortar); resolve(); }, { once: true });
    socket.addEventListener('error', () => { signal?.removeEventListener('abort', aoAbortar); reject(new ErroT3('WS do T3 recusou a conexão', { codigo: 'indisponivel' })); }, { once: true });
  });

  const fim = new Promise((resolve, reject) => {
    socket.addEventListener('message', ({ data }) => {
      let msg;
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
      if (msg.requestId !== id) return;
      if (msg._tag === 'Chunk') {
        if (!encerrado) socket.send(JSON.stringify({ _tag: 'Ack', requestId: id }));
        try { aoReceber(msg.values ?? []); } catch (e) { reject(e); }
      } else if (msg._tag === 'Exit') {
        if (msg.exit?._tag === 'Success') resolve();
        else reject(new ErroT3(`subscription recusada pelo T3: ${mensagemDaFalha(msg.exit)}`));
      }
    });
    socket.addEventListener('close', () => {
      if (!encerrado) reject(new ErroT3('WS do T3 fechou durante a espera', { codigo: 'indisponivel' }));
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
