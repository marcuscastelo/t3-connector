// Configuração local da ponte. Fica fora do Git (padrão ~/.config/t3-connector/config.json);
// exemplo em examples/config.json.
//
// {
//   "default": "local",
//   "environments": {
//     "local": { "environmentId": "…", "url": "http://127.0.0.1:3773",
//                  "tokenFile": "~/.config/t3-connector/tokens/local.token", "allowedProjects": ["…"] },
//     "remoto":  { "environmentId": "…", "ssh": { "host": "remoto", "remotePort": 3773 },
//                  "tokenFile": "~/.config/t3-connector/tokens/remoto.token", "allowedProjects": ["…"] }
//   }
// }
//
// Os nomes antigos (padrao, ambientes, projetosPermitidos, portaRemota) continuam aceitos;
// o nome antigo e o novo com valores diferentes no mesmo objeto são recusados.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { validarUrl } from './t3.mjs';

export const CONFIG_PADRAO = '~/.config/t3-connector/config.json';

export const expandir = (p) => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

export class ErroConfig extends Error {}

/** JSON com as chaves dos objetos em ordem: a ordem das propriedades não muda o valor. */
const canonico = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
  : x));

/** Valor de `ingles` ou do nome antigo `legado`; os dois com valores diferentes são erro. */
export function campoConfig(obj, ingles, legado, falha, onde = '') {
  const novo = obj?.[ingles];
  const antigo = obj?.[legado];
  if (novo !== undefined && antigo !== undefined && canonico(novo) !== canonico(antigo)) {
    falha(`${onde}"${ingles}" e o nome antigo "${legado}" têm valores diferentes; use só "${ingles}"`);
  }
  return novo ?? antigo;
}

/** `ssh` com `remotePort` (ou o antigo `portaRemota`), padrão 3773. */
export function sshConfig(ssh, falha, onde) {
  return ssh ? { host: ssh.host, portaRemota: campoConfig(ssh, 'remotePort', 'portaRemota', falha, `${onde}ssh.`) ?? 3773 } : null;
}

export function validarConfig(bruta) {
  const falha = (m) => { throw new ErroConfig(`config: ${m}`); };
  const lista = campoConfig(bruta, 'environments', 'ambientes', falha);
  if (!bruta || typeof bruta !== 'object' || !lista || typeof lista !== 'object') {
    falha('falta o objeto "environments"');
  }
  const ambientes = [];
  for (const [alias, a] of Object.entries(lista)) {
    if (!/^[a-z0-9-]+$/.test(alias)) falha(`alias "${alias}" inválido (use a-z, 0-9, -)`);
    if (!a.environmentId) falha(`${alias}: falta environmentId`);
    if (Boolean(a.url) === Boolean(a.ssh)) falha(`${alias}: informe exatamente um de "url" ou "ssh"`);
    if (a.url) validarUrl(a.url);
    if (a.ssh && !a.ssh.host) falha(`${alias}: ssh.host obrigatório`);
    if (!a.tokenFile) falha(`${alias}: falta tokenFile`);
    const projetos = campoConfig(a, 'allowedProjects', 'projetosPermitidos', falha, `${alias}: `) ?? [];
    // Lista vazia não significa "todos": o ambiente não sobe sem escopo explícito.
    if (!Array.isArray(projetos) || projetos.length === 0) falha(`${alias}: allowedProjects vazio; a ponte não expõe nada por padrão`);
    ambientes.push({
      alias,
      environmentId: a.environmentId,
      url: a.url ?? null,
      ssh: sshConfig(a.ssh, falha, `${alias}: `),
      tokenFile: expandir(a.tokenFile),
      projetosPermitidos: projetos,
    });
  }
  if (ambientes.length === 0) falha('nenhum ambiente configurado');
  const ids = new Set(ambientes.map((a) => a.environmentId));
  if (ids.size !== ambientes.length) falha('environmentId repetido');
  const padrao = campoConfig(bruta, 'default', 'padrao', falha) ?? ambientes[0].alias;
  if (!ambientes.some((a) => a.alias === padrao)) falha(`default "${padrao}" não está em environments`);
  return { padrao, ambientes };
}

export async function carregarConfig(arquivo = process.env.T3_CONNECTOR_CONFIG ?? CONFIG_PADRAO) {
  const caminho = expandir(arquivo);
  let texto;
  try {
    texto = await readFile(caminho, 'utf8');
  } catch {
    throw new ErroConfig(`config ausente em ${caminho}; veja examples/config.json`);
  }
  return { ...validarConfig(JSON.parse(texto)), arquivo: caminho };
}
