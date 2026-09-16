-- ============================================================================
-- 0266 — VAREJO MÓVEL: PAGAMENTOS E PARCELAS (crediário da própria loja)
--
-- `retail_installments` modela "crediário" FINANCIADO PELA LOJA — distinto
-- de parcelamento de cartão, que é só um `retail_payments` com
-- `method='credit'` e os dados da operadora em nenhuma coluna extra daqui
-- (a doc, §2, é explícita: "don't conflate the two; this table is for when
-- the *store* is the creditor").
-- ============================================================================

create table if not exists public.retail_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  sale_id uuid not null references public.retail_sales(id) on delete cascade,
  -- Vocabulário ABERTO (sem CHECK) — trilho de pagamento no Brasil muda
  -- (pix/cash/debit/credit/bank_transfer sugeridos pela doc), e um clone
  -- pode ganhar um método novo sem migration.
  method text,
  amount_cents bigint not null,
  currency text not null default 'BRL',
  -- Fechado por CHECK — o ciclo de vida de UM pagamento é pequeno e estável.
  status text not null default 'pending',
  -- txid do PIX / referência do gateway.
  external_reference text,
  paid_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_payments_status_check
    check (status = any (array['pending', 'confirmed', 'failed', 'refunded']::text[])),
  constraint retail_payments_amount_nao_negativo check (amount_cents >= 0),
  constraint retail_payments_moeda_iso check (currency ~ '^[A-Z]{3}$')
);

create index if not exists retail_payments_org_sale_idx
  on public.retail_payments (organization_id, sale_id);

alter table public.retail_payments enable row level security;

drop policy if exists retail_payments_select on public.retail_payments;
create policy retail_payments_select on public.retail_payments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_payments_write on public.retail_payments;
create policy retail_payments_write on public.retail_payments
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

revoke all on public.retail_payments from anon;
grant select, insert, update, delete on public.retail_payments to authenticated;
grant all on public.retail_payments to service_role;

drop trigger if exists trg_retail_payments_updated_at on public.retail_payments;
create trigger trg_retail_payments_updated_at
  before update on public.retail_payments
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_payments is
  'Um pagamento contra uma venda. method é vocabulário aberto (trilhos de pagamento BR evoluem); status é fechado (ciclo de vida curto e estável).';

-- ============================================================================
-- retail_installments — crediário financiado pela LOJA, distinto de
-- parcelamento de cartão (que é só um retail_payments com method='credit').
-- ============================================================================

create table if not exists public.retail_installments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  payment_id uuid not null references public.retail_payments(id) on delete cascade,
  installment_number smallint not null,
  due_date date not null,
  amount_cents bigint not null,
  status text not null default 'pending',
  paid_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_installments_status_check
    check (status = any (array['pending', 'paid', 'overdue']::text[])),
  constraint retail_installments_numero_positivo check (installment_number > 0),
  constraint retail_installments_amount_nao_negativo check (amount_cents >= 0)
);

-- Duas parcelas não competem pelo mesmo número dentro do mesmo pagamento.
create unique index if not exists retail_installments_org_payment_numero_key
  on public.retail_installments (organization_id, payment_id, installment_number);

create index if not exists retail_installments_org_status_due_idx
  on public.retail_installments (organization_id, status, due_date);

alter table public.retail_installments enable row level security;

drop policy if exists retail_installments_select on public.retail_installments;
create policy retail_installments_select on public.retail_installments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists retail_installments_write on public.retail_installments;
create policy retail_installments_write on public.retail_installments
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

revoke all on public.retail_installments from anon;
grant select, insert, update, delete on public.retail_installments to authenticated;
grant all on public.retail_installments to service_role;

drop trigger if exists trg_retail_installments_updated_at on public.retail_installments;
create trigger trg_retail_installments_updated_at
  before update on public.retail_installments
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_installments is
  'Crediário FINANCIADO PELA LOJA — distinto de parcelamento de operadora de cartão, que é um único retail_payments com method=''credit'' e metadata da operadora fora desta tabela (MOBILE_RETAIL_DOMAIN.md §2). unique (organization_id, payment_id, installment_number) evita duas parcelas com o mesmo número.';
