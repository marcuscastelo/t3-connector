// Instante ISO 8601 estrito (o formato que o T3 grava: `2026-10-03T10:05:00.000Z` ou com offset).
// `Date.parse` normaliza datas impossíveis (30/02 vira 02/03) e aceita formatos soltos; `Date.UTC`
// remapeia anos 00–99 para 1900–1999; somar frações em Number perde nanossegundos. Para provar a
// versão de uma thread nada disso serve. `nsIso` devolve o instante EXATO em nanossegundos
// (BigInt, aritmética de calendário própria) ou null; `msIso` é a mesma conta em milissegundos
// para ordenar e medir prazos.

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const bissexto = (ano) => (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
const diasNoMes = (ano, mes) => [31, bissexto(ano) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];

// Dias desde 1970-01-01 no calendário gregoriano proléptico (algoritmo days_from_civil).
function diasDesdeEpoca(ano, mes, dia) {
  const a = mes <= 2 ? ano - 1 : ano;
  const era = Math.floor(a / 400);
  const anoDaEra = a - era * 400;
  const diaDoAno = Math.floor((153 * (mes + (mes > 2 ? -3 : 9)) + 2) / 5) + dia - 1;
  const diaDaEra = anoDaEra * 365 + Math.floor(anoDaEra / 4) - Math.floor(anoDaEra / 100) + diaDoAno;
  return era * 146097 + diaDaEra - 719468;
}

export function nsIso(valor) {
  if (typeof valor !== 'string') return null;
  const m = ISO.exec(valor);
  if (!m) return null;
  const [ano, mes, dia, hora, min, seg] = m.slice(1, 7).map(Number);
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes(ano, mes) || hora > 23 || min > 59 || seg > 59) return null;
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 14 || om > 59) return null;
    offsetMin = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const segundos = BigInt(diasDesdeEpoca(ano, mes, dia)) * 86400n + BigInt(hora * 3600 + min * 60 + seg) - BigInt(offsetMin * 60);
  const nanos = m[7] ? BigInt(m[7].padEnd(9, '0')) : 0n;
  return segundos * 1_000_000_000n + nanos;
}

export function msIso(valor) {
  const ns = nsIso(valor);
  return ns === null ? null : Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

/** Igualdade exata de dois instantes válidos (false se algum não for válido). */
export const mesmoInstante = (a, b) => { const x = nsIso(a); const y = nsIso(b); return x !== null && y !== null && x === y; };
