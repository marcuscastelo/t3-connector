// Transporte até o servidor T3 de cada environment.
//
// - url: endpoint direto (loopback HTTP ou HTTPS), validado por validarUrl.
// - ssh: `ssh -N -L 127.0.0.1:<porta livre>:127.0.0.1:<portaRemota> <host>`, processo filho
//   desta ponte. Sobe na primeira chamada, é recriado se cair e morre com a ponte.
//   Usa o apelido SSH do ~/.ssh/config (chave declarada, IdentitiesOnly), sem agent
//   forwarding e sem ControlMaster compartilhado: a ponte só encerra o que ela criou.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { Cancelada, ErroT3 } from './t3.mjs';

export function criarTransporteUrl(url) {
  return { tipo: 'url', baseUrl: async () => url, descartar() {}, fechar() {} };
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function conecta(porta) {
  return new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port: porta });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

export function criarTransporteSsh({ host, portaRemota = 3773, prontoEmMs = 15000, spawnImpl = spawn, portaLivreImpl = portaLivre }) {
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new ErroT3(`host SSH inválido: ${host}`);
  let atual = null;

  function iniciar() {
    const estado = { porta: null, filho: null, saiu: false, stderr: '' };
    estado.pronto = (async () => {
      estado.porta = await portaLivreImpl();
      estado.filho = spawnImpl('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForwardAgent=no',
        '-N', '-L', `127.0.0.1:${estado.porta}:127.0.0.1:${portaRemota}`, host,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      estado.filho.stderr?.on('data', (d) => { estado.stderr = (estado.stderr + d).slice(-400); });
      estado.filho.once('exit', () => { estado.saiu = true; });
      estado.filho.once('error', () => { estado.saiu = true; });
      const fim = Date.now() + prontoEmMs;
      // Espera o listener local do forward; o ssh só o abre depois de autenticar.
      while (Date.now() < fim) {
        if (estado.saiu) break;
        if (await conecta(estado.porta)) return `http://127.0.0.1:${estado.porta}`;
        await pausa(100);
      }
      estado.filho.kill('SIGTERM');
      const detalhe = estado.stderr.trim().split('\n').at(-1) ?? '';
      throw new ErroT3(`túnel SSH até ${host} não abriu${detalhe ? `: ${detalhe}` : ''}`, { codigo: 'indisponivel' });
    })();
    // Falha na subida marca o estado como encerrado: o próximo uso recria o túnel.
    estado.pronto.catch(() => { estado.saiu = true; });
    return estado;
  }

  return {
    tipo: 'ssh',
    host,
    async baseUrl({ signal } = {}) {
      if (!atual || atual.saiu) atual = iniciar();
      const estado = atual;
      if (!signal) return estado.pronto;
      return new Promise((resolve, reject) => {
        const aoAbortar = () =>
          reject(signal.reason?.name === 'TimeoutError'
            ? new ErroT3(`túnel SSH até ${host} não abriu no prazo da chamada`, { codigo: 'prazo' })
            : new Cancelada());
        if (signal.aborted) return aoAbortar();
        signal.addEventListener('abort', aoAbortar, { once: true });
        estado.pronto.then(resolve, reject).finally(() => signal.removeEventListener('abort', aoAbortar));
      });
    },
    /** Derruba o túnel atual (ex.: depois de falha de transporte); o próximo uso recria. */
    descartar() {
      if (atual?.filho && !atual.saiu) atual.filho.kill('SIGTERM');
      atual = null;
    },
    fechar() { this.descartar(); },
  };
}
