// Provider instances de um environment, lidas da mesma fonte que Settings > Providers do T3.
//
// Fonte (pingdotgg/t3code 8ed276c2): RPC unário `server.getConfig` no /ws, payload {},
// escopo orchestration:read (apps/server/src/auth/RpcAuthorization.ts:38). O servidor monta
// `ServerConfig.providers` com ProviderRegistry.getProviders (apps/server/src/ws.ts:1610-1639),
// que inclui instances configuradas em settings.providerInstances, slots default e
// instances indisponíveis. Contrato de cada item: ServerProvider em
// packages/contracts/src/server.ts:367-438. A shell do Orchestrator V2 não traz providers.
//
// O connector não filtra, ordena nem completa a lista: devolve os itens na ordem do T3,
// com os IDs como vieram. Só recorta os campos de cada item (ver CAMPOS); auth sai apenas
// com `status`, sem e-mail, conta ou URL de login.

import { ErroT3 } from './t3.mjs';
import { chamar } from './ws.mjs';

/** Campos de ServerProvider repassados sem alteração, quando o T3 os envia. */
export const CAMPOS = Object.freeze([
  'instanceId',
  'driver',
  'displayName',
  'enabled',
  'installed',
  'status',
  'availability',
  'unavailableReason',
  'message',
  'version',
  'checkedAt',
  'continuation',
  'supportedRuntimeModes',
  'requiresNewThreadForModelChange',
]);

export function resumoProvider(p, { incluirModelos = false } = {}) {
  const item = {};
  for (const campo of CAMPOS) if (p[campo] !== undefined) item[campo] = p[campo];
  if (p.auth?.status !== undefined) item.auth = { status: p.auth.status };
  if (incluirModelos && p.models !== undefined) item.models = p.models;
  return item;
}

/** Lê ServerConfig pelo /ws e confere que respondeu o environment esperado. */
export async function lerProviders(cliente, { environmentIdEsperado, signal, chamarImpl = chamar }) {
  const ticket = await cliente.ticketWs({ signal });
  const config = await chamarImpl({ baseUrl: cliente.base, ticket, tag: 'server.getConfig', payload: {}, signal });
  const recebido = config?.environment?.environmentId;
  if (recebido !== environmentIdEsperado) {
    throw new ErroT3(`server.getConfig answered as environment ${recebido}; expected ${environmentIdEsperado}`, { codigo: 'environment_divergente' });
  }
  if (!Array.isArray(config.providers)) throw new ErroT3('server.getConfig without the providers list', { codigo: 'resposta_invalida' });
  return config.providers;
}
