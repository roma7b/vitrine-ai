-- ============================================================================
-- 0269 — VAREJO MÓVEL: GARANTIAS (última das 15 tabelas da Fase 1a)
--
-- Mesmo either/or de `retail_sale_items` (0265): uma garantia cobre OU uma
-- unidade em estoque (`inventory_unit_id`) OU uma ordem de reparo
-- (`repair_order_id`) — nunca as duas, nunca nenhuma (§2). Com esta
-- migration, as 15 tabelas de `MOBILE_RETAIL_DOMAIN.md` §2 existem.
-- ============================================================================

create table if not exists public.retail_warranties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  inventory_unit_id uuid references public.retail_inventory_units(id),
  repair_order_id uuid references public.retail_repair_orders(id),
  -- A venda que originou a garantia, quando aplicável.
  sale_item_id uuid references public.retail_sale_items(id),
  contact_id uuid references public.contacts(id),

  -- Fechado por CHECK — três tipos com implicação de responsabilidade
  -- diferente (fabricante vs. loja vs. estendida comprada à parte).
  warranty_type text not null,
  starts_at date not null,
  expires_at date not null,
  terms text,
  status text not null default 'active',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- O either/or: garante um aparelho de estoque OU uma ordem de reparo,
  -- nunca os dois, nunca nenhum — mesma disciplina de retail_sale_items.
  constraint retail_warranties_exatamente_um_alvo
    check (num_nonnulls(inventory_unit_id, repair_order_id) = 1),
  constraint retail_warranties_type_check
    check (warranty_type = any (array['manufacturer', 'store', 'extended']::text[])),
  constraint retail_warranties_status_check
    check (status = any (array['active', 'expired', 'voided', 'claimed']::text[])),
  constraint retail_warranties_vigencia_valida check (expires_at >= starts_at)
);

create index if not exists retail_warranties_org_status_idx
  on public.retail_warranties (organization_id, status);

create index if not exists retail_warranties_org_contact_idx
  on public.retail_warranties (organization_id, contact_id);

alter table public.retail_warranties enable row level security;

drop policy if exists retail_warranties_select on public.retail_warranties;
create policy retail_warranties_select on public.retail_warranties
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Piso `manager`: emitir/anular garantia é compromisso financeiro da loja
-- (§5 — grupo manager+).
drop policy if exists retail_warranties_write on public.retail_warranties;
create policy retail_warranties_write on public.retail_warranties
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

revoke all on public.retail_warranties from anon;
grant select, insert, update, delete on public.retail_warranties to authenticated;
grant all on public.retail_warranties to service_role;

drop trigger if exists trg_retail_warranties_updated_at on public.retail_warranties;
create trigger trg_retail_warranties_updated_at
  before update on public.retail_warranties
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_warranties is
  'Garantia sobre um aparelho de estoque OU sobre uma ordem de reparo — nunca as duas, nunca nenhuma (constraint retail_warranties_exatamente_um_alvo, num_nonnulls = 1, mesma disciplina de retail_sale_items). Última das 15 tabelas de MOBILE_RETAIL_DOMAIN.md §2 (Fase 1a).';
