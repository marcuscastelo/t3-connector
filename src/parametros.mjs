// Parâmetros públicos em inglês com os nomes antigos (português) aceitos como aliases
// ocultos. O tools/list só anuncia o nome em inglês; uma chamada antiga, com o nome
// legado, continua funcionando. Os dois nomes com valores diferentes falham: nunca se
// escolhe um em silêncio.
//
// O SDK descarta chaves fora do schema antes do handler, então o objeto deixa chaves
// extras passarem e `normalizarParametros` devolve só os campos conhecidos, já com o nome em inglês.

import { z } from 'zod';

export class ParametroInvalido extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/**
 * inputSchema do tools/list. `obrigatorios` aparecem em `required` no JSON Schema, mas a
 * checagem fica em `normalizarParametros`: uma chamada antiga manda só o nome legado. O
 * JSON Schema continua sem `additionalProperties`, como antes: os aliases
 * são aceitos, não oferecidos.
 */
export function esquema(forma, obrigatorios = []) {
  const campos = Object.fromEntries(Object.entries(forma).map(([k, s]) => [k, obrigatorios.includes(k) ? s.optional() : s]));
  return z.looseObject(campos).meta({ additionalProperties: undefined, ...(obrigatorios.length ? { required: obrigatorios } : {}) });
}

/**
 * Campos de `forma` com o nome em inglês. `aliases` = {legado: inglês}; `valores` =
 * {legado: {valor legado: valor em inglês}} para enums cujo nome legado também tinha
 * valores em português (o nome em inglês só aceita os valores em inglês).
 */
export function normalizarParametros(args, forma, { aliases = {}, valores = {}, obrigatorios = [] } = {}) {
  const saida = {};
  for (const k of Object.keys(forma)) if (args?.[k] !== undefined) saida[k] = args[k];
  for (const [legado, ingles] of Object.entries(aliases)) {
    if (args?.[legado] === undefined) continue;
    let valor = args[legado];
    const mapa = valores[legado];
    if (mapa) {
      if (typeof valor !== 'string' || !Object.hasOwn(mapa, valor)) {
        throw new ParametroInvalido('parameter_invalid', `invalid \`${legado}\` (deprecated alias of \`${ingles}\`): expected one of ${Object.keys(mapa).join(', ')}`);
      }
      valor = mapa[valor];
    }
    const r = forma[ingles].safeParse(valor);
    if (!r.success) {
      throw new ParametroInvalido('parameter_invalid', `invalid \`${legado}\` (deprecated alias of \`${ingles}\`): ${r.error.issues[0]?.message ?? 'invalid value'}`);
    }
    if (saida[ingles] !== undefined && saida[ingles] !== r.data) {
      throw new ParametroInvalido('parameter_conflict', `\`${ingles}\` and its deprecated alias \`${legado}\` have different values; send only \`${ingles}\``);
    }
    saida[ingles] = r.data;
  }
  for (const k of obrigatorios) {
    if (saida[k] === undefined) throw new ParametroInvalido('parameter_required', `\`${k}\` is required`);
  }
  return saida;
}
