// Validação de modelSelection na escrita, contra a configuração canônica do environment
// (server.getConfig → ServerConfig.providers, a mesma fonte do t3_providers), lida a cada
// escrita: o cliente não precisa consultar capabilities antes, e uma capability que mudou
// vale na escrita seguinte.
//
// Contrato das opções (packages/contracts/src/model.ts, T3 8ed276c2): cada modelo traz
// capabilities.optionDescriptors; tipo select (valor = id de uma das options) ou boolean
// (valor booleano, ex.: fastMode). Outro tipo não é interpretado. A seleção segue para o T3
// sem alteração: nada é normalizado, ordenado nem completado com default.

import { NativeToolError } from './native.mjs';

export const MODEL_SELECTION_ACTIONS = Object.freeze(['thread.launch', 'thread.model-selection.set', 'provider.switch', 'delegated_task.request']);

const LISTA_MAX = 40;
const lista = (ids) => ids.length > LISTA_MAX ? `${ids.slice(0, LISTA_MAX).join(', ')}, … (${ids.length} in total)` : ids.join(', ') || 'none';
const json = (v) => JSON.stringify(v);

/**
 * Problemas de `selection` frente à lista de providers do environment. Pura; lista vazia =
 * seleção suportada. Cada item: {code, message}.
 */
export function problemasModelSelection(providers, { instanceId, model, options = [] }) {
  const p = providers.find((x) => x?.instanceId === instanceId);
  if (!p) return [{ code: 'provider_instance_unavailable', message: `instanceId ${json(instanceId)} is not configured in this environment. Configured instanceIds: ${lista(providers.map((x) => json(x?.instanceId)))}.` }];
  if (!Array.isArray(p.models)) return [{ code: 'model_capabilities_unknown', message: `instance ${json(instanceId)} did not report its models; nothing can be validated.` }];
  const m = p.models.find((x) => x?.slug === model);
  if (!m) return [{ code: 'provider_model_unavailable', message: `model ${json(model)} is not offered by instance ${json(instanceId)}. Offered models: ${lista(p.models.map((x) => json(x?.slug)))}.` }];
  if (!options.length) return [];
  const descritores = m.capabilities?.optionDescriptors;
  if (!Array.isArray(descritores)) return [{ code: 'model_capabilities_unknown', message: `model ${json(model)} of instance ${json(instanceId)} declares no option descriptors; options cannot be validated. Omit options.` }];
  const oferecidas = () => lista(descritores.map((d) => `${json(d?.id)} (${d?.type})`));
  const problemas = [];
  const vistas = new Set();
  for (const o of options) {
    if (vistas.has(o.id)) { problemas.push({ code: 'model_option_unsupported', message: `option ${json(o.id)} is repeated; pass each option once.` }); continue; }
    vistas.add(o.id);
    const d = descritores.find((x) => x?.id === o.id);
    if (!d) { problemas.push({ code: 'model_option_unsupported', message: `option ${json(o.id)} is not offered by model ${json(model)} of instance ${json(instanceId)}. Offered options: ${oferecidas()}.` }); continue; }
    if (d.type === 'select') {
      const ids = Array.isArray(d.options) ? d.options.map((x) => x?.id) : [];
      if (typeof o.value !== 'string' || !ids.includes(o.value)) problemas.push({ code: 'model_option_value_unsupported', message: `option ${json(o.id)} is a select; value ${json(o.value)} is not one of: ${lista(ids.map(json))}.` });
    } else if (d.type === 'boolean') {
      if (typeof o.value !== 'boolean') problemas.push({ code: 'model_option_value_unsupported', message: `option ${json(o.id)} is a boolean; value ${json(o.value)} must be true or false.` });
    } else problemas.push({ code: 'model_capabilities_unknown', message: `option ${json(o.id)} has descriptor type ${json(d.type ?? null)}, which the connector does not interpret.` });
  }
  return problemas;
}

/**
 * Lê os providers pelo adapter e recusa (antes de qualquer envio) uma seleção que o
 * environment não oferece. A recusa é tipada (NativeToolError): o Dispatcher a registra como
 * `rejected`, sem reconciliação, e o código e a mensagem chegam ao cliente.
 */
export async function validarModelSelection(adapter, selection) {
  let providers;
  try {
    if (!adapter.providers) throw new Error();
    providers = await adapter.providers();
    if (!Array.isArray(providers)) throw new Error();
  } catch {
    throw new NativeToolError('model_capabilities_unavailable', 'could not read the provider configuration of this environment (server.getConfig) to validate modelSelection; nothing was sent.');
  }
  const problemas = problemasModelSelection(providers, selection);
  if (problemas.length) throw new NativeToolError(problemas[0].code, `${problemas.map((p) => p.message).join(' ')} Nothing was sent.`);
}
