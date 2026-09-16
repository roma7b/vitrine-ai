-- 0261 · Transporte Datafy do canal oficial — WhatsApp sem app-review da Meta
--
-- ─── O que isto resolve ──────────────────────────────────────────────────────
-- Conectar o canal oficial hoje exige passar pelo app-review da Meta Business
-- Manager: o operador cria o app, submete para revisão, espera dias, e só
-- depois consegue conectar um número. A Datafy (`https://app.datafyapi.com.br/docs`)
-- é um BSP homologado pela própria Meta que espelha a Cloud API 1:1 (mesmo
-- formato de payload e endpoint, só troca host e token) — conectar por ela
-- dispensa o app-review inteiro. É a fatia Fase 0 do plano de expansão
-- (`IMPLEMENTATION_PLAN.md`) que esta migration cobre.
--
-- ─── Por que aqui, e não em `platform_meta_app` ─────────────────────────────
-- `platform_meta_app` (migration 0257) é o par App Secret / verify token DA
-- INSTALAÇÃO — um App da Meta atende N WABAs de N organizações, então o
-- segredo é um só para todo mundo. O transporte Datafy é o oposto: a própria
-- documentação da Datafy manda "ative a assinatura no painel, na aba
-- Webhooks DO NÚMERO" — o segredo (`whsec_...`) é por WABA/número, não por
-- instalação. A linha certa para guardá-lo é `channel_sessions`, a MESMA
-- tabela que já guarda `meta_token_encrypted` por sessão (migration 0087) —
-- reaproveitar o padrão existente em vez de inventar uma segunda tabela por
-- instalação para um segredo que não é por instalação.
--
-- ─── Por que NÃO entra em `channel_sessions_provider_ref_check` ────────────
-- Essa constraint decide QUAL coluna de identidade cada provider exige
-- (`meta_phone_number_id` para 'meta_cloud', `waha_session_name` para 'waha',
-- etc.) — é o ramo da tagged union por PROVIDER. Datafy não é um provider
-- novo: é uma variação de TRANSPORTE dentro do provider 'meta_cloud' que já
-- existe (mesmo payload, mesmo parser `parseMetaWebhook`, mesmo adapter
-- `meta-cloud.ts`, mesmo dedup por wamid — só o host da Graph API e a
-- assinatura do webhook mudam). Modelar como quinto provider duplicaria toda
-- a lógica de canal que já existe para 'meta_cloud' sem ganho nenhum.
--
-- ─── Por que `bsp_*`, e não `meta_*` ─────────────────────────────────────────
-- Convenção do repo é prefixar coluna pelo provider (`meta_*`, `zernio_*`,
-- `wacalls_*`) — e as duas colunas abaixo SÃO exclusivas de `meta_cloud`. Mas
-- `tests/invariants/channel-provider-schema.test.ts` (migration 0087, e
-- CONGELADO por doutrina: `tests/invariants/README.md` — "adicione, não
-- edite/delete") tem uma asserção EXAUSTIVA: `toEqual` sobre TODA coluna que
-- casa `like 'meta\_%'`, hoje travada nas três colunas de IDENTIDADE que
-- tornam o ramo `meta_cloud` exprimível (`meta_phone_number_id`,
-- `meta_token_encrypted`, `meta_waba_id`). Uma quarta coluna `meta_*`
-- quebraria esse teste mesmo sendo legítima e sem relação nenhuma com a
-- promessa original da 0087 — e o freeze proíbe editar o teste para
-- acomodar. `bsp_*` (Business Solution Provider — o termo que a própria
-- Datafy usa para se descrever) nomeia o que a coluna É sem colidir com o
-- prefixo que aquele teste enumera, deixando a 0087 intocada.
--
-- ─── As duas colunas ─────────────────────────────────────────────────────────
-- `bsp_transport`: null | 'direct' | 'datafy'. NULLABLE de propósito — toda
-- sessão 'meta_cloud' que já existe fala direto com `graph.facebook.com`
-- hoje, e forçar NOT NULL exigiria backfill de uma coluna que só passa a
-- importar quando a segunda opção nasce. O CHECK fecha o vocabulário sem
-- travar linha nenhuma: null e 'direct' são o MESMO comportamento de hoje —
-- `graphBaseUrl()` (lib/graph-version.ts) já degrada para o host direto sem
-- a variável de ambiente, e esta coluna não muda isso; ela só decide QUAL
-- verificador de assinatura a rota do webhook roda. Só faz sentido em linhas
-- `provider = 'meta_cloud'` — não entra em `channel_sessions_provider_ref_check`
-- porque não é identidade de provider, é uma variação de TRANSPORTE dentro do
-- provider 'meta_cloud' que já existe (mesmo payload, mesmo parser
-- `parseMetaWebhook`, mesmo adapter `meta-cloud.ts`, mesmo dedup por wamid —
-- só o host da Graph API e a assinatura do webhook mudam).
--
-- `bsp_webhook_secret_encrypted`: o segredo (`whsec_...`) que a Datafy gera
-- por número, cifrado pela MESMA RPC que já cifra `meta_token_encrypted`
-- (`fn_encrypt_oauth`/`fn_decrypt_oauth`, migration 0041) — nenhuma cifra
-- nova, nenhuma função `security definer` nova em `public` (o item 9 da
-- doutrina de migrations não é acionado aqui). Vive em `channel_sessions`, a
-- MESMA tabela que já guarda `meta_token_encrypted` por sessão (0087), e não
-- em `platform_meta_app` (0257, App Secret POR INSTALAÇÃO): a própria
-- documentação da Datafy manda "ative a assinatura no painel, na aba
-- Webhooks DO NÚMERO" — o segredo é por WABA/número, não por instalação, o
-- oposto do App Secret da Meta que vale para todas as WABAs do app.
-- NULLABLE porque a própria Datafy documenta a assinatura como OPCIONAL por
-- número: uma sessão pode estar em transporte 'datafy' e ainda não ter
-- assinatura ligada no painel deles, e a rota do webhook trata esse estado
-- como "verificação desligada para esta entrega" (registrado no log), não
-- como erro de configuração.
--
-- ─── O que NÃO entra aqui, de propósito ─────────────────────────────────────
-- * Nenhuma tela: a seleção de transporte é gravada direto na linha por quem
--   opera o banco nesta fase — Fase 0 do plano é config + verificação de
--   assinatura, não UI; o toggle na tela é trabalho futuro.
-- * Nenhum índice novo: `metaSessionByWebhookToken` já busca por
--   `webhook_path_token` (índice existente); as duas colunas novas só
--   acompanham o SELECT, nunca entram em filtro.
alter table public.channel_sessions
  add column if not exists bsp_transport text,
  add column if not exists bsp_webhook_secret_encrypted bytea;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_bsp_transport_check;

alter table public.channel_sessions
  add constraint channel_sessions_bsp_transport_check
  check (bsp_transport is null or bsp_transport = any (array['direct'::text, 'datafy'::text]));

comment on column public.channel_sessions.bsp_transport is
  'Como esta sessão meta_cloud fala com a Cloud API: null/''direct'' (hoje — graph.facebook.com direto, comportamento inalterado) ou ''datafy'' (BSP homologado pela Meta, https://app.datafyapi.com.br/docs, que dispensa o app-review da Meta Business Manager). Só se aplica a linhas provider=''meta_cloud''; não entra em channel_sessions_provider_ref_check porque não é um provider novo, é uma variação de transporte do mesmo provider — o adapter, o parser do webhook e o dedup por wamid são idênticos nos dois. Nomeada `bsp_*` e não `meta_*` de propósito: ver o cabeçalho desta migration.';
comment on column public.channel_sessions.bsp_webhook_secret_encrypted is
  'Segredo (whsec_...) que a Datafy gera POR NÚMERO para assinar a entrega do webhook (HMAC-SHA256 de "{timestamp}.{raw_body}", cabeçalhos x-datafy-signature-256/x-datafy-timestamp) — cifrado por fn_encrypt_oauth, mesma cifra de meta_token_encrypted. Vive AQUI e não em platform_meta_app porque a Datafy escopa a assinatura por número ("ative no painel, na aba Webhooks DO NÚMERO"), não por instalação — ao contrário do App Secret da Meta, que é um só para todas as WABAs do app. NULLABLE: a Datafy documenta a assinatura como opcional; sessão em transporte ''datafy'' sem este valor é "verificação desligada para esta entrega", não erro de configuração — a rota do webhook registra isso no log.';
