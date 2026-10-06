// Linhas da shell vistas como evidência. A mesma thread pode aparecer em mais de uma linha
// (snapshot malformado, fontes unidas); nenhuma decisão escolhe a primeira em silêncio. A
// comparação é canônica: chaves ordenadas e instantes ISO válidos pelo valor exato, de modo que
// `10:05:00.000Z` e `07:05:00-03:00` são a mesma coisa e qualquer outra diferença é conflito.

import { nsIso } from './instante.mjs';

export const chaveCanonica = (v) => JSON.stringify(v, (_k, x) => {
  if (typeof x === 'string') { const n = nsIso(x); return n === null ? x : `\u0000ns:${n}`; }
  if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return x;
});

/**
 * A linha da thread `id` entre `threads`, considerando TODAS as linhas com esse ID (inclusive
 * apagadas). `conflito: true` quando há mais de uma e elas divergem (revisão c357eae, P1).
 */
export function linhaUnica(threads, id) {
  const linhas = (Array.isArray(threads) ? threads : []).filter((t) => t && t.id === id);
  if (!linhas.length) return { linha: null, conflito: false };
  const base = chaveCanonica(linhas[0]);
  return { linha: linhas[0], conflito: linhas.some((t) => chaveCanonica(t) !== base) };
}
