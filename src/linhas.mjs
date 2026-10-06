// Linhas da shell vistas como evidência. A mesma thread pode aparecer em mais de uma linha
// (snapshot malformado, fontes unidas); nenhuma decisão escolhe a primeira em silêncio. A
// comparação é canônica: chaves ordenadas e instantes ISO válidos pelo valor exato, de modo que
// `10:05:00.000Z` e `07:05:00-03:00` são a mesma coisa e qualquer outra diferença é conflito.

import { nsIso } from './instante.mjs';

// Só campos temporais (…At, …Until) comparam pelo instante; texto livre (título) que pareça
// data continua texto (revisão R5, P1).
const TEMPORAL = /(At|Until)$/;
export const chaveCanonica = (v) => JSON.stringify(v, (k, x) => {
  if (typeof x === 'string' && TEMPORAL.test(k)) { const n = nsIso(x); return n === null ? x : `\u0000ns:${n}`; }
  if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return x;
});

/**
 * A linha da thread `id` entre `threads`, considerando TODAS as linhas com esse ID (inclusive
 * apagadas). `conflito: true` quando há mais de uma e elas divergem (revisão c357eae, P1).
 */
/**
 * O item de um catálogo (projetos, providers, modelos, descritores) com a chave dada:
 * `{item, conflito}`. Repetições idênticas na forma canônica contam como uma; divergentes são
 * conflito e nenhuma é escolhida pela ordem (revisão R6, P1). Catálogo que não é lista: nada.
 */
export function itemUnico(lista, pred) {
  const achados = (Array.isArray(lista) ? lista : []).filter((x) => x && pred(x));
  if (!achados.length) return { item: null, conflito: false };
  const base = chaveCanonica(achados[0]);
  return achados.some((x) => chaveCanonica(x) !== base) ? { item: null, conflito: true } : { item: achados[0], conflito: false };
}

export function linhaUnica(threads, id) {
  const linhas = (Array.isArray(threads) ? threads : []).filter((t) => t && t.id === id);
  if (!linhas.length) return { linha: null, conflito: false };
  const base = chaveCanonica(linhas[0]);
  return { linha: linhas[0], conflito: linhas.some((t) => chaveCanonica(t) !== base) };
}
