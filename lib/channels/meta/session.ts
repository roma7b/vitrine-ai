/**
 * Resolução da sessão dona de um webhook da Meta.
 *
 * Existe porque o `lint-channels` me pegou: a rota `/api/v1/webhooks/meta/[token]`
 * cravava `.eq("provider", "meta_cloud")`, e nome de provider fora de
 * `lib/channels/` viola o invariante 1 da doutrina de restrição de canal.
 *
 * A tentação era pôr a rota na allowlist do lint — afinal, um endpoint de webhook
 * É inerentemente específico do provider (o protocolo da Meta não é o do WAHA).
 * Mas allowlist sem conserto é dívida silenciosa: o nome continuaria espalhado, e a
 * próxima rota copiaria o padrão. Mover a query para cá custa 20 linhas e mantém a
 * regra valendo de verdade — a rota vira transporte puro e não sabe com quem fala.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVED_AT, queryTolerantToMissingArchived, type DbErrorLike } from "../archived";
import { CHANNEL_PROVIDER_META } from "../capabilities";

/**
 * "As colunas da migration 0261 não existem neste banco" — mesmo defeito que
 * `archived.ts` já documenta para `archived_at` (42703 do Postgres quando a
 * coluna entra em SELECT/filtro), aplicado às duas colunas que
 * `metaSessionByWebhookToken` passou a pedir. Sem esta tolerância, TODO
 * webhook direto-Meta (não só Datafy) responderia 404 em qualquer clone que
 * ainda não rodou a migration — o `update.sh` aplica código e banco em passos
 * separados, e código novo chega primeiro.
 */
function isTransportColumnsMissing(error: DbErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  const msg = error.message ?? "";
  return msg.includes("bsp_transport") || msg.includes("bsp_webhook_secret_encrypted");
}

export interface MetaWebhookSession {
  id: string;
  organizationId: string;
  wabaId: string | null;
  /**
   * Com quem esta sessão fala: `'direct'` (hoje, `graph.facebook.com`) ou
   * `'datafy'` (BSP homologado pela Meta, dispensa app-review — migration
   * 0261). `channel_sessions.bsp_transport` nasce `null`, e aqui já chega
   * normalizado para `'direct'` — quem lê esta interface nunca vê o `null`
   * do banco, só o vocabulário fechado que a rota do webhook usa para
   * escolher o verificador de assinatura.
   */
  transport: "direct" | "datafy";
  /**
   * `channel_sessions.bsp_webhook_secret_encrypted`, ainda cifrado (hex
   * de `fn_encrypt_oauth`) — quem usa decifra com `decryptWebhookSecret`.
   * `null` quando a sessão não é `datafy` OU quando é `datafy` mas o
   * operador ainda não ligou a assinatura no painel da Datafy (opcional lá).
   */
  datafySecretEncrypted: string | null;
}

/**
 * A sessão oficial ATIVA da organização **e o número dela**.
 *
 * O par `(organization_id, meta_phone_number_id)` é a chave com que
 * `resolveMetaCreds` acha a credencial que o operador salvou na tela — a mesma porta
 * que `send`, `checkHealth` e `fetchInboundMedia` já usam. Mora aqui, e não na rota,
 * porque nome de provider fora de `lib/channels/` viola o invariante 1 (o
 * `lint-channels` pegou isso uma vez e a lição ficou); e existe como interface
 * própria para não obrigar a sessão do WEBHOOK, que não tem número, a carregar um
 * campo que ela nunca preenche.
 */
export interface MetaSessaoDaOrg extends MetaWebhookSession {
  /** `channel_sessions.meta_phone_number_id` — `null` em base anterior à 0144. */
  phoneNumberId: string | null;
}

/**
 * Sessão amarrada a este token de webhook. `null` = token desconhecido (a rota
 * responde 404 sem revelar por quê).
 *
 * O token no path é o que amarra o payload a UMA organização. O App Secret da Meta
 * é do APP e vale para todas as WABAs de todos os tenants — sozinho, ele autentica
 * a origem mas não decide o destino. Sem o token, quem conhecesse o segredo
 * escreveria em qualquer organização.
 *
 * Canal ARQUIVADO conta como token desconhecido, e essa é a única resposta
 * honesta: o usuário mandou excluir o canal. A exclusão já revoga a credencial e
 * rotaciona este token, mas o evento em voo (e a re-entrega que a plataforma faz
 * de tudo que não recebe 2xx) chegaria com o token antigo e ressuscitaria o
 * canal — criando contato, conversa e mensagem num inbox onde o operador nem
 * consegue responder, porque o arquivamento deixa a sessão STOPPED.
 */
export async function metaSessionByWebhookToken(
  token: string,
): Promise<MetaWebhookSession | null> {
  if (!token || token.length < 8) return null;

  const admin = createAdminClient();
  const comTransporte = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, meta_waba_id, bsp_transport, bsp_webhook_secret_encrypted")
      .eq("webhook_path_token", token)
      .eq("provider", CHANNEL_PROVIDER_META);
  const primeira = await queryTolerantToMissingArchived(
    () => comTransporte().is(ARCHIVED_AT, null).maybeSingle(),
    () => comTransporte().maybeSingle(),
  );

  if (isTransportColumnsMissing(primeira.error)) {
    // Clone sem a 0261: repete a MESMA consulta que existia antes desta
    // migration. `direct`/`null` é o comportamento de sempre — nenhuma
    // entrega direto-Meta passa a falhar por causa de uma coluna que este
    // banco ainda não tem.
    const semTransporte = () =>
      admin
        .from("channel_sessions")
        .select("id, organization_id, meta_waba_id")
        .eq("webhook_path_token", token)
        .eq("provider", CHANNEL_PROVIDER_META);
    const { data } = await queryTolerantToMissingArchived(
      () => semTransporte().is(ARCHIVED_AT, null).maybeSingle(),
      () => semTransporte().maybeSingle(),
    );
    if (!data) return null;
    return {
      id: data.id,
      organizationId: data.organization_id,
      wabaId: data.meta_waba_id ?? null,
      transport: "direct",
      datafySecretEncrypted: null,
    };
  }

  const { data } = primeira;
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    // `null` (toda linha pré-0261) e `'direct'` são o MESMO estado — ver o
    // comentário da migration. Só `'datafy'` muda o verificador que a rota roda.
    transport: data.bsp_transport === "datafy" ? "datafy" : "direct",
    datafySecretEncrypted: data.bsp_webhook_secret_encrypted ?? null,
  };
}

/**
 * A sessão oficial ATIVA da organização (se houver). Usada pela tela de templates
 * para saber QUAL WABA espelhar — e para dizer ao operador o que fazer quando não
 * há nenhuma, em vez de mostrar uma tabela vazia sem explicação.
 *
 * Arquivada não conta: sem o filtro, a tela seguia nomeando a WABA de um canal
 * que o operador excluiu e o botão de sincronizar continuava puxando templates
 * dela — o token do env não foi revogado junto com o da linha, então a chamada
 * ia mesmo. "Excluído" que continua operando é a promessa quebrada.
 */
export async function metaSessionForOrg(
  organizationId: string,
): Promise<MetaSessaoDaOrg | null> {
  const admin = createAdminClient();
  const comTransporte = () =>
    admin
      .from("channel_sessions")
      // `meta_phone_number_id` entra na seleção porque é a segunda metade da chave da
      // credencial (`organization_id` + ele): sem o número, quem chama não tem como
      // pedir a credencial DESTA sessão e volta a olhar o ambiente — que é o defeito
      // que a fatia F4 da #850 fecha. `bsp_transport`/`bsp_webhook_secret_encrypted`
      // entram para `MetaSessaoDaOrg` continuar satisfazendo `MetaWebhookSession` —
      // esta função não decide verificação de assinatura, só devolve o par completo.
      .select(
        "id, organization_id, meta_waba_id, meta_phone_number_id, bsp_transport, bsp_webhook_secret_encrypted",
      )
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true })
      .limit(1);
  const primeira = await queryTolerantToMissingArchived(
    () => comTransporte().is(ARCHIVED_AT, null).maybeSingle(),
    () => comTransporte().maybeSingle(),
  );

  if (isTransportColumnsMissing(primeira.error)) {
    // Mesmo motivo de `metaSessionByWebhookToken`: clone sem a 0261 não pode
    // ver a tela de templates quebrar por causa de duas colunas que ele não tem.
    const semTransporte = () =>
      admin
        .from("channel_sessions")
        .select("id, organization_id, meta_waba_id, meta_phone_number_id")
        .eq("organization_id", organizationId)
        .eq("provider", CHANNEL_PROVIDER_META)
        .order("created_at", { ascending: true })
        .limit(1);
    const { data } = await queryTolerantToMissingArchived(
      () => semTransporte().is(ARCHIVED_AT, null).maybeSingle(),
      () => semTransporte().maybeSingle(),
    );
    if (!data) return null;
    return {
      id: data.id,
      organizationId: data.organization_id,
      wabaId: data.meta_waba_id ?? null,
      phoneNumberId: data.meta_phone_number_id ?? null,
      transport: "direct",
      datafySecretEncrypted: null,
    };
  }

  const { data } = primeira;
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    wabaId: data.meta_waba_id ?? null,
    phoneNumberId: data.meta_phone_number_id ?? null,
    transport: data.bsp_transport === "datafy" ? "datafy" : "direct",
    datafySecretEncrypted: data.bsp_webhook_secret_encrypted ?? null,
  };
}
