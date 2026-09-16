-- ============================================================================
-- 0268 — VAREJO MÓVEL: ORDENS DE REPARO
--
-- `inventory_unit_id` é nullable e o caso comum é NULL: consertar aparelho
-- do CLIENTE (que não é estoque da loja) é a operação mais frequente. Só é
-- setado quando a loja conserta uma unidade PRÓPRIA — ex.: reforma pré-venda
-- de um trade-in. `imei` aqui é só auxílio de busca para aparelho de
-- cliente sem linha em retail_inventory_units — NÃO é único-restrito como
-- lá: o registro de identidade de um aparelho SERIALIZADO DA LOJA continua
-- sendo retail_inventory_units.imei, esta coluna nunca compete com aquela.
-- ============================================================================

create table if not exists public.retail_repair_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  contact_id uuid references public.contacts(id),
  crm_lead_id uuid references public.crm_leads(id),
  -- Nullable, caso comum: reparo de aparelho do CLIENTE, que não é estoque
  -- da loja. Só setado quando a loja repara unidade PRÓPRIA (pré-venda).
  inventory_unit_id uuid references public.retail_inventory_units(id),
  device_description text,
  -- Auxílio de busca para aparelho de cliente sem linha em
  -- retail_inventory_units — de propósito SEM unique/partial-unique: o
  -- registro de identidade de unidade serializada da LOJA é
  -- retail_inventory_units.imei; esta coluna não compete com aquela.
  imei text,
  issue_description text,
  diagnosis text,
  status text not null default 'received',
  quoted_cost_cents bigint,
  final_cost_cents bigint,
  technician_user_id uuid references auth.users(id),
  received_at timestamptz,
  promised_at timestamptz,
  completed_at timestamptz,
  delivered_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_repair_orders_status_check check (
    status = any (array[
      'received', 'diagnosing', 'awaiting_approval', 'awaiting_parts',
      'in_repair', 'ready', 'delivered', 'cancelled'
    ]::text[])
  ),
  constraint retail_repair_orders_quoted_nao_negativo
    check (quoted_cost_cents is null or quoted_cost_cents >= 0),
  constraint retail_repair_orders_final_nao_negativo
    check (final_cost_cents is null or final_cost_cents >= 0)
);

create index if not exists retail_repair_orders_org_status_idx
  on public.retail_repair_orders (organization_id, status);

create index if not exists retail_repair_orders_org_contact_idx
  on public.retail_repair_orders (organization_id, contact_id);

alter table public.retail_repair_orders enable row level security;

drop policy if exists retail_repair_orders_select on public.retail_repair_orders;
create policy retail_repair_orders_select on public.retail_repair_orders
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Piso `agent`: abrir/atualizar ordem de reparo é trabalho de balcão/oficina
-- (§5 — "agent+ ... retail_repair_orders").
drop policy if exists retail_repair_orders_write on public.retail_repair_orders;
create policy retail_repair_orders_write on public.retail_repair_orders
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

revoke all on public.retail_repair_orders from anon;
grant select, insert, update, delete on public.retail_repair_orders to authenticated;
grant all on public.retail_repair_orders to service_role;

drop trigger if exists trg_retail_repair_orders_updated_at on public.retail_repair_orders;
create trigger trg_retail_repair_orders_updated_at
  before update on public.retail_repair_orders
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_repair_orders is
  'Ordem de reparo. inventory_unit_id NULL é o caso comum (conserto de aparelho do CLIENTE, não estoque da loja); só setado para reforma de unidade PRÓPRIA. imei aqui é auxílio de busca, sem unique — o registro de identidade da unidade serializada da loja continua em retail_inventory_units.imei.';

-- ============================================================================
-- FK adiada da 0263 — retail_repair_orders agora existe.
-- ============================================================================

alter table public.retail_inventory_movements
  drop constraint if exists retail_inventory_movements_related_repair_order_id_fkey;
alter table public.retail_inventory_movements
  add constraint retail_inventory_movements_related_repair_order_id_fkey
  foreign key (related_repair_order_id) references public.retail_repair_orders(id);
