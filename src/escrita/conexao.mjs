// Conexão de escrita com o servidor T3 de UM environment: HTTP para identidade, shell e
// ticket; WS V2 para mutação. Token read+operate próprio do environment.
//
// O WS abre sob demanda (adapter.prepare, antes da checagem final do gate). Se cair, as
// operações pendentes ficam incertas (StagingRpcTransport.fail) e só operações NOVAS
// abrem outro socket: nada é reenviado.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { criarCliente, ErroT3, verificarIdentidade } from '../t3.mjs';
import { criarTransporteSsh, criarTransporteUrl } from '../transporte.mjs';
import { StagingRpcTransport, projectReceipt } from './transport-staging.mjs';
import { lerOcupacao } from './project-admin.mjs';
import { lerObservacao } from '../settlement.mjs';
import { derivarExecucao } from '../execucao.mjs';

export const ESCOPOS_ESCRITA = ['orchestration:operate', 'orchestration:read'];

export function lerTokenPrivado(arquivo) {
  for (const p of [arquivo.replace(/\/[^/]+$/, ''), arquivo]) {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('token_permissions_invalid');
  }
  const token = readFileSync(arquivo, 'utf8').trim();
  if (!token) throw new Error('token_permissions_invalid');
  return token;
}

const aspas = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** realpath no host SSH do environment: a verificação roda no domínio de execução. */
export function realpathRemoto(host, caminho, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForwardAgent=no',
      host, `realpath -e -- ${aspas(caminho)}`], { timeout: 15000 }, (erro, stdout) => resolve(erro ? null : String(stdout).trim()));
  });
}

export function criarConexaoEscrita(registro, {
  transporte = registro.ssh ? criarTransporteSsh(registro.ssh) : criarTransporteUrl(registro.url),
  lerToken = lerTokenPrivado,
  criarClienteImpl = criarCliente,
  WebSocketImpl = globalThis.WebSocket,
  realpathRemotoImpl = realpathRemoto,
  aoFalhar = () => {},
} = {}) {
  let estado = null; // {cliente, info, token, base}
  let rpc = null;

  async function abrir() {
    if (estado) return estado;
    const base = await transporte.baseUrl({ signal: AbortSignal.timeout(20000) });
    const token = lerToken(registro.tokenFile);
    const cliente = criarClienteImpl({ url: base, token });
    const info = await verificarIdentidade(cliente, { environmentIdEsperado: registro.environmentId, escoposExatos: ESCOPOS_ESCRITA });
    estado = { cliente, info, token, base };
    return estado;
  }

  function descartar() {
    estado = null;
    rpc = null;
    transporte.descartar();
  }

  /**
   * Leitura HTTP (GET) com uma repetição se o transporte caiu: o ssh até o Remoto pode
   * morrer e deixar a porta antiga sem resposta. Nunca usado para mutação.
   */
  async function lerComRetry(fn) {
    for (let tentativa = 0; ; tentativa++) {
      const e = await abrir().catch((erro) => { descartar(); throw erro; });
      try {
        return await fn(e.cliente);
      } catch (erro) {
        if (erro instanceof ErroT3 && erro.codigo === 'indisponivel') { descartar(); if (tentativa === 0) continue; }
        throw erro;
      }
    }
  }
  const clienteLeitura = {
    shell: (o) => lerComRetry((c) => c.shell(o)),
    thread: (id, o) => lerComRetry((c) => c.thread(id, o)),
    threadCompleto: (id, o) => lerComRetry((c) => c.threadCompleto(id, o)),
    projetos: (o) => lerComRetry((c) => c.projetos(o)),
    ambiente: (o) => lerComRetry((c) => c.ambiente(o)),
  };

  async function prepararSocket() {
    if (rpc?.available) return rpc;
    const { cliente, base } = await abrir().catch((e) => { descartar(); throw e; });
    let ticket;
    try {
      ticket = await cliente.ticketWs({ signal: AbortSignal.timeout(10000) });
    } catch {
      descartar();
      throw new Error('ambiente_indisponivel');
    }
    const url = new URL('/ws', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    url.searchParams.set('wsTicket', ticket);
    const socket = new WebSocketImpl(url.toString());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('ambiente_indisponivel')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ambiente_indisponivel')); }, { once: true });
    }).catch((e) => { descartar(); throw e; });
    const atual = new StagingRpcTransport({
      socket,
      allowLoopback: true,
      onFailure: () => {
        if (rpc === atual) { rpc = null; estado = null; transporte.descartar(); }
        aoFalhar(registro.alias);
      },
    });
    rpc = atual;
    return atual;
  }

  return {
    registro,
    /** Identidade e escopos verificados (abre a conexão HTTP se preciso). */
    verificar: async () => (await abrir().catch((e) => { descartar(); throw e; })).info,
    /** Projetos do servidor deste environment, para montar o grant do pedido. */
    async inventario() {
      const shell = await clienteLeitura.shell();
      return (shell.projects ?? []).filter((p) => !p.deletedAt).map((p) => ({ id: p.id, name: p.title, directory: p.workspaceRoot ?? p.cwd ?? p.directory }));
    },
    /** Cliente GET verificado, para leitura protegida sob lease (com repetição se o transporte caiu). */
    cliente: async () => clienteLeitura,
    adapter: {
      prepare: prepararSocket,
      invoke: (metodo, payload, opcoes) => {
        if (!rpc?.available) throw new Error('ambiente_indisponivel');
        return rpc.invoke(metodo, payload, opcoes);
      },
      // Native-tool reads and preflight (native.mjs): HTTP GETs and typed-error RPCs.
      native: {
        rpc: async (metodo, payload) => (await prepararSocket()).invoke(metodo, payload, { nativeErrors: true }),
        thread: (id) => clienteLeitura.threadCompleto(id),
        projects: () => clienteLeitura.projetos(),
        environment: () => clienteLeitura.ambiente(),
      },
      receipt: (r) => projectReceipt(r) ?? ('threadId' in r ? { threadId: r.threadId, resumed: r.resumed } : { sequence: r.sequence }),
      // Full thread count of one project: HTTP shell (active) + WS archived snapshot, same sequence.
      occupancy: async (projectId) => {
        const socket = await prepararSocket();
        return lerOcupacao({ projectId, readActive: () => clienteLeitura.shell(), readArchived: () => socket.invoke('orchestration.getArchivedShellSnapshot', {}) });
      },
      // Settlement observation for the settle guard (shell → full snapshot → shell; GETs only).
      settlementObservation: (threadId) => lerObservacao({
        environmentId: registro.environmentId,
        threadId,
        lerShell: () => clienteLeitura.shell(),
        lerCompleto: (id) => clienteLeitura.threadCompleto(id),
      }),
      projectForThread: async (id) => (await clienteLeitura.shell()).threads?.find((t) => t.id === id && !t.deletedAt)?.projectId,
      // Send preflight: execution snapshot from the full thread projection (one transaction).
      executionSnapshot: async (id) => {
        const completo = await clienteLeitura.threadCompleto(id);
        return derivarExecucao({ projecao: completo.projection ?? {}, fonte: { kind: 'thread_full_snapshot', threadSequence: completo.snapshotSequence ?? null, historyComplete: true } });
      },
      // Canonicalização de caminho só vale no domínio de execução: local para loopback,
      // no host SSH para environment remoto. Mesma regra nos dois: caminho canônico igual a
      // um root aprovado.
      verifyWorkspace: async (caminho, roots) => {
        if (registro.ssh) { const real = await realpathRemotoImpl(registro.ssh.host, caminho); return Boolean(real) && roots.includes(real); }
        try { return roots.includes(realpathSync(caminho)); } catch { return false; }
      },
      reconcile: async (record) => {
        if (record.state === 'completed' && record.receipt) {
          const r = record.receipt;
          if (r.projectId) return { found: true, state: 'completed' };
          return { found: true, ...(r.sequence !== undefined ? { sequence: r.sequence } : {}), ...(r.threadId ? { threadId: r.threadId } : {}), state: 'unknown' };
        }
        return { found: false, state: 'unknown' };
      },
    },
    get disponivel() { return Boolean(rpc?.available); },
    fechar() {
      if (rpc) { try { rpc.close(); } catch {} }
      rpc = null;
      estado = null;
      transporte.fechar();
    },
  };
}
