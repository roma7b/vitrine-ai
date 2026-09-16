-- ============================================================================
-- 0264 — VAREJO MÓVEL: FORNECEDORES, COMPRAS E ITENS DE COMPRA
--
-- ─── O que este migration acrescenta, além das três tabelas ───────────────
-- Amarra as FKs que a 0263 deixou soltas (`retail_inventory_units.supplier_id`,
-- `.purchase_item_id`; `retail_inventory_movements.related_purchase_id`) —
-- ver o cabeçalho da 0263 para o raciocínio de por que elas nasceram sem
-- `references` e são fechadas aqui, na primeira migration em que a tabela
-- do outro lado passa a existir.
--
-- ─── Por que `retail_purchase_items` não cria unidade sozinha ─────────────
-- Uma linha de item de compra é "compramos 10 deste SKU" — cada um dos 10
-- vira sua PRÓPRIA `retail_inventory_units` (status inicial `RECEIVING`) só
-- no momento em que é fisicamente conferido, não no momento da compra. Essa
-- operação (spawnar N unidades a partir de um item de compra) é rota de API
-- (`.../purchases/[id]/receive/route.ts`, IMPLEMENTATION_PLAN.md Fase 1) —
-- fora de escopo desta fatia só-schema. O que este migration garante é só a
-- FORMA do dado: `purchase_item_id` em `retail_inventory_units` é o ponteiro
-- de volta que aquela rota, quando existir, vai preencher.
-- ============================================================================

create table if not exists public.retail_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  -- CNPJ/CPF — texto livre de propósito: máscara e validação de dígito
  -- verificador são responsabilidade do Zod da camada de serviço (Fase 1,
  -- fora de escopo aqui), não do schema.
  document text,
  contact_phone text,
  contact_email text,
  notes text,
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists retail_suppliers_org_ativos_idx
  on public.retail_suppliers (organization_id, active, name);

alter table public.retail_suppliers enable row level security;

drop policy if exists retail_suppliers_select on public.retail_suppliers;
create policy retail_suppliers_select on public.retail_suppliers
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_suppliers_write on public.retail_suppliers;
create policy retail_suppliers_write on public.retail_suppliers
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

revoke all on public.retail_suppliers from anon;
grant select, insert, update, delete on public.retail_suppliers to authenticated;
grant all on public.retail_suppliers to service_role;

drop trigger if exists trg_retail_suppliers_updated_at on public.retail_suppliers;
create trigger trg_retail_suppliers_updated_at
  before update on public.retail_suppliers
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_suppliers is
  'Quem vende aparelho/peça pra loja. Documento (CNPJ/CPF) é texto livre — validação vive no Zod da camada de serviço, não no schema.';

-- ============================================================================
-- retail_purchases — o pedido de compra
-- ============================================================================

create table if not exists public.retail_purchases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  supplier_id uuid references public.retail_suppliers(id),
  purchase_date date,
  invoice_number text,
  total_cost_cents bigint,
  currency text not null default 'BRL',
  -- Fechado por CHECK: três estados que o fluxo de recebimento ramifica
  -- (§2 — "draft"/"received"/"cancelled").
  status text not null default 'draft',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_purchases_status_check
    check (status = any (array['draft', 'received', 'cancelled']::text[])),
  constraint retail_purchases_total_nao_negativo
    check (total_cost_cents is null or total_cost_cents >= 0),
  constraint retail_purchases_moeda_iso check (currency ~ '^[A-Z]{3}$')
);

create index if not exists retail_purchases_org_status_idx
  on public.retail_purchases (organization_id, status);

alter table public.retail_purchases enable row level security;

drop policy if exists retail_purchases_select on public.retail_purchases;
create policy retail_purchases_select on public.retail_purchases
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_purchases_write on public.retail_purchases;
create policy retail_purchases_write on public.retail_purchases
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

revoke all on public.retail_purchases from anon;
grant select, insert, update, delete on public.retail_purchases to authenticated;
grant all on public.retail_purchases to service_role;

drop trigger if exists trg_retail_purchases_updated_at on public.retail_purchases;
create trigger trg_retail_purchases_updated_at
  before update on public.retail_purchases
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_purchases is
  'O pedido de compra de fornecedor. "received" é o status que a rota de API (Fase 1, fora de escopo aqui) usa como gatilho para spawnar retail_inventory_units a partir dos itens.';

-- ============================================================================
-- retail_purchase_items — a linha "compramos N deste SKU"
-- ============================================================================

create table if not exists public.retail_purchase_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  purchase_id uuid not null references public.retail_purchases(id) on delete cascade,
  variant_id uuid not null references public.retail_product_variants(id),
  quantity integer not null,
  unit_cost_cents bigint not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_purchase_items_quantity_positiva check (quantity > 0),
  constraint retail_purchase_items_custo_nao_negativo check (unit_cost_cents >= 0)
);

create index if not exists retail_purchase_items_org_purchase_idx
  on public.retail_purchase_items (organization_id, purchase_id);

alter table public.retail_purchase_items enable row level security;

drop policy if exists retail_purchase_items_select on public.retail_purchase_items;
create policy retail_purchase_items_select on public.retail_purchase_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_purchase_items_write on public.retail_purchase_items;
create policy retail_purchase_items_write on public.retail_purchase_items
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

revoke all on public.retail_purchase_items from anon;
grant select, insert, update, delete on public.retail_purchase_items to authenticated;
grant all on public.retail_purchase_items to service_role;

drop trigger if exists trg_retail_purchase_items_updated_at on public.retail_purchase_items;
create trigger trg_retail_purchase_items_updated_at
  before update on public.retail_purchase_items
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_purchase_items is
  '"Compramos N deste SKU" — cada uma das N unidades vira sua própria retail_inventory_units (status RECEIVING) só no recebimento físico, carregando purchase_item_id e cost_cents de volta para esta linha. Esta tabela NÃO cria unidade sozinha (ver cabeçalho desta migration).';

-- ============================================================================
-- FKs adiadas da 0263 — agora que retail_suppliers e retail_purchase_items
-- existem, amarramos as colunas que nasceram como uuid plano.
-- ============================================================================

alter table public.retail_inventory_units
  drop constraint if exists retail_inventory_units_supplier_id_fkey;
alter table public.retail_inventory_units
  add constraint retail_inventory_units_supplier_id_fkey
  foreign key (supplier_id) references public.retail_suppliers(id);

alter table public.retail_inventory_units
  drop constraint if exists retail_inventory_units_purchase_item_id_fkey;
alter table public.retail_inventory_units
  add constraint retail_inventory_units_purchase_item_id_fkey
  foreign key (purchase_item_id) references public.retail_purchase_items(id);

alter table public.retail_inventory_movements
  drop constraint if exists retail_inventory_movements_related_purchase_id_fkey;
alter table public.retail_inventory_movements
  add constraint retail_inventory_movements_related_purchase_id_fkey
  foreign key (related_purchase_id) references public.retail_purchases(id);
