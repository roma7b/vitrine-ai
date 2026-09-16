-- ============================================================================
-- 0263 — VAREJO MÓVEL: UNIDADES DE ESTOQUE E TRILHA DE MOVIMENTOS
--
-- A tabela CENTRAL do domínio novo (`MOBILE_RETAIL_DOMAIN.md` §2): o aparelho
-- físico, serializado por IMEI, com um estado (`status`) que o sistema
-- inteiro (reserva, relatório, tool de IA) enxerga como máquina de estados —
-- e `retail_inventory_movements`, a trilha append-only que responde "por que
-- o estoque diz X" sem exceção: toda transição é uma linha aqui.
--
-- ─── Nunca um decremento — a resposta estrutural ao requisito de produto ──
-- Não existe coluna `quantity` na variante que sobe/desce. "Quantos há em
-- estoque" é SEMPRE `count(*) from retail_inventory_units where status =
-- 'IN_STOCK' and variant_id = X` — não há o que decrementar, só linhas cujo
-- `status` transiciona, cada transição logada. Isto não é estilo, é a
-- garantia que o domínio pede (§2: "there is nothing to decrement").
--
-- ─── Referências PRA FRENTE — a ordem de criação do lote ──────────────────
-- `retail_inventory_units` referencia `retail_suppliers`/`retail_purchase_items`
-- (migration seguinte) e `retail_sales`/`retail_sale_items` (duas migrations
-- à frente); `retail_inventory_movements` referencia essas MAIS
-- `retail_purchases`, `retail_trade_ins` e `retail_repair_orders`. Nenhuma
-- dessas tabelas existe ainda neste ponto do lote. Em vez de inverter a
-- ordem inteira do plano (que agrupa por assunto: fornecedor+compra juntos,
-- venda+item juntos, como o `IMPLEMENTATION_PLAN.md` pede), as colunas
-- nascem aqui como `uuid` PLANO — sem `references` — e cada migration
-- seguinte que cria a tabela referenciada AMARRA o FK que falta com
-- `alter table ... add constraint ... foreign key`. O resultado final,
-- depois das 8 migrations, é idêntico ao de declarar tudo de uma vez: as
-- mesmas colunas, as mesmas FKs, só que construídas em ordem que nunca
-- referencia relação inexistente — cada migration deste lote roda sozinha,
-- em sequência, num `psql` puro (doutrina de migrations, CLAUDE.md #3).
-- ============================================================================

create table if not exists public.retail_inventory_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  variant_id uuid not null references public.retail_product_variants(id),

  -- IMEI/IMEI2: NÃO `not null` — uma unidade em RECEBIMENTO pode não ter o
  -- IMEI capturado ainda (caixa fechada), e um aparelho dual-eSIM legítimo
  -- não tem segundo IMEI. O índice único PARCIAL abaixo tolera o vazio; o
  -- CHECK abaixo fecha a porta de deixar passar do recebimento sem IMEI.
  imei text,
  imei2 text,
  serial_number text,

  -- Vocabulário ABERTO (sem CHECK) — a régua de condição é decisão de
  -- negócio, não de arquitetura (§2), e muda por loja/nicho.
  condition text,
  battery_health_pct smallint,

  -- O que a loja pagou. NOT NULL aqui, ao contrário de
  -- catalog_products.custo_cents (que é opcional): numa unidade
  -- serializada, custo-base por unidade é o que viabiliza margem-por-aparelho
  -- e ponto de equilíbrio de trade-in — não é informação dispensável (§2).
  cost_cents bigint not null,
  -- Sobrescreve retail_product_variants.list_price_cents quando setado —
  -- preço de usado depende da condição do aparelho específico.
  sale_price_cents bigint,
  currency text not null default 'BRL',

  -- A MÁQUINA DE ESTADOS — vocabulário FECHADO por CHECK, ao contrário de
  -- `condition`/`brand` acima: reserva, relatório e tool de IA ramificam no
  -- conjunto exato (§3). Lista = §3 MENOS 'TRADED_IN', que aqui é o boolean
  -- abaixo — ver o comentário da coluna is_trade_in_origin para o raciocínio
  -- completo.
  status text not null,
  -- Decisão registrada em MOBILE_RETAIL_DOMAIN.md §3: a doc levanta a tensão
  -- ("modelar TRADED_IN como status ou como flag de origem?") e pede decisão
  -- do dono do produto na Fase 1. Decisão: FLAG, não status. Um status
  -- 'TRADED_IN' seria mutuamente exclusivo com o resto da máquina de
  -- estados — bloquearia a unidade de fluir RECEIVING → INSPECTION →
  -- IN_STOCK → ... como qualquer outra, que é exatamente o comportamento
  -- que a doc descreve como correto. A flag registra a ORIGEM sem competir
  -- com a ESTAÇÃO atual da linha de produção.
  is_trade_in_origin boolean not null default false,

  -- FKs para frente — ver o cabeçalho desta migration. Amarradas nas
  -- migrations 0264 (suppliers/purchase_items) e 0265 (sales/sale_items).
  supplier_id uuid,
  purchase_item_id uuid,
  reserved_for_sale_id uuid,
  reserved_until timestamptz,
  sold_in_sale_item_id uuid,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_inventory_units_status_check check (
    status = any (array[
      'RECEIVING', 'INSPECTION', 'IN_STOCK', 'RESERVED', 'SOLD', 'DELIVERED',
      'RETURN_PENDING', 'RETURNED', 'REPAIR', 'DAMAGED', 'WARRANTY'
    ]::text[])
  ),
  -- Nada alcança INSPECTION (ou além) sem IMEI capturado — só RECEIVING
  -- tolera o vazio (§2).
  constraint retail_inventory_units_imei_obrigatorio_apos_recebimento
    check (status = 'RECEIVING' or imei is not null),
  constraint retail_inventory_units_cost_nao_negativo check (cost_cents >= 0),
  constraint retail_inventory_units_sale_price_nao_negativo
    check (sale_price_cents is null or sale_price_cents >= 0),
  constraint retail_inventory_units_battery_pct_faixa
    check (battery_health_pct is null or battery_health_pct between 0 and 100),
  constraint retail_inventory_units_moeda_iso check (currency ~ '^[A-Z]{3}$')
);

-- Índice único PARCIAL — não `unique not null` de coluna, porque a unidade
-- em RECEIVING pode não ter IMEI ainda (§2). `where imei is not null` tolera
-- N linhas com o mesmo NULL (comportamento padrão de índice único do
-- Postgres para NULL) sem abrir mão de bloquear duas linhas com o MESMO
-- IMEI não nulo na mesma organização.
create unique index if not exists retail_inventory_units_org_imei_key
  on public.retail_inventory_units (organization_id, imei)
  where imei is not null;

create unique index if not exists retail_inventory_units_org_imei2_key
  on public.retail_inventory_units (organization_id, imei2)
  where imei2 is not null;

-- "O que está em estoque agora" — o scan que todo `count(*) where status =
-- 'IN_STOCK'` (a régua sem decremento, ver cabeçalho) precisa.
create index if not exists retail_inventory_units_org_status_idx
  on public.retail_inventory_units (organization_id, status);

-- "Quantos deste SKU estão vendáveis agora" — a pergunta do §2 por trás de
-- `retail_search_inventory` (tool de IA, Fase 3 — fora de escopo aqui, mas
-- o índice que a sustenta é decisão de schema e cabe nesta fase).
create index if not exists retail_inventory_units_org_variant_status_idx
  on public.retail_inventory_units (organization_id, variant_id, status);

alter table public.retail_inventory_units enable row level security;

drop policy if exists retail_inventory_units_select on public.retail_inventory_units;
create policy retail_inventory_units_select on public.retail_inventory_units
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Piso `agent`: transição operacional (RECEIVING→INSPECTION, marcar
-- DELIVERED) é trabalho de balcão do dia a dia, não decisão financeira —
-- MOBILE_RETAIL_DOMAIN.md §5 lista esta tabela no grupo "agent+ (front-desk
-- staff pode operar o dia a dia)".
drop policy if exists retail_inventory_units_write on public.retail_inventory_units;
create policy retail_inventory_units_write on public.retail_inventory_units
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

revoke all on public.retail_inventory_units from anon;
grant select, insert, update, delete on public.retail_inventory_units to authenticated;
grant all on public.retail_inventory_units to service_role;

drop trigger if exists trg_retail_inventory_units_updated_at on public.retail_inventory_units;
create trigger trg_retail_inventory_units_updated_at
  before update on public.retail_inventory_units
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_inventory_units is
  'A tabela CENTRAL do domínio de varejo móvel: o aparelho físico serializado por IMEI, com status como máquina de estados (ver CHECK). "Quanto há em estoque" é sempre count(*) where status=''IN_STOCK'' — nunca um decremento. Ver MOBILE_RETAIL_DOMAIN.md §2/§3.';
comment on column public.retail_inventory_units.imei is
  'Nullable: unidade em RECEIVING pode não ter IMEI capturado ainda. unique (organization_id, imei) where imei is not null (índice parcial) + CHECK que fecha INSPECTION/além sem IMEI.';
comment on column public.retail_inventory_units.status is
  'Máquina de estados fechada por CHECK (MOBILE_RETAIL_DOMAIN.md §3): RECEIVING → INSPECTION → IN_STOCK → RESERVED → SOLD → DELIVERED, com ramos para RETURN_PENDING/RETURNED, REPAIR, DAMAGED, WARRANTY. NÃO inclui TRADED_IN — ver is_trade_in_origin.';
comment on column public.retail_inventory_units.is_trade_in_origin is
  'Decisão da Fase 1 (tensão levantada em MOBILE_RETAIL_DOMAIN.md §3): TRADED_IN é ORIGEM, não ESTAÇÃO — uma unidade trade-in ainda flui RECEIVING → INSPECTION → IN_STOCK → ... como qualquer outra. Um status ''TRADED_IN'' mutuamente exclusivo bloquearia esse fluxo; a flag registra a origem sem competir com o status operacional.';
comment on column public.retail_inventory_units.cost_cents is
  'NOT NULL, ao contrário de catalog_products.custo_cents (opcional): custo-base POR UNIDADE é o que viabiliza margem-por-aparelho e ponto de equilíbrio de trade-in (§2) — não é informação dispensável aqui.';
comment on column public.retail_inventory_units.supplier_id is
  'FK para retail_suppliers, amarrada em ALTER na migration 0264 (a tabela referenciada nasce lá) — ver o cabeçalho desta migration.';
comment on column public.retail_inventory_units.purchase_item_id is
  'FK para retail_purchase_items, amarrada em ALTER na migration 0264.';
comment on column public.retail_inventory_units.reserved_for_sale_id is
  'FK para retail_sales, amarrada em ALTER na migration 0265. NULL fora de status RESERVED por convenção de aplicação (não há CHECK cruzando as duas — fica para a Fase 2, que introduz fn_retail_reserve_unit/fn_retail_complete_sale, MOBILE_RETAIL_DOMAIN.md §6).';
comment on column public.retail_inventory_units.sold_in_sale_item_id is
  'FK para retail_sale_items, amarrada em ALTER na migration 0265.';

-- ============================================================================
-- retail_inventory_movements — a trilha de auditoria, append-only por convenção
-- ============================================================================

create table if not exists public.retail_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  unit_id uuid not null references public.retail_inventory_units(id),

  -- `from_status` nullable = linha de NASCIMENTO da unidade (§2: "nullable
  -- from_status for the unit's birth row"). `to_status` sempre presente —
  -- toda linha desta tabela representa UMA transição concluída.
  from_status text,
  to_status text not null,

  -- Vocabulário ABERTO (sem CHECK), ao contrário de actor_type/status acima:
  -- a lista de razões de negócio (received/inspected/sold/...) tende a
  -- crescer com o produto, e um CHECK fixo quebraria o update.sh de um
  -- clone com razão própria — mesma doutrina de vocabulário aberto que
  -- manteve crm_lead_activities.type sem CHECK (CLAUDE.md § Modelagem).
  reason text not null,

  actor_user_id uuid references auth.users(id),
  -- Fechado por CHECK: só três valores possíveis, e um clone não inventa um
  -- quarto tipo de ator sem tocar código (o mesmo padrão de crm_leads.owner_kind
  -- / crm_lead_activities.actor_kind, os pares que
  -- tests/invariants/vocabulario-banco-x-typescript.test.ts já vigia).
  actor_type text,

  -- FKs para frente — amarradas nas migrations 0264 (purchases), 0265
  -- (sales), 0267 (trade_ins) e 0268 (repair_orders). Nullable: cada linha
  -- usa só a que corresponde à `reason`.
  related_sale_id uuid,
  related_purchase_id uuid,
  related_repair_order_id uuid,
  related_trade_in_id uuid,

  -- Snapshot IMUTÁVEL do que aconteceu — preço no momento da venda para
  -- relatório de margem mesmo que sale_price_cents mude depois, checklist de
  -- inspeção, array de fotos de dano no Storage, etc. (§2).
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retail_inventory_movements_actor_type_check check (
    actor_type is null or actor_type = any (array['human', 'ai_agent', 'system']::text[])
  )
);

-- "Por que o estoque diz X" — histórico de uma unidade, mais recente primeiro.
create index if not exists retail_inventory_movements_org_unit_idx
  on public.retail_inventory_movements (organization_id, unit_id, created_at desc);

alter table public.retail_inventory_movements enable row level security;

drop policy if exists retail_inventory_movements_select on public.retail_inventory_movements;
create policy retail_inventory_movements_select on public.retail_inventory_movements
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Mesmo piso `agent` de retail_inventory_units: quem grava a transição
-- operacional grava o próprio log dela (§5 — "todo write, seja qual for o
-- piso de papel, também emite retail_inventory_movements").
drop policy if exists retail_inventory_movements_write on public.retail_inventory_movements;
create policy retail_inventory_movements_write on public.retail_inventory_movements
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

revoke all on public.retail_inventory_movements from anon;
grant select, insert, update, delete on public.retail_inventory_movements to authenticated;
grant all on public.retail_inventory_movements to service_role;

drop trigger if exists trg_retail_inventory_movements_updated_at on public.retail_inventory_movements;
create trigger trg_retail_inventory_movements_updated_at
  before update on public.retail_inventory_movements
  for each row execute function public.fn_set_updated_at();

comment on table public.retail_inventory_movements is
  'Trilha de auditoria da máquina de estados de retail_inventory_units — append-only POR CONVENÇÃO (a Fase 1, IMPLEMENTATION_PLAN.md, exige que só lib/retail/movimentos.ts escreva aqui; este schema não revoga UPDATE porque o piso do pacote é RLS+grant padrão em todas as 15 tabelas, igual às demais). "Por que o estoque diz X" sempre tem resposta aqui — nenhuma exceção.';
comment on column public.retail_inventory_movements.from_status is
  'NULL na linha de NASCIMENTO da unidade (recebimento inicial) — toda transição depois disso tem from_status preenchido.';
comment on column public.retail_inventory_movements.reason is
  'Vocabulário ABERTO (sem CHECK) — ex.: received, inspected, sold, delivered, returned, sent_to_repair, returned_from_repair, traded_in, damaged, warranty_claim, adjustment. Lista tende a crescer; CHECK fixo quebraria update.sh de clone com razão própria.';
comment on column public.retail_inventory_movements.metadata is
  'Snapshot IMUTÁVEL do momento da transição — preço para relatório de margem, checklist de inspeção, fotos de dano. Nunca reescrito: a linha inteira é append-only por convenção.';
