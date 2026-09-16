-- ============================================================================
-- 0267 — VAREJO MÓVEL: TRADE-IN E AVALIAÇÕES
--
-- `retail_trade_in_evaluations` guarda MÚLTIPLAS linhas por trade-in de
-- propósito (§2): uma estimativa inicial da IA numa conversa de WhatsApp, e
-- depois uma reavaliação presencial que pode divergir — nenhuma sobrescreve
-- a outra. É requisito de confiança/auditoria: se o número da IA e o número
-- do balcão discordam, os DOIS ficam visíveis, não só o último gravado.
-- ============================================================================

create table if not exists public.retail_trade_ins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  contact_id uuid references public.contacts(id),
  crm_lead_id uuid references public.crm_leads(id),
  status text not null default 'requested',
  -- O crédito da troca aplicado numa compra, quando isso acontece.
  resulting_sale_id uuid references public.retail_sales(id),
  -- Setado quando o aparelho trocado vira uma unidade nova em RECEIVING —
  -- é ESTA coluna, e retail_inventory_units.is_trade_in_origin, que
  -- carregam a decisão de "TRADED_IN é origem, não status" (ver 0263).
  resulting_inventory_unit_id uuid references public.retail_inventory_units(id),
  offer_amount_cents bigint,
  offer_expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_trade_ins_status_check check (
    status = any (array[
      'requested', 'evaluating', 'offered', 'accepted', 'declined', 'completed', 'expired'
    ]::text[])
  ),
  constraint retail_trade_ins_offer_nao_negativa
    check (offer_amount_cents is null or offer_amount_cents >= 0)
);

create index if not exists retail_trade_ins_org_status_idx
  on public.retail_trade_ins (organization_id, status);

create index if not exists retail_trade_ins_org_contact_idx
  on public.retail_trade_ins (organization_id, contact_id);

alter table public.retail_trade_ins enable row level security;

drop policy if exists retail_trade_ins_select on public.retail_trade_ins;
create policy retail_trade_ins_select on public.retail_trade_ins
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Piso `agent`: intake de trade-in é trabalho de balcão (§5 — "agent+
-- ... retail_trade_ins intake").
drop policy if exists retail_trade_ins_write on public.retail_trade_ins;
create policy retail_trade_ins_write on public.retail_trade_ins
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

revoke all on public.retail_trade_ins from anon;
grant select, insert, update, delete on public.retail_trade_ins to authenticated;
grant all on public.retail_trade_ins to service_role;

drop trigger if exists trg_retail_trade_ins_updated_at on public.retail_trade_ins;
create trigger trg_retail_trade_ins_updated_at
  before update on public.retail_trade_ins
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_trade_ins is
  'O pedido de troca de aparelho usado por crédito/desconto. resulting_inventory_unit_id + is_trade_in_origin (em retail_inventory_units) registram a origem trade-in sem um status TRADED_IN mutuamente exclusivo — ver o comentário daquela coluna (migration 0263).';

-- ============================================================================
-- retail_trade_in_evaluations — MÚLTIPLAS linhas por trade-in, de propósito
-- ============================================================================

create table if not exists public.retail_trade_in_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  trade_in_id uuid not null references public.retail_trade_ins(id) on delete cascade,

  device_description text,
  claimed_model text,
  claimed_condition text,
  claimed_battery_health_pct smallint,
  verified_model text,
  verified_condition text,
  verified_battery_health_pct smallint,
  evaluated_by_user_id uuid references auth.users(id),
  -- Fechado por CHECK: três métodos, cada um com implicação de confiança
  -- diferente (estimativa de IA vs. avaliação presencial vs. remota por foto).
  evaluation_method text,
  calculated_offer_cents bigint,
  evaluation_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_trade_in_evaluations_method_check check (
    evaluation_method is null
    or evaluation_method = any (array['ai_estimate', 'in_person', 'remote_photos']::text[])
  ),
  constraint retail_trade_in_evaluations_claimed_battery_faixa
    check (claimed_battery_health_pct is null or claimed_battery_health_pct between 0 and 100),
  constraint retail_trade_in_evaluations_verified_battery_faixa
    check (verified_battery_health_pct is null or verified_battery_health_pct between 0 and 100),
  constraint retail_trade_in_evaluations_offer_nao_negativa
    check (calculated_offer_cents is null or calculated_offer_cents >= 0)
);

create index if not exists retail_trade_in_evaluations_org_trade_in_idx
  on public.retail_trade_in_evaluations (organization_id, trade_in_id, created_at);

alter table public.retail_trade_in_evaluations enable row level security;

drop policy if exists retail_trade_in_evaluations_select on public.retail_trade_in_evaluations;
create policy retail_trade_in_evaluations_select on public.retail_trade_in_evaluations
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_trade_in_evaluations_write on public.retail_trade_in_evaluations;
create policy retail_trade_in_evaluations_write on public.retail_trade_in_evaluations
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

revoke all on public.retail_trade_in_evaluations from anon;
grant select, insert, update, delete on public.retail_trade_in_evaluations to authenticated;
grant all on public.retail_trade_in_evaluations to service_role;

drop trigger if exists trg_retail_trade_in_evaluations_updated_at on public.retail_trade_in_evaluations;
create trigger trg_retail_trade_in_evaluations_updated_at
  before update on public.retail_trade_in_evaluations
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_trade_in_evaluations is
  'UMA OU MAIS linhas por trade-in, de propósito (§2) — uma estimativa da IA e uma reavaliação presencial NÃO se sobrescrevem: é requisito de confiança que os dois números fiquem visíveis se divergirem, não só o último gravado.';
comment on column public.retail_trade_in_evaluations.evaluation_method is
  'ai_estimate | in_person | remote_photos — fechado por CHECK: cada valor tem implicação de confiança diferente e o conjunto é estável (ao contrário de condition/brand, que variam por negócio).';

-- ============================================================================
-- FK adiada da 0263 — retail_trade_ins agora existe.
-- ============================================================================

alter table public.retail_inventory_movements
  drop constraint if exists retail_inventory_movements_related_trade_in_id_fkey;
alter table public.retail_inventory_movements
  add constraint retail_inventory_movements_related_trade_in_id_fkey
  foreign key (related_trade_in_id) references public.retail_trade_ins(id);
