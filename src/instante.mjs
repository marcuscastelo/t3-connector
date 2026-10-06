// Instante ISO 8601 estrito (o formato que o T3 grava: `2026-10-03T10:05:00.000Z` ou com offset).
// `Date.parse` normaliza datas impossíveis (30/02 vira 02/03) e aceita formatos soltos; para
// provar a versão de uma thread isso não basta. Devolve milissegundos (fração além do ms
// preservada como fração) ou null quando o texto não é um instante válido de calendário.

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const diasNoMes = (ano, mes) => [31, (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];

export function msIso(valor) {
  if (typeof valor !== 'string') return null;
  const m = ISO.exec(valor);
  if (!m) return null;
  const [ano, mes, dia, hora, min, seg] = m.slice(1, 7).map(Number);
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes(ano, mes) || hora > 23 || min > 59 || seg > 59) return null;
  let offset = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 14 || om > 59) return null;
    offset = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const fracao = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  return Date.UTC(ano, mes - 1, dia, hora, min, seg) + fracao - offset * 60000;
}
