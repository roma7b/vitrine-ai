-- ============================================================================
-- 0265 — VAREJO MÓVEL: VENDAS E ITENS DE VENDA
--
-- ─── Piso de escrita: `agent`+ na TABELA, não a régua fina do §5 ──────────
-- `MOBILE_RETAIL_DOMAIN.md` §5 fala em piso `manager`+ para "retail_sales
-- status transitions that move money" — mas isso é uma régua sobre
-- TRANSIÇÃO DE STATUS específica (rascunho → pago, por exemplo), não sobre
-- a tabela inteira. RLS de Postgres não enxerga "qual campo mudou dentro do
-- UPDATE" — só enxerga a linha. Modelar aquela nuance aqui exigiria uma
-- trigger BEFORE UPDATE comparando OLD/NEW.status, que é lógica de negócio
-- de transição — exatamente o que `fn_retail_complete_sale` (Fase 2, §6)
-- existe para fazer com `security definer` e advisory lock, não RLS solta
-- numa tabela de Fase 1. Piso da TABELA aqui é `agent`+, pelo motivo que a
-- doc já dá: "front-desk staff can create draft sales" — abrir um rascunho
-- de venda é trabalho de balcão. A régua fina de "só quem pode mover
-- dinheiro completa a venda" chega na Fase 2 como código de aplicação
-- (`fn_retail_complete_sale`) sobre esta mesma tabela, não como uma segunda
-- policy aqui.
-- ============================================================================

create table if not exists public.retail_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  contact_id uuid references public.contacts(id),
  -- Nullable: venda de balcão avulsa pode não ter lead nenhum (§2). Ligação
  -- com o funil do CRM é sempre um FK simples — NÃO polimórfica no nível de
  -- schema (a doc é explícita: crm_lead_links, se algum dia usado aqui, é
  -- responsabilidade de camada de aplicação, fora desta fatia).
  crm_lead_id uuid references public.crm_leads(id),
  sold_by_user_id uuid references auth.users(id),

  -- Vocabulário ABERTO (sem CHECK) — 'pos'/'whatsapp'/'online' sugeridos
  -- pela doc, mas um clone pode ganhar canal próprio sem migration.
  channel text,
  -- Fechado por CHECK — máquina de estados que Fase 2 (fn_retail_complete_sale)
  -- ramifica sobre o conjunto exato.
  status text not null default 'draft',

  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  total_cents bigint not null default 0,
  currency text not null default 'BRL',
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_sales_status_check check (
    status = any (array[
      'draft', 'awaiting_payment', 'paid', 'completed', 'cancelled', 'refunded'
    ]::text[])
  ),
  constraint retail_sales_subtotal_nao_negativo check (subtotal_cents >= 0),
  constraint retail_sales_discount_nao_negativo check (discount_cents >= 0),
  constraint retail_sales_total_nao_negativo check (total_cents >= 0),
  constraint retail_sales_moeda_iso check (currency ~ '^[A-Z]{3}$')
);

create index if not exists retail_sales_org_status_idx
  on public.retail_sales (organization_id, status);

create index if not exists retail_sales_org_contact_idx
  on public.retail_sales (organization_id, contact_id);

alter table public.retail_sales enable row level security;

drop policy if exists retail_sales_select on public.retail_sales;
create policy retail_sales_select on public.retail_sales
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_sales_write on public.retail_sales;
create policy retail_sales_write on public.retail_sales
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.retail_sales from anon;
grant select, insert, update, delete on public.retail_sales to authenticated;
grant all on public.retail_sales to service_role;

drop trigger if exists trg_retail_sales_updated_at on public.retail_sales;
create trigger trg_retail_sales_updated_at
  before update on public.retail_sales
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_sales is
  'A venda de balcão/POS. Piso de escrita da TABELA é agent+ (front-desk abre rascunho); a régua mais fina "só quem move dinheiro completa a venda" (§5) chega na Fase 2 como fn_retail_complete_sale (security definer), não como policy nesta migration — ver o cabeçalho.';
comment on column public.retail_sales.crm_lead_id is
  'FK simples e nullable para crm_leads — venda de balcão avulsa pode não ter lead. Ligação polimórfica via crm_lead_links (se usada) é responsabilidade de aplicação, fora do schema desta tabela.';

-- ============================================================================
-- retail_sale_items — a linha da venda: unidade serializada OU item de catálogo
-- ============================================================================

create table if not exists public.retail_sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  sale_id uuid not null references public.retail_sales(id) on delete cascade,
  -- Exatamente um dos dois abaixo é não-nulo — CHECK logo adiante. Quando
  -- inventory_unit_id é setado, é um aparelho com IMEI específico; quando
  -- catalog_product_id é setado, é um acessório do catálogo plano (0204)
  -- vendido na mesma cesta.
  inventory_unit_id uuid references public.retail_inventory_units(id),
  catalog_product_id uuid references public.catalog_products(id),

  -- Snapshot do que foi vendido — retail_products/catalog_products podem
  -- mudar de nome depois, e o recibo não pode (§2).
  description text not null,
  unit_price_cents bigint not null,
  quantity integer not null default 1,
  line_total_cents bigint not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- O either/or: uma linha de venda é um aparelho específico OU um item de
  -- catálogo, nunca os dois, nunca nenhum.
  constraint retail_sale_items_exatamente_um_produto
    check (num_nonnulls(inventory_unit_id, catalog_product_id) = 1),
  -- Unidade serializada não é "quantidade 3" — um IMEI é um IMEI (§2).
  constraint retail_sale_items_quantidade_unitaria_se_serializado
    check (inventory_unit_id is null or quantity = 1),
  constraint retail_sale_items_quantity_positiva check (quantity > 0),
  constraint retail_sale_items_preco_nao_negativo check (unit_price_cents >= 0),
  constraint retail_sale_items_total_nao_negativo check (line_total_cents >= 0)
);

create index if not exists retail_sale_items_org_sale_idx
  on public.retail_sale_items (organization_id, sale_id);

create index if not exists retail_sale_items_org_inventory_unit_idx
  on public.retail_sale_items (organization_id, inventory_unit_id)
  where inventory_unit_id is not null;

alter table public.retail_sale_items enable row level security;

drop policy if exists retail_sale_items_select on public.retail_sale_items;
create policy retail_sale_items_select on public.retail_sale_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_sale_items_write on public.retail_sale_items;
create policy retail_sale_items_write on public.retail_sale_items
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.retail_sale_items from anon;
grant select, insert, update, delete on public.retail_sale_items to authenticated;
grant all on public.retail_sale_items to service_role;

drop trigger if exists trg_retail_sale_items_updated_at on public.retail_sale_items;
create trigger trg_retail_sale_items_updated_at
  before update on public.retail_sale_items
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_sale_items is
  'Uma linha da venda: OU um aparelho serializado (inventory_unit_id) OU um item de catalog_products (catalog_product_id) — nunca os dois, nunca nenhum (constraint retail_sale_items_exatamente_um_produto, num_nonnulls = 1). description é snapshot imutável do que foi vendido.';
comment on column public.retail_sale_items.quantity is
  'Sempre 1 quando inventory_unit_id está setado — um IMEI não é "quantidade 3" (constraint retail_sale_items_quantidade_unitaria_se_serializado). Livre para item de catálogo.';

-- ============================================================================
-- FKs adiadas da 0263 — retail_sales e retail_sale_items agora existem.
-- ============================================================================

alter table public.retail_inventory_units
  drop constraint if exists retail_inventory_units_reserved_for_sale_id_fkey;
alter table public.retail_inventory_units
  add constraint retail_inventory_units_reserved_for_sale_id_fkey
  foreign key (reserved_for_sale_id) references public.retail_sales(id);

alter table public.retail_inventory_units
  drop constraint if exists retail_inventory_units_sold_in_sale_item_id_fkey;
alter table public.retail_inventory_units
  add constraint retail_inventory_units_sold_in_sale_item_id_fkey
  foreign key (sold_in_sale_item_id) references public.retail_sale_items(id);

alter table public.retail_inventory_movements
  drop constraint if exists retail_inventory_movements_related_sale_id_fkey;
alter table public.retail_inventory_movements
  add constraint retail_inventory_movements_related_sale_id_fkey
  foreign key (related_sale_id) references public.retail_sales(id);
