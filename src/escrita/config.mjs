// Configuração local da escrita, separada da leitura (padrão ~/.config/t3-connector/write.json).
// Credenciais read+operate próprias por environment; nunca reutiliza o token só de leitura.
//
// {
//   "port": 7433,
//   "stateDir": "~/.local/state/t3-connector-write",
//   "channel": { "organization": "my-org", "tunnelId": "tunnel_…" },
//   "passkey": { "rpName": "T3 Connector", "userName": "t3-connector" },   (opcional; só rótulos do cadastro)
//   "environments": {
//     "local": { "environmentId": "…", "url": "http://127.0.0.1:3773", "tokenFile": "…" },
//     "remoto":  { "environmentId": "…", "ssh": { "host": "remoto", "remotePort": 3773 }, "tokenFile": "…" }
//   }
// }
//
// Os nomes antigos (porta, estado, canal, ambientes, portaRemota) são recusados com o nome
// novo na mensagem.
//
// A config não limita projetos nem ações: cada pedido leva o inventário completo de cada
// environment naquele momento e todas as ações, e quem decide é a passkey sobre o escopo
// mostrado na página.

import { readFile } from 'node:fs/promises';
import { campoConfig, expandir, sshConfig } from '../config.mjs';
import { validarUrl } from '../t3.mjs';
import { ACTIONS } from './adapters.mjs';

export const CONFIG_ESCRITA = '~/.config/t3-connector/write.json';

export function validarConfigEscrita(bruta) {
  const falha = (m) => { throw new Error(`config de escrita: ${m}`); };
  const porta = campoConfig(bruta, 'port', 'porta', falha);
  if (!Number.isInteger(porta)) falha('port obrigatória');
  const estado = campoConfig(bruta, 'stateDir', 'estado', falha);
  if (!estado) falha('stateDir obrigatório');
  const { organization, tunnelId } = campoConfig(bruta, 'channel', 'canal', falha) ?? {};
  if (!organization || !/^tunnel_[a-zA-Z0-9]+$/.test(tunnelId ?? '')) falha('channel.organization e channel.tunnelId obrigatórios');
  const ambientes = [];
  for (const [alias, a] of Object.entries(campoConfig(bruta, 'environments', 'ambientes', falha) ?? {})) {
    if (!/^[a-z0-9-]+$/.test(alias)) falha(`alias "${alias}" inválido`);
    if (!a.environmentId) falha(`${alias}: falta environmentId`);
    if (Boolean(a.url) === Boolean(a.ssh)) falha(`${alias}: informe exatamente um de "url" ou "ssh"`);
    if (a.url) validarUrl(a.url);
    if (a.ssh && !a.ssh.host) falha(`${alias}: ssh.host obrigatório`);
    if (!a.tokenFile) falha(`${alias}: falta tokenFile`);
    // Campos de allowlist não existem: recusar evita supor uma restrição que não se aplica.
    for (const campo of ['projetos', 'acoes', 'projetosPermitidos', 'projects', 'actions', 'allowedProjects']) {
      if (campo in a) falha(`${alias}: "${campo}" não é suportado; o escopo é o inventário completo e quem decide é a passkey`);
    }
    ambientes.push({
      alias,
      environmentId: a.environmentId,
      url: a.url ?? null,
      ssh: sshConfig(a.ssh, falha, `${alias}: `),
      tokenFile: expandir(a.tokenFile),
      acoes: [...ACTIONS],
      // Identidade lógica estável: nunca a porta do túnel SSH.
      destination: `t3://${a.environmentId}`,
    });
  }
  if (!ambientes.length) falha('nenhum ambiente');
  if (new Set(ambientes.map((a) => a.environmentId)).size !== ambientes.length) falha('environmentId repetido');
  const passkey = {};
  for (const campo of ['rpName', 'userName']) {
    const v = bruta.passkey?.[campo];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim() || v.length > 64) falha(`passkey.${campo} deve ser texto de 1 a 64 caracteres`);
    passkey[campo] = v;
  }
  return { porta, estado: expandir(estado), canal: { organization, tunnelId }, passkey, ambientes };
}

export async function carregarConfigEscrita(arquivo = process.env.T3_CONNECTOR_WRITE_CONFIG ?? CONFIG_ESCRITA) {
  const caminho = expandir(arquivo);
  let texto;
  try { texto = await readFile(caminho, 'utf8'); } catch { throw new Error(`config de escrita ausente em ${caminho}`); }
  return { ...validarConfigEscrita(JSON.parse(texto)), arquivo: caminho };
}

/** Resolve alias ou environmentId; sem ambiente ou desconhecido falha, sem padrão. */
export function resolverAmbiente(ambientes, chave) {
  if (chave === undefined || chave === null || chave === '') throw new Error('ambiente_obrigatorio');
  const a = ambientes.find((x) => x.alias === chave || x.environmentId === chave);
  if (!a) throw new Error('ambiente_desconhecido');
  return a;
}
