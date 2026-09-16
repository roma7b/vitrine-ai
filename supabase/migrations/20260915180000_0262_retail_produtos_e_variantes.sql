-- ============================================================================
-- 0262 — VAREJO MÓVEL: PRODUTOS E VARIANTES (Fase 1a, só schema)
--
-- ─── O que este lote de migrations cobre, e o que NÃO cobre ───────────────
-- `MOBILE_RETAIL_DOMAIN.md` §2 desenha 15 tabelas novas para o vertical de
-- loja de celular usado/seminovo (estoque serializado por IMEI, trade-in,
-- reparo, garantia). Este é o PRIMEIRO de 8 migrations que criam as 15 —
-- cada um cobre um cluster apertado (produto+variante aqui; unidade+
-- movimento no próximo; e assim por diante), na ordem que `IMPLEMENTATION_PLAN.md`
-- (Fase 1) e `CLAUDE.md` (doutrina de migrations) pedem: migration pequena e
-- de assunto único, não uma migration gigante. Nenhuma camada de serviço
-- (`lib/retail/`), Zod, rota de API, tela ou tool de IA nasce aqui — é
-- explicitamente FORA de escopo da Fase 1a (`IMPLEMENTATION_PLAN.md`,
-- "Explicitamente fora de escopo da Fase 1"). `fn_retail_reserve_unit` e
-- `fn_retail_complete_sale` (§6) também ficam para a Fase 2, por decisão do
-- próprio plano: reserva/concorrência não é necessária para catálogo puro.
--
-- ─── Por que tabela NOVA, e não `catalog_products` + uma coluna ───────────
-- `MOBILE_RETAIL_DOMAIN.md` §0 já fecha essa pergunta: `catalog_products`
-- (migration 0204) é o catálogo PLANO da loja — um SKU, uma quantidade
-- inteira, sem identidade por unidade física. O domínio novo precisa de
-- IMEI, condição, saúde de bateria e trilha de auditoria POR APARELHO — nada
-- disso cabe numa linha de `catalog_products` sem reinventar a tabela por
-- dentro. As duas convivem: uma loja que vende celular seminovo E capinha
-- usa `retail_*` para o celular e `catalog_products` para a capinha.
--
-- ─── Por que produto e variante são tabelas separadas ─────────────────────
-- Quem tem preço é o SKU ("iPhone 15 Pro 256GB Titânio"), não o modelo
-- ("iPhone 15 Pro") — mesmo raciocínio que levou a 0204 a não ter um "pai"
-- sem preço. Mas aqui HÁ um pai que vale a pena: a busca "tem iPhone 15 Pro?"
-- precisa agrupar variantes antes de perguntar capacidade/cor, e capturar
-- isso em `retail_products` evita repetir marca/categoria/nome em cada linha
-- de variante (doutrina DIRC, letra D — duplicar sem necessidade).
-- ============================================================================

create table if not exists public.retail_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- Vocabulário ABERTO (sem CHECK): uma loja fora do nicho iPhone vende outras
  -- marcas, e trade-in aceita Android. `default 'Apple'` é conveniência de
  -- formulário, não trava de dado.
  brand text default 'Apple',
  model_line text,
  -- 'smartphone' | 'accessory' | 'part' sugeridos pela doc — aberto de
  -- propósito, mesma razão de `catalog_products.categoria`: um clone em outro
  -- nicho de revenda tem categorias diferentes, e travar aqui quebraria o
  -- `update.sh` dele (doutrina de vocabulário aberto, CLAUDE.md).
  category text,
  description text,
  image_url text,
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A lista da tela: ativos primeiro, por nome — mesmo padrão de
-- `catalog_products_org_ativos_idx` (0204).
create index if not exists retail_products_org_ativos_idx
  on public.retail_products (organization_id, active, name);

alter table public.retail_products enable row level security;

drop policy if exists retail_products_select on public.retail_products;
create policy retail_products_select on public.retail_products
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Piso `manager`: cadastrar/editar o catálogo-base decide o que a loja vende
-- e sob que marca — mesmo piso de `catalog_products_write` (0204), não
-- `viewer`/`agent`.
drop policy if exists retail_products_write on public.retail_products;
create policy retail_products_write on public.retail_products
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline
-- alcança toda tabela nova — sem o revoke, o catálogo fica legível pela
-- anon key que vai para o browser (CLAUDE.md, doutrina de migrations #9,
-- aplicada aqui a GRANT de tabela pela mesma razão estrutural).
revoke all on public.retail_products from anon;
grant select, insert, update, delete on public.retail_products to authenticated;
grant all on public.retail_products to service_role;

drop trigger if exists trg_retail_products_updated_at on public.retail_products;
create trigger trg_retail_products_updated_at
  before update on public.retail_products
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_products is
  'O modelo vendável do domínio de varejo móvel (ex.: "iPhone 15 Pro") — sem preço, que vive na variante/unidade. Distinto de catalog_products (0204): este domínio é serializado por IMEI, aquele é estoque plano. Ver MOBILE_RETAIL_DOMAIN.md §2.';
comment on column public.retail_products.brand is
  'Vocabulário aberto (sem CHECK) — trade-in aceita Android, e um clone fora do nicho iPhone vende outras marcas.';
comment on column public.retail_products.category is
  'Vocabulário aberto (sem CHECK) — mesma razão de catalog_products.categoria: travar aqui quebraria o update.sh de um clone com categoria própria.';

-- ============================================================================
-- retail_product_variants — o SKU (ex.: "iPhone 15 Pro 256GB Titânio Natural")
-- ============================================================================

create table if not exists public.retail_product_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.retail_products(id) on delete cascade,

  -- Identidade dentro da organização — mesmo papel que `catalog_products.codigo`
  -- já joga ali (0204: "é ele que a importação de planilha reusa").
  sku text not null,
  storage_gb integer,
  color text,
  -- Bolsa aberta para atributo que não vale coluna ainda (DIRC, letra C) —
  -- CONDIÇÃO-INDEPENDENTE apenas: `storage_gb` já "graduou" para coluna
  -- porque é filtro/ordenação quente (mesma régua que promoveu `tags` a GIN
  -- em vez de ficar preso em jsonb, CLAUDE.md § Modelagem).
  attributes jsonb not null default '{}'::jsonb,

  -- Preço de TABELA/unidade nova — a unidade física pode sobrescrever
  -- (retail_inventory_units.sale_price_cents), porque o preço de um usado
  -- depende de condição. Nullable: variante pode nascer antes de precificada.
  list_price_cents bigint,
  currency text not null default 'BRL',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_product_variants_preco_nao_negativo
    check (list_price_cents is null or list_price_cents >= 0),
  constraint retail_product_variants_moeda_iso
    check (currency ~ '^[A-Z]{3}$')
);

create unique index if not exists retail_product_variants_org_sku_key
  on public.retail_product_variants (organization_id, sku);

create index if not exists retail_product_variants_org_product_idx
  on public.retail_product_variants (organization_id, product_id);

alter table public.retail_product_variants enable row level security;

drop policy if exists retail_product_variants_select on public.retail_product_variants;
create policy retail_product_variants_select on public.retail_product_variants
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_product_variants_write on public.retail_product_variants;
create policy retail_product_variants_write on public.retail_product_variants
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.retail_product_variants from anon;
grant select, insert, update, delete on public.retail_product_variants to authenticated;
grant all on public.retail_product_variants to service_role;

drop trigger if exists trg_retail_product_variants_updated_at on public.retail_product_variants;
create trigger trg_retail_product_variants_updated_at
  before update on public.retail_product_variants
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_product_variants is
  'O SKU dentro de um retail_products — o que efetivamente tem preço de tabela. list_price_cents é o preço de UNIDADE NOVA; uma unidade usada específica pode sobrescrever via retail_inventory_units.sale_price_cents.';
comment on column public.retail_product_variants.sku is
  'Identidade do SKU dentro da organização — unique (organization_id, sku), mesmo papel de catalog_products.codigo.';
comment on column public.retail_product_variants.attributes is
  'Bolsa jsonb para atributo condição-independente que ainda não vale coluna própria (DIRC letra C). storage_gb e color já são colunas porque são filtro/ordenação quente — não promova algo aqui de volta para jsonb.';
comment on column public.retail_product_variants.list_price_cents is
  'Preço de tabela para unidade NOVA/default. Uma retail_inventory_units específica pode ter sale_price_cents próprio — o preço de um usado depende da condição do aparelho, não só do SKU.';
