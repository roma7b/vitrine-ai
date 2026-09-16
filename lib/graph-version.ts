/**
 * A VERSÃO DA GRAPH API TEM UM LUGAR SÓ.
 *
 * O número estava escrito à mão em dez arquivos de produção, sempre com o mesmo
 * `"v22.0"` copiado. A cópia é o defeito: no dia do bump, quem sobe a versão
 * edita dez lugares e esquece um — o esquecido não falha, ele responde. A
 * instalação passa a falar duas versões da mesma plataforma, e o sintoma chega
 * como "o template aprovado não envia" numa tela só.
 *
 * O número mora aqui. Quem cobra é
 * `tests/unit/versao-da-graph-num-lugar-so.test.ts`: literal de versão da Graph
 * fora deste arquivo reprova a suíte.
 *
 * NÃO SUBIU DE VERSÃO AQUI — de propósito. A v26.0 saiu em 29/07/2026, e subir
 * é decisão de manutenção, com reconferência de campo a campo antes (a lição
 * medida em `lib/plataformas-de-anuncio/meta/insights.ts`: campo válido some
 * entre versões, sem aviso). Esta mudança só diz ONDE o número mora; o número
 * continua o mesmo de hoje.
 *
 * Dois eixos, um número só:
 * - `graphVersion()` — canais de mensagem (`lib/channels/**`,
 *   `app/api/v1/channels/**`, `scripts/spike-*`) e honra `META_GRAPH_VERSION`,
 *   como o `.env.example` já documenta. Sem a variável, cai no default.
 * - `VERSAO_PADRAO_DA_GRAPH` — o eixo de anúncio
 *   (`lib/plataformas-de-anuncio/meta/**`), que usa o MESMO número de
 *   propósito (a instalação não deve conviver com duas versões da plataforma),
 *   mas NÃO herda a variável do canal de mensagem: são credenciais e ciclos de
 *   vida diferentes. É por isso que o override vive na função, e não na
 *   constante.
 *
 * ─── Um terceiro eixo, adicionado para o BSP Datafy: o HOST ────────────────
 *
 * `graphVersion()` resolve QUAL versão da Graph falar; `graphBaseUrl()`,
 * abaixo, resolve COM QUEM falar. Até aqui `https://graph.facebook.com` era
 * literal nos três `fetch` de `lib/channels/adapters/meta-cloud.ts` — bastava
 * para uma instalação que só fala com a Meta direto. A Datafy
 * (`https://app.datafyapi.com.br/docs`) é um BSP homologado pela própria Meta
 * que espelha a Cloud API 1:1 (mesmo formato de payload e endpoint, só troca
 * host e token) e permite conectar um número SEM passar pelo app-review da
 * Meta Business Manager — é por isso que o host precisa parar de ser fixo.
 * Mesma regra de "vazio conta como ausente" do eixo de versão, e o mesmo
 * motivo: instalação que nunca setou a variável não pode notar diferença
 * nenhuma.
 */

/** O default da instalação. `bump` aqui é mudança deliberada, não deriva. */
export const VERSAO_PADRAO_DA_GRAPH = "v22.0";

/**
 * A versão com que a Graph API é chamada hoje.
 *
 * `META_GRAPH_VERSION` continua mandando quando existe — instalação que já
 * apontou a variável para outra versão segue apontada.
 *
 * Vazia (ou só espaço) conta como ausente: `??` devolveria a string vazia e o
 * endereço sairia com um separador a mais, sem versão no meio. `META_GRAPH_VERSION=`
 * é estado real de quem copiou o `.env.example` e apagou o valor.
 */
export function graphVersion(): string {
  const daVariavel = process.env.META_GRAPH_VERSION?.trim();
  return daVariavel ? daVariavel : VERSAO_PADRAO_DA_GRAPH;
}

/** O default da instalação: fala direto com a Meta, como hoje. */
export const BASE_URL_PADRAO_DA_GRAPH = "https://graph.facebook.com";

/**
 * O host com que a Graph API é chamada hoje.
 *
 * `META_GRAPH_BASE_URL` manda quando existe — é o que uma instalação conectada
 * via Datafy aponta para `https://cloud.datafyapi.com.br` (ou o host que a
 * Datafy documentar). Sem a variável, cai no host direto da Meta: instalação
 * que nunca ouviu falar de BSP continua se comportando exatamente como antes.
 *
 * Vazia (ou só espaço) conta como ausente, pela mesma razão de `graphVersion()`:
 * `META_GRAPH_BASE_URL=` é o que sobra de quem copiou o `.env.example` e
 * apagou o valor, e `??` sozinho devolveria string vazia em vez do default.
 */
export function graphBaseUrl(): string {
  const daVariavel = process.env.META_GRAPH_BASE_URL?.trim();
  return daVariavel ? daVariavel : BASE_URL_PADRAO_DA_GRAPH;
}
