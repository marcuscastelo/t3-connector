// Busca e paginação das listagens (t3_projetos, t3_threads). O runtime do ChatGPT corta
// respostas grandes sem avisar; por isso a lista sai em páginas com ordem total e cursor
// por chave (não por posição), e a resposta diz quanto casou, quanto voltou e se há mais.
//
// O cursor é opaco para o cliente, mas não é segredo: base64url de JSON com a consulta
// (environment + filtros) e a chave do último item. Usado em outra consulta, é recusado.

export class CursorInvalido extends Error {
  constructor() {
    super('cursor inválido ou de outra consulta (environment, ferramenta ou filtros diferentes); refaça a consulta sem cursor');
    this.name = 'CursorInvalido';
  }
}

/** Minúsculas e sem acento, para busca por trecho tolerante a voz e digitação. */
export function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function casaBusca(termo, ...campos) {
  if (!termo) return true;
  const t = normalizar(termo);
  return campos.some((c) => normalizar(c).includes(t));
}

export function assinatura(partes) {
  return JSON.stringify(partes);
}

function codificar(dados) {
  return Buffer.from(JSON.stringify(dados)).toString('base64url');
}

function decodificar(cursor, consulta) {
  let dados;
  try {
    dados = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorInvalido();
  }
  if (dados?.v !== 1 || dados.q !== consulta || !Array.isArray(dados.k)) throw new CursorInvalido();
  return dados;
}

/**
 * Página de `itens` já filtrados. `chave(item)` devolve um array comparável por
 * `comparar` (ordem total; o último elemento deve ser um id único).
 *
 * `versao(item)` (opcional) devolve o carimbo de alteração do item. A primeira página
 * grava no cursor o maior carimbo visto (`corte`); nas seguintes, itens com carimbo
 * acima do corte mudaram de lugar durante a travessia e saem da página; `alterados`
 * conta quantos, para o cliente reler do começo se precisar.
 */
export function paginar({ itens, consulta, cursor, limite, chave, comparar, versao }) {
  let corte = null;
  let depois = null;
  if (cursor) {
    const dados = decodificar(cursor, consulta);
    depois = dados.k;
    corte = dados.c ?? null;
  } else if (versao) {
    corte = itens.reduce((m, i) => (m === null || String(versao(i)) > m ? String(versao(i)) : m), null);
  }

  const alterados = cursor && versao && corte !== null ? itens.filter((i) => String(versao(i)) > corte) : [];
  const estaveis = alterados.length ? itens.filter((i) => !alterados.includes(i)) : itens;
  const restantes = depois ? estaveis.filter((i) => comparar(chave(i), depois) > 0) : estaveis;
  const pagina = limite ? restantes.slice(0, limite) : restantes;
  const truncado = pagina.length < restantes.length;

  return {
    pagina,
    truncado,
    proximoCursor: truncado ? codificar({ v: 1, q: consulta, k: chave(pagina.at(-1)), ...(corte !== null ? { c: corte } : {}) }) : null,
    alterados: alterados.length,
  };
}

/** Compara arrays de strings elemento a elemento; `desc[i]` inverte o sentido da posição i. */
export function comparador(desc = []) {
  return (a, b) => {
    for (let i = 0; i < a.length; i++) {
      const x = String(a[i]);
      const y = String(b[i]);
      if (x === y) continue;
      const r = x < y ? -1 : 1;
      return desc[i] ? -r : r;
    }
    return 0;
  };
}
