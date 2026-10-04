import { join } from 'node:path';
import { criarServidor } from '../servidor.mjs';
import { criarAmbientes } from '../ambientes.mjs';
import { criarConexaoEscrita } from '../escrita/conexao.mjs';
import { FileJournal } from '../escrita/journal.mjs';
import { sessionWrites } from './session-writes.mjs';
import { assertEnvironmentParity, consentAll, criarAmbientesOAuthAll, liveReadContext } from './project-policy.mjs';
import { sharedSource, perRequestSource, perInvocationSource } from './resource-server.mjs';

// OAuth/all uses live operation contexts; restricted preserves the sandbox snapshot policy.
export function t3Tools({ readConfig, writeConfig = null, writeProjects = null, ambientes = null, conexoes = null, journal = null, projectPolicy = 'restricted' }) {
  if (projectPolicy === 'all' && writeProjects) throw new Error('OAuth all conflicts with writeProjects');
  const all = projectPolicy === 'all';
  if (all && (writeConfig || conexoes)) assertEnvironmentParity(ambientes?.registros ?? readConfig.ambientes, conexoes?.map(c => c.registro) ?? writeConfig.ambientes);
  return ({ authority, issuer, stateDir, audit }) => {
    const reads = ambientes ?? (all ? criarAmbientesOAuthAll(readConfig) : criarAmbientes(readConfig));
    const sources = [all ? perInvocationSource(principal => criarServidor({ ambientes: liveReadContext(reads, authority, principal) })) : sharedSource(criarServidor({ ambientes: reads }))];
    let writes = null, ownJournal = null, writeRecords = [];
    if (writeConfig || conexoes) {
      const cx = conexoes ?? writeConfig.ambientes.map(r => criarConexaoEscrita(r));
      writeRecords = cx.map(c => c.registro);
      const j = journal ?? (ownJournal = new FileJournal(join(stateDir, 'write-journal.sqlite')));
      writes = sessionWrites({ conexoes: cx, journal: j, authority, issuer, allowedProjects: writeProjects, projectPolicy, audit: e => { j.audit(e); audit(e); } });
      sources.push(perRequestSource(writes.registerTools, { name: 't3-connector-oauth-writes', version: '1.0.0' }));
    }
    return {
      sources,
      capabilities: { read: true, write: Boolean(writes) },
      grantProvider: all ? Object.assign(async () => {
        // Availability is explanatory at consent; configured hosts remain in the continuing
        // policy. Public login invokes this only after UV, and no project IDs are collected.
        const unavailable = (await Promise.all(reads.registros.map(async r => {
          try {
            // Probe a private record so consent cannot prime the reads' cached verification.
            await reads.conectar({ ...r, conexao: null }, { signal: AbortSignal.timeout(4000) });
            return null;
          } catch { return { alias: r.alias, environmentId: r.environmentId, reason: 'environment_unavailable' }; }
        }))).filter(Boolean);
        // Consent actions come from the offered write connections, never a read-only
        // record's default action catalog. With no write catalog the policy has no actions.
        const records = reads.registros.map(r => ({ ...r, acoes: writeRecords.find(w => w.alias === r.alias)?.acoes ?? [] }));
        return { grants: consentAll(records), unavailable };
      }, { projectPolicy: 'all' }) : writes ? () => writes.inventory() : null,
      close() { writes?.close(); ownJournal?.close(); reads.fechar?.(); },
    };
  };
}

// T3_CONNECTOR_OAUTH_WRITE_PROJECTS="alias:projectId,alias:projectId" → Map alias → Set.
export function parseWriteProjects(value) {
  if (value === undefined || value === '') return null;
  const map = new Map();
  for (const item of value.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    if (i < 1 || i === item.length - 1) throw new Error('T3_CONNECTOR_OAUTH_WRITE_PROJECTS must be a comma-separated list of alias:projectId');
    const alias = item.slice(0, i), id = item.slice(i + 1);
    if (!map.has(alias)) map.set(alias, new Set());
    map.get(alias).add(id);
  }
  return map;
}
