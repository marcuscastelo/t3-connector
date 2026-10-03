// Configuração local da ponte. Fica fora do Git (padrão ~/.config/t3-connector/config.json);
// exemplo em examples/config.json.
//
// {
//   "padrao": "local",
//   "ambientes": {
//     "local": { "environmentId": "…", "url": "http://127.0.0.1:3773",
//                  "tokenFile": "~/.config/t3-connector/tokens/local.token", "projetosPermitidos": ["…"] },
//     "remoto":  { "environmentId": "…", "ssh": { "host": "remoto", "portaRemota": 3773 },
//                  "tokenFile": "~/.config/t3-connector/tokens/remoto.token", "projetosPermitidos": ["…"] }
//   }
// }

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { validarUrl } from './t3.mjs';

export const CONFIG_PADRAO = '~/.config/t3-connector/config.json';

export const expandir = (p) => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

export class ErroConfig extends Error {}

export function validarConfig(bruta) {
  const falha = (m) => { throw new ErroConfig(`config: ${m}`); };
  if (!bruta || typeof bruta !== 'object' || !bruta.ambientes || typeof bruta.ambientes !== 'object') {
    falha('falta o objeto "ambientes"');
  }
  const ambientes = [];
  for (const [alias, a] of Object.entries(bruta.ambientes)) {
    if (!/^[a-z0-9-]+$/.test(alias)) falha(`alias "${alias}" inválido (use a-z, 0-9, -)`);
    if (!a.environmentId) falha(`${alias}: falta environmentId`);
    if (Boolean(a.url) === Boolean(a.ssh)) falha(`${alias}: informe exatamente um de "url" ou "ssh"`);
    if (a.url) validarUrl(a.url);
    if (a.ssh && !a.ssh.host) falha(`${alias}: ssh.host obrigatório`);
    if (!a.tokenFile) falha(`${alias}: falta tokenFile`);
    const projetos = a.projetosPermitidos ?? [];
    // Lista vazia não significa "todos": o ambiente não sobe sem escopo explícito.
    if (!Array.isArray(projetos) || projetos.length === 0) falha(`${alias}: projetosPermitidos vazio; a ponte não expõe nada por padrão`);
    ambientes.push({
      alias,
      environmentId: a.environmentId,
      url: a.url ?? null,
      ssh: a.ssh ? { host: a.ssh.host, portaRemota: a.ssh.portaRemota ?? 3773 } : null,
      tokenFile: expandir(a.tokenFile),
      projetosPermitidos: projetos,
    });
  }
  if (ambientes.length === 0) falha('nenhum ambiente configurado');
  const ids = new Set(ambientes.map((a) => a.environmentId));
  if (ids.size !== ambientes.length) falha('environmentId repetido');
  const padrao = bruta.padrao ?? ambientes[0].alias;
  if (!ambientes.some((a) => a.alias === padrao)) falha(`padrao "${padrao}" não está em ambientes`);
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
