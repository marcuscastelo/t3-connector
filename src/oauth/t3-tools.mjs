import { join } from 'node:path';
import { criarServidor } from '../servidor.mjs';
import { criarAmbientes } from '../ambientes.mjs';
import { criarConexaoEscrita } from '../escrita/conexao.mjs';
import { FileJournal } from '../escrita/journal.mjs';
import { sessionWrites } from './session-writes.mjs';
import { sharedSource, perRequestSource } from './resource-server.mjs';

// Real T3 catalog for the OAuth profile:
//   - reads: the eight existing read tools, unchanged, over the read configuration (read-only
//     backend tokens and the per-environment project allowlist), behind the OAuth session;
//   - writes (optional): the existing mutation catalog without leaseId, authorized by the session
//     and its frozen grants, over the write configuration's environments (read+operate tokens),
//     with its own journal file in the OAuth state directory (never the lease journal).
// Only the `ambientes` of the write configuration are used; its gate port/channel are ignored.
export function t3Tools({ readConfig, writeConfig = null, ambientes = null, conexoes = null, journal = null }) {
  return ({ authority, issuer, stateDir, audit }) => {
    const reads = ambientes ?? criarAmbientes(readConfig);
    const sources = [sharedSource(criarServidor({ ambientes: reads }))];
    let writes = null, ownJournal = null;
    if (writeConfig || conexoes) {
      const cx = conexoes ?? writeConfig.ambientes.map(r => criarConexaoEscrita(r));
      const j = journal ?? (ownJournal = new FileJournal(join(stateDir, 'write-journal.sqlite')));
      writes = sessionWrites({ conexoes: cx, journal: j, authority, issuer, audit: e => { j.audit(e); audit(e); } });
      sources.push(perRequestSource(writes.registerTools, { name: 't3-connector-oauth-writes', version: '1.0.0' }));
    }
    return {
      sources,
      grantProvider: writes ? () => writes.inventory() : null,
      close() { writes?.close(); ownJournal?.close(); reads.fechar?.(); },
    };
  };
}
