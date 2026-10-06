import { readFile } from 'node:fs/promises';
import { CONFIG_PADRAO, expandir, validarConfig } from '../config.mjs';
import { criarAmbientes, ForaDoEscopo } from '../ambientes.mjs';
import { ACTIONS } from '../escrita/adapters.mjs';
import { linhaUnica } from '../linhas.mjs';
import { ErroT3 } from '../t3.mjs';

// OAuth-only endpoint loader. The stdio validator and its on-disk input stay unchanged.
export function validarConfigOAuthAll(raw) {
  const copy = structuredClone(raw);
  for (const env of Object.values(copy.environments ?? {})) env.allowedProjects = ['oauth-internal-endpoint'];
  const config = validarConfig(copy);
  return { ...config, ambientes: config.ambientes.map(r => ({ ...r, projetosPermitidos: [], destination: `t3://${r.environmentId}` })) };
}
export async function carregarConfigOAuthAll(file = process.env.T3_CONNECTOR_CONFIG ?? CONFIG_PADRAO) {
  const arquivo = expandir(file);
  return { ...validarConfigOAuthAll(JSON.parse(await readFile(arquivo, 'utf8'))), arquivo };
}

export function consentAll(registros) {
  return { scopeVersion: 3, projectPolicy: 'all', runtimeMode: 'full-access', environments: registros.map(r => ({
    alias: r.alias, label: r.alias, environmentId: r.environmentId, destination: r.destination ?? `t3://${r.environmentId}`, actions: [...(r.acoes ?? ACTIONS)],
  })) };
}
export function assertEnvironmentParity(reads, writes) {
  const keys = rs => rs.map(r => JSON.stringify([r.alias, r.environmentId, r.destination ?? `t3://${r.environmentId}`])).sort();
  if (JSON.stringify(keys(reads)) !== JSON.stringify(keys(writes))) throw new Error('OAuth all: read/write environments must match (alias, environmentId, destination)');
}
export function consented(authority, principal, registro) {
  const s = authority.check(principal.sid);
  if (s.sub !== principal.sub || s.grants?.projectPolicy !== 'all' || s.grants.scopeVersion !== 3 || !s.grants.environments.some(e =>
    e.alias === registro.alias && e.environmentId === registro.environmentId && e.destination === (registro.destination ?? `t3://${registro.environmentId}`))) {
    throw new ForaDoEscopo('environment outside the consented OAuth policy');
  }
  return s;
}

export function criarAmbientesOAuthAll(config, options) {
  // Only the internal connection registry needs a nonempty placeholder. It is never an ACL.
  return criarAmbientes({ ...config, ambientes: config.ambientes.map(r => ({ ...r, projetosPermitidos: ['oauth-internal-endpoint'] })) }, options);
}

// Every facade invocation owns these records and Sets. Connections can be shared; scopes cannot.
export function liveReadContext(base, authority, principal) {
  const records = base.registros.map(original => ({ ...original, escopo: null, original }));
  const wrap = (r, cliente) => new Proxy(cliente, { get(target, key) {
    if (key !== 'shell') { const v = target[key]; return typeof v === 'function' ? v.bind(target) : v; }
    return async options => {
      consented(authority, principal, r);
      const shell = await target.shell(options);
      consented(authority, principal, r);
      const ids = new Set((shell.projects ?? []).filter(p => !p.deletedAt).map(p => p.id));
      const exigirProjeto = id => { if (!ids.has(id)) throw new ForaDoEscopo(`project ${id} not found in environment ${r.alias}`); };
      r.escopo = {
        permitidos: ids, projetoPermitido: id => ids.has(id), exigirProjeto,
        threadsVisiveis: s => s.threads.filter(t => ids.has(t.projectId) && !t.deletedAt && !t.archivedAt),
        exigirThread(s, id) {
          const { linha, conflito } = linhaUnica(s.threads, id);
          if (conflito) throw new ErroT3(`thread ${id} appears in the shell with conflicting rows; read again`, { codigo: 'resposta_invalida' });
          const t = linha && !linha.deletedAt && ids.has(linha.projectId) ? linha : null;
          if (!t) throw new ForaDoEscopo(`thread ${id} not found in the authorized projects of environment ${r.alias}`); return t;
        },
      };
      return shell;
    };
  } });
  return {
    ...base, registros: records,
    resolver(key) { const original = base.resolver(key); const r = records.find(r => r.original === original); consented(authority, principal, r); return r; },
    usar(r, fn, options) {
      consented(authority, principal, r);
      return base.usar(r.original, async (c, info) => {
        const client = wrap(r, c);
        const shell = await client.shell(options);
        // Some existing handlers validate projectId before asking for the shell.
        // Prime their private scope and reuse exactly that inventory observation. `shellFresca`
        // reads again (consent checked, scope refreshed): a coherence check (shell → full → shell)
        // needs two real reads, not the primed one twice.
        const snapshotClient = new Proxy(client, { get(target, key) {
          if (key === 'shell') return async () => shell;
          if (key === 'shellFresca') return (opts) => target.shell(opts);
          return target[key];
        } });
        return fn(snapshotClient, info);
      }, options);
    },
    async conectar(r, options) { consented(authority, principal, r); const c = await base.conectar(r.original, options); return { ...c, cliente: wrap(r, c.cliente) }; },
    falhou(r, e) { return base.falhou(r.original, e); },
    async listar(options) {
      records.forEach(r => consented(authority, principal, r));
      const items = await base.listar(options);
      records.forEach(r => consented(authority, principal, r));
      return items.map(({ allowedProjectCount, ...item }) => ({ ...item, projectPolicy: 'all' }));
    },
  };
}
