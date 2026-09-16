# Mobile Retail Domain — design for the AI OS iPhone vertical

> Companion to `ARCHITECTURE_AUDIT.md` (read that first for the base-system conventions this
> document builds on) and `IMPLEMENTATION_PLAN.md` (the phased execution of what's proposed
> here). This document does not modify any existing CRM/WhatsApp/AI code — it proposes new
> tables, new API routes, new MCP tools, and where each hooks into what already exists.

---

## 0. Naming collision check (do this before writing any migration)

Two product tables already exist and must **not** be confused with, renamed, or merged into
the new domain without a deliberate decision:

| Existing table | What it actually is | Why it doesn't cover this domain |
|---|---|---|
| `nuvemshop_products` | Read-only **mirror** of a remote Nuvemshop store | Not editable locally; external source of truth |
| `catalog_products` (migration `0204`) | The store's own flat, non-serialized catalog — SKU, name, price/cost in cents, a bare integer `quantidade`, `controla_estoque` | No variants, no per-unit identity, no IMEI/serial, no condition/battery-health, no movement audit trail, no lifecycle beyond "in stock or not" |

**Decision:** the new domain gets its own tables under a distinct prefix — this document uses
`retail_` throughout (e.g. `retail_products`, `retail_inventory_units`). `catalog_products` and
`nuvemshop_products` are left completely untouched; existing AI tools (`crm_search_products`,
`crm_list_contact_orders`) keep working exactly as they do today. New AI tools are added
alongside them, not in place of them (see §4). A store that sells serialized phones does not
need to also maintain rows in `catalog_products` — the new domain is self-sufficient for its
own product line, and `catalog_products` remains available for non-serialized accessories
(cases, chargers, screen protectors) a phone store also sells, at the operator's option.

Also reused, unmodified: `orders` (Nuvemshop order history — distinct from the new `retail_sales`,
do not conflate "an order synced from an e-commerce channel" with "a POS sale rung up in the
shop").

---

## 1. What's reused vs. net-new

### Reused as-is (no schema change)

- `organizations`, `user_organizations`, `platform_admins` — tenancy and RBAC.
- `contacts` — the customer on a sale, a trade-in, a repair order **is** a CRM contact. Do not
  create a parallel "Customer" table; FK to `contacts.id`.
- `crm_leads` / `crm_lead_links` / `crm_lead_activities` — a sale, trade-in, or repair can (and
  should) show up on a lead's timeline via `crm_lead_links` (polymorphic `target_kind` = e.g.
  `retail_sale`, per the existing polymorphic-link standardization rule — **pick one field name
  and stick to it everywhere**, per anti-pattern #8 in `CLAUDE.md`).
- `api_audit_log` / `lib/audit/index.ts` — every mutation in this domain audits the same way
  everything else does. New `AuditAction` string constants get added to `lib/audit/actions.ts`
  (e.g. `retail_sale.created`, `inventory_unit.status_changed`).
- `event_log` — inventory movements, sale completion, reservation expiry all flow through it
  exactly like every other async side effect in the system (see §5).
- `lib/api/wrappers.ts`, `lib/auth/require-role.ts`, `lib/schemas/_validate.ts` pattern,
  `lib/i18n/dicionario.ts` for translated error strings — every new route is built the same way
  `app/api/v1/products/route.ts` is.
- `lib/mcp/types.ts` / `lib/mcp/server.ts` / `lib/mcp/tools/index.ts` — new tools plug into the
  existing registry, no new MCP transport or auth mechanism.
- `lib/followup/` — a trade-in evaluation gone quiet, or a repair awaiting a customer decision,
  are follow-up candidates. Reuse the follow-up engine rather than building a parallel nudge
  system (flagged again in `IMPLEMENTATION_PLAN.md` Phase 5).
- `lib/navigation/catalogo.ts` — new screens (inventory, POS, trade-in queue, repairs board)
  get entries here, likely under a **new** `NavGroupId` (proposal: `"loja"` or `"varejo"`,
  since none of the existing six groups — `atendimento, crm, ia, canais, analise, organizacao`
  — is a good fit for "run the shop floor").
- `lib/money.ts` (`parseReaisToCents`) / the `_cents` + ISO-4217 `currency` convention — every
  price field in the new domain follows it exactly.
- `lib/ai/rag/format-product.ts` pattern — if serialized units should be RAG-searchable
  (product spec text, not price/stock), extend/mirror this formatter; keep transactional facts
  (price, stock, IMEI) as tool calls only (see `ARCHITECTURE_AUDIT.md` §10).

### Net-new tables (all `organization_id`-scoped, all RLS)

`retail_products`, `retail_product_variants`, `retail_inventory_units`,
`retail_inventory_movements`, `retail_suppliers`, `retail_purchases`,
`retail_purchase_items`, `retail_sales`, `retail_sale_items`, `retail_payments`,
`retail_installments`, `retail_trade_ins`, `retail_trade_in_evaluations`,
`retail_repair_orders`, `retail_warranties`.

---

## 2. Schema (shape, not final DDL — final DDL is a Phase 1 deliverable)

All tables: `id uuid primary key default gen_random_uuid()`,
`organization_id uuid not null references organizations(id) on delete cascade`,
`created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`
+ `trg_<table>_updated_at` trigger, RLS enabled, `revoke all from anon` +
`grant ... to authenticated` + `grant all to service_role`, following the `catalog_products`
block byte-for-byte in structure.

### `retail_products` — the sellable model (e.g. "iPhone 15 Pro")

- `name text not null`, `brand text` (default `'Apple'` but not locked — a shop also sells
  trade-in Androids), `model_line text` (e.g. `iPhone 15`), `category text`
  (`smartphone`/`accessory`/`part`), `description text`, `image_url text`, `active boolean`.
- **No price here** — price lives on the variant (storage/color combos price differently) and
  ultimately on the unit (a used unit's price depends on condition).
- DIRC check: brand/category are open vocabulary (text, no CHECK) — a clone in a different
  market sells different brands; lock the vocabulary in TypeScript
  (`lib/schemas/retail-products.ts`), same pattern as `catalog_products.origem`.

### `retail_product_variants` — SKU-level (e.g. "iPhone 15 Pro 256GB Titânio Natural")

- `product_id uuid not null references retail_products(id) on delete cascade`
- `sku text not null` (unique per org — same identity role `catalog_products.codigo` plays),
  `storage_gb integer`, `color text`, `attributes jsonb` (open bag for anything not worth a
  column yet — condition-independent attributes only, per DIRC: don't jsonb what should be a
  column once it's a hot filter path, e.g. `storage_gb` earned a real column because it's
  filtered/sorted on constantly).
- `list_price_cents bigint`, `currency text` — this is the **default/new-unit** price;
  individual units can override (see below) because a used unit's price is condition-dependent.
- `unique (organization_id, sku)`.

### `retail_inventory_units` — the serialized, physical device. **This is the core new table.**

- `variant_id uuid not null references retail_product_variants(id)`
- `imei text`, `imei2 text` — **not `unique not null`** at the column level in the way you'd
  first reach for: a unit in `RECEIVING` may not have its IMEI captured yet (box not opened),
  and a very small number of legitimately dual-eSIM-only devices have no second IMEI. Model as:
  `imei text` nullable, with a **partial unique index**
  `unique (organization_id, imei) where imei is not null` (same idiom as
  `catalog_products_org_codigo_key`, but partial to tolerate the pre-inspection gap) — and a
  CHECK that `status = 'RECEIVING' or imei is not null` so nothing reaches `INSPECTION` without
  one. `imei2` gets the same partial-unique treatment, nullable always.
- `serial_number text` (Apple serial, distinct from IMEI, useful for AppleCare/warranty lookup)
- `condition text` — open vocabulary in TypeScript (`NOVO`/`SEMINOVO_A`/`SEMINOVO_B`/`SEMINOVO_C`/
  `USADO`/`PARA_PECAS` or whatever the grading rubric ends up being — this is a business
  decision, not an architecture one, so don't CHECK-lock it yet).
- `battery_health_pct smallint` (nullable — only meaningful for used units),
  `cost_cents bigint not null` (what the shop paid — mirrors `catalog_products.custo_cents`,
  but **not nullable** here: for a serialized unit, unlike a bulk SKU, cost-basis per unit is
  the whole point of the model — it's what makes margin-per-device and trade-in break-even math
  possible), `sale_price_cents bigint` (nullable until priced — overrides
  `variant.list_price_cents` when set), `currency text not null default 'BRL'`.
- `status text not null` — **the lifecycle** (see §3), CHECK-locked (closed vocabulary — this
  is a state machine the whole system reasons about, the opposite case from `condition`/`brand`
  above; a clone should not be able to invent a new status without a migration, because
  reservation/audit logic branches on the exact set).
- `supplier_id uuid references retail_suppliers(id)`, `purchase_item_id uuid references
  retail_purchase_items(id)` — where this unit came from.
- `reserved_for_sale_id uuid references retail_sales(id)`, `reserved_until timestamptz` — see
  §6 concurrency design. `sold_in_sale_item_id uuid references retail_sale_items(id)`.
- `notes text`.
- Indexes: partial-unique on `imei`/`imei2` as above; `(organization_id, status)` for the
  "what's in stock" scan; `(organization_id, variant_id, status)` for "how many of this SKU are
  sellable right now."
- **Never a bare decrement.** There is no `quantity` column on the variant that gets
  incremented/decremented — "how many in stock" is **always** `count(*) from
  retail_inventory_units where status = 'IN_STOCK' and variant_id = X`. This is the direct
  structural answer to the product requirement "never a bare stock decrement": there is
  nothing to decrement, only unit rows whose status transitions, each transition logged in
  `retail_inventory_movements`.

### `retail_inventory_movements` — the audit trail

- `unit_id uuid not null references retail_inventory_units(id)`
- `from_status text`, `to_status text` (nullable `from_status` for the unit's birth row)
- `reason text` (open vocab: `received`, `inspected`, `sold`, `delivered`, `returned`,
  `sent_to_repair`, `returned_from_repair`, `traded_in`, `damaged`, `warranty_claim`, `adjustment`)
- `actor_user_id uuid references auth.users(id)`, `actor_type text` (`human`/`ai_agent`/`system`)
- `related_sale_id uuid references retail_sales(id)`,
  `related_purchase_id uuid references retail_purchases(id)`,
  `related_repair_order_id uuid references retail_repair_orders(id)`,
  `related_trade_in_id uuid references retail_trade_ins(id)` — nullable FKs, whichever
  applies to this row's `reason`.
- `metadata jsonb` (free-form: e.g. inspection checklist result, damage photos array of
  Storage paths, price at time of sale for margin reporting even if the unit's `sale_price_cents`
  changes later — **immutable snapshot of what happened**, this table is append-only by
  convention, never updated).
- This table is the one place a "why does stock say X" question always has an answer — every
  status transition, no exceptions, is a row here, written **in the same transaction** as the
  `retail_inventory_units.status` update (see §6 for how that's enforced without triggers doing
  HTTP or anything cross-cutting — it's a plain same-transaction insert, no event_log needed for
  the write itself; `event_log` is for what happens *after* the transaction, e.g. notifying the
  AI agent's memory or triggering a low-stock alert).

### `retail_suppliers`

- `name text not null`, `document text` (CNPJ/CPF), `contact_phone text`, `contact_email text`,
  `notes text`, `active boolean`.

### `retail_purchases` / `retail_purchase_items`

- `retail_purchases`: `supplier_id`, `purchase_date date`, `invoice_number text`,
  `total_cost_cents bigint`, `currency text`, `status text` (`draft`/`received`/`cancelled`).
- `retail_purchase_items`: `purchase_id`, `variant_id`, `quantity integer`,
  `unit_cost_cents bigint` — **this table doesn't create inventory units by itself**; receiving
  a purchase is the operation that spawns N `retail_inventory_units` rows in status
  `RECEIVING`, one per physical device, each carrying `purchase_item_id` and `cost_cents` back
  to this row. (A purchase line item is "we bought 10 of this SKU"; each of the 10 becomes its
  own serialized unit the moment it's checked in — that's the seam between "bulk purchasing"
  and "serialized inventory.")

### `retail_sales` / `retail_sale_items`

- `retail_sales`: `contact_id references contacts(id)`, `crm_lead_id references crm_leads(id)`
  (nullable — a walk-in POS sale may have no lead), `sold_by_user_id references auth.users(id)`,
  `channel text` (`pos`/`whatsapp`/`online` — open vocab), `status text`
  (`draft`/`awaiting_payment`/`paid`/`completed`/`cancelled`/`refunded`), `subtotal_cents`,
  `discount_cents`, `total_cents`, `currency text`, `notes text`.
- `retail_sale_items`: `sale_id`, `inventory_unit_id references retail_inventory_units(id)`
  (**nullable only for non-serialized line items** — e.g. a `catalog_products` accessory sold
  in the same basket; when non-null it's a phone with a specific IMEI), `catalog_product_id
  references catalog_products(id)` (nullable — the accessory case), `description text`
  (denormalized snapshot of what was sold, because `retail_products`/`catalog_products` rows
  can change name later and the receipt must not), `unit_price_cents`, `quantity integer`
  (always 1 when `inventory_unit_id` is set — a serialized unit cannot be "quantity 3"),
  `line_total_cents`.
- CHECK: exactly one of `inventory_unit_id`/`catalog_product_id` is non-null per row — a sale
  item is either a specific device or a bulk accessory, never neither/both.

### `retail_payments` / `retail_installments`

- `retail_payments`: `sale_id`, `method text` (`pix`/`cash`/`debit`/`credit`/`bank_transfer` —
  open vocab, payment rails in Brazil evolve), `amount_cents`, `currency`, `status text`
  (`pending`/`confirmed`/`failed`/`refunded`), `external_reference text` (gateway/PIX txid),
  `paid_at timestamptz`.
- `retail_installments`: `payment_id references retail_payments(id)`, `installment_number
  smallint`, `due_date date`, `amount_cents`, `status text` (`pending`/`paid`/`overdue`),
  `paid_at timestamptz` — models "crediário"/store-financed installments distinct from a card
  network's own installment plan (which is just one `retail_payments` row with `method=credit`
  and metadata about the card processor's parcelas — don't conflate the two; this table is for
  when the *store* is the creditor).

### `retail_trade_ins` / `retail_trade_in_evaluations`

- `retail_trade_ins`: `contact_id`, `crm_lead_id`, `status text`
  (`requested`/`evaluating`/`offered`/`accepted`/`declined`/`completed`/`expired`),
  `resulting_sale_id references retail_sales(id)` (nullable — the trade-in credit applied to a
  purchase, once one happens), `resulting_inventory_unit_id references retail_inventory_units(id)`
  (nullable — set once the traded-in device itself becomes a new unit in `RECEIVING`/`TRADED_IN`
  lineage — see §3 status list), `offer_amount_cents`, `offer_expires_at timestamptz`.
- `retail_trade_in_evaluations`: `trade_in_id`, `device_description text` (what the customer
  says they have, before verification), `claimed_model text`, `claimed_condition text`,
  `claimed_battery_health_pct smallint`, `verified_model text`, `verified_condition text`,
  `verified_battery_health_pct smallint`, `evaluated_by_user_id`, `evaluation_method text`
  (`ai_estimate`/`in_person`/`remote_photos`), `calculated_offer_cents bigint`,
  `evaluation_notes text`. **One trade-in can have multiple evaluation rows** (an initial
  AI-driven estimate from a WhatsApp conversation, then an in-person re-evaluation that may
  differ) — this is intentionally not collapsed into a single mutable row, so the AI's original
  estimate is preserved even if the in-store evaluation revises it (audit/trust requirement:
  if the AI's estimate and the counter shop's number disagree, both must be visible, not just
  whichever was written last).

### `retail_repair_orders`

- `contact_id`, `crm_lead_id`, `inventory_unit_id` (nullable — repairing a customer's own
  device, not shop inventory, is the common case; only set when the shop is repairing a unit it
  owns, e.g. pre-sale refurbishment), `device_description text` (for customer-owned devices
  with no `inventory_unit_id`), `imei text` (nullable, for customer-owned devices — **not**
  unique-constrained the way `retail_inventory_units.imei` is, since it's just a lookup aid
  here, the row of record for a shop-owned serialized device's IMEI stays
  `retail_inventory_units`), `issue_description text`, `diagnosis text`, `status text`
  (`received`/`diagnosing`/`awaiting_approval`/`awaiting_parts`/`in_repair`/`ready`/
  `delivered`/`cancelled`), `quoted_cost_cents`, `final_cost_cents`, `technician_user_id`,
  `received_at`, `promised_at`, `completed_at`, `delivered_at`.

### `retail_warranties`

- `inventory_unit_id` (nullable — could warrant a repair instead) OR `repair_order_id`
  (nullable — the other side of the same either/or as `retail_sale_items`), `sale_item_id
  references retail_sale_items(id)` (the sale that triggered this warranty), `contact_id`,
  `warranty_type text` (`manufacturer`/`store`/`extended`), `starts_at date`, `expires_at
  date`, `terms text`, `status text` (`active`/`expired`/`voided`/`claimed`).
- CHECK: exactly one of `inventory_unit_id`/`repair_order_id` non-null, same either/or
  discipline as sale items.

---

## 3. Inventory unit status lifecycle

```
RECEIVING → INSPECTION → IN_STOCK → RESERVED → SOLD → DELIVERED
                                        ↓
                              (reservation expires/cancels)
                                        ↓
                                    IN_STOCK

Side branches from IN_STOCK (or later, per business rule):
  RETURN_PENDING → RETURNED → IN_STOCK  (or → DAMAGED if the return itself finds a defect)
  IN_STOCK/SOLD/DELIVERED → REPAIR → IN_STOCK  (post-repair, re-inspected)
  any → DAMAGED  (write-off path; typically terminal, or → REPAIR if it's economical to fix)
  any → WARRANTY  (device is currently out with a warranty claim in flight — distinct from the
                   customer's device coming in for repair; this is the shop's own unit under an
                   RMA to a supplier/manufacturer)
  → TRADED_IN  (this unit's origin: it entered inventory as the trade-in side of a
                retail_trade_ins row, at the moment RECEIVING starts — distinguishes
                trade-in-sourced stock from supplier-purchased stock for margin reporting)
```

- Every arrow is a row in `retail_inventory_movements`, `from_status` → `to_status`, with
  `reason`.
- Status is CHECK-locked (closed vocabulary) — this list is a state machine every reservation,
  reporting, and AI-tool query branches on, unlike `condition`/`brand` above.
- `TRADED_IN` is an **origin flag more than a station on the line** — a traded-in unit still
  flows `RECEIVING → INSPECTION → IN_STOCK → ...` like any other; model it as a boolean
  `is_trade_in_origin boolean` column set at creation time (cheap, queryable, doesn't need to
  be a mutually-exclusive status value competing with the operational ones) rather than
  literally a `status='TRADED_IN'` state that would block reuse of the same unit row through
  the normal flow. **Decision to confirm with the product owner in Phase 1**, since the spec
  names it as a status; this document flags the tension rather than silently picking one.

---

## 4. New AI agent tools

All new tools live in `lib/mcp/tools/catalogo/retail.ts` (new file), registered into
`lib/mcp/tools/index.ts`'s `allTools`, following `McpToolDefinition` exactly
(`lib/mcp/types.ts`). Every handler receives the service-role `ctx.supabase` and **must** filter
`organization_id` manually — RLS does not protect this path (`ARCHITECTURE_AUDIT.md` §12–13).
Every tool description follows the `crm_search_products` discipline: explicit instruction to
use the tool's returned number as the only source of truth, and an explicit uncertainty/partial
result signal instead of silent guessing when the tool can't fully answer.

| Tool name | Category | Min role | Purpose | Notes |
|---|---|---|---|---|
| `retail_search_products` | read | agent | Fuzzy search across `retail_products`/`retail_product_variants` by name/brand/storage/color, returns variant-level rows with **aggregate available count** (`count(*) where status='IN_STOCK'`), not a price promise | Mirrors `crm_search_products`'s partial-scan/tie signaling; never returns an individual IMEI |
| `retail_get_product` | read | agent | Full detail for one product + all its variants + per-variant available count | — |
| `retail_search_inventory` | read | agent | Search **physical units** by variant + condition/battery filter, for "do you have a cheaper used one?" type questions | Returns unit-level rows *without* IMEI (IMEI is not something the agent should read out over WhatsApp) unless `requiresRole` is raised — see below |
| `retail_get_inventory_unit` | read | manager | Look up one unit by internal id or IMEI — full detail including IMEI/cost/margin | **`requiresRole: "manager"`**, not `agent` — cost and IMEI are staff-facing, not customer-facing; the customer-facing agent uses `retail_search_inventory` instead. This split mirrors the `catalog_products_write` role gate already in the codebase (read is broad, financially-sensitive detail is narrower) |
| `retail_calculate_trade_in` | read | agent | Given claimed model/condition/battery health, returns an **estimate** band, never a binding offer | Description must explicitly say "this is an estimate; a store evaluation may differ" — mirrors the multi-evaluation-row design in §2 so the AI's number and the counter's number can coexist without contradiction |
| `retail_reserve_device` | write | agent | Reserve one specific `retail_inventory_units` row for a short TTL while a customer confirms via WhatsApp | See §6 for the concurrency contract; **must** use the advisory-lock pattern, not a bare `UPDATE ... WHERE status='IN_STOCK'` race |
| `retail_release_reservation` | write | agent | Cancel a reservation before it sells (customer went quiet, or the operator overrides) | — |
| `retail_get_sale_status` | read | agent | Given a sale id or contact, status/total/payment status — the sales-side analog of `crm_list_contact_orders` | Complements rather than replaces `crm_list_contact_orders`, which stays scoped to Nuvemshop `orders` |
| `retail_get_repair_status` | read | agent | Given a repair order id or contact, current status/ETA | Customer-facing wording only ("está pronta para retirada"), never internal diagnosis notes verbatim unless flagged customer-safe |
| `retail_list_open_warranties` | read | agent | For a contact, what's still under warranty and until when | — |

**Explicit non-goal**: no tool in this list ever lets the model **set** a price, **invent** a
stock count, or **complete** a sale/payment on its own — `retail_reserve_device` only holds a
unit for human/customer confirmation; the write that actually marks a unit `SOLD` happens
through the POS API route (`app/api/v1/retail/sales/...`, human-driven, Phase 2), never through
an MCP tool in Phase 3. This is the same "Operador acts, but the money-moving step stays a
human-reviewed action" boundary the existing appointment-booking tools (`crmBookAppointment`
etc.) already draw — extend it, don't relax it.

Capability gating: new tools must be added to whatever allowlist governs which orgs/agent
versions can call them (`lib/ai/agents/capacidades-padrao.ts`) — a store that hasn't opted into
the retail module shouldn't have these tools silently appear.

---

## 5. Multi-tenancy and RLS for every new table

No exceptions, all 15 tables:

```sql
alter table public.retail_<x> enable row level security;

create policy retail_<x>_select on public.retail_<x>
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

create policy retail_<x>_write on public.retail_<x>
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, '<min_role_for_write>'))
  )
  with check ( /* same predicate */ );

revoke all on public.retail_<x> from anon;
grant select, insert, update, delete on public.retail_<x> to authenticated;
grant all on public.retail_<x> to service_role;
```

Suggested write-role floor per table (mirrors why `catalog_products` picked `manager`: money
and stock-affecting writes are not a `viewer`/`agent` action):

- `manager`+: `retail_products`, `retail_product_variants`, `retail_suppliers`,
  `retail_purchases`, `retail_purchase_items`, `retail_sales` status transitions that move
  money, `retail_payments`, `retail_installments`, `retail_warranties`.
- `agent`+ (front-desk staff can operate day-to-day): `retail_inventory_units` status
  transitions that are operational, not financial (`RECEIVING→INSPECTION`, marking `DELIVERED`),
  `retail_repair_orders`, `retail_trade_ins` intake, `retail_trade_in_evaluations`.
- Every write, regardless of role floor, still emits `retail_inventory_movements` and
  `api_audit_log` rows — role controls *who can act*, the movement/audit tables record *what
  happened*, and the second one is never optional.

Every one of these 15 tables needs its own two-tenant isolation invariant test, in the style of
`tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts`, **specifically exercising the MCP tool
handlers** from §4 (since those run through the service-role client and RLS doesn't help them —
`ARCHITECTURE_AUDIT.md` §5/§13). The API-route paths (Phase 1/2) get equivalent coverage but
their risk is lower because the session client enforces RLS for them automatically; the MCP
tool path is where a missed `organization_id` filter is a real cross-tenant leak.

---

## 6. Concurrency-safe reservation (the "don't sell the same iPhone twice" problem)

Do **not** implement this as an application-level check-then-write (`SELECT status ...` then
`UPDATE ... WHERE id = X`) — that's exactly the race the codebase has already been bitten by
once (migration `0256`'s "lead do ingest não duplica" postmortem: three simultaneous WhatsApp
messages from one contact produced three duplicate leads because the old code was
check-then-act).

Use the same primitive already proven in this codebase for "only one of these happens per key
at a time": a `security definer` SQL function wrapping the whole reserve/sell operation in
`pg_advisory_xact_lock(hashtextextended(<unit_id>::text, <namespace>))`, mirroring
`fn_reserve_channel_connection` (migration `0228`) and `fn_nascer_lead_da_conversa` (migration
`0256`).

```sql
create or replace function public.fn_retail_reserve_unit(
  p_org uuid, p_unit uuid, p_sale uuid, p_ttl_minutes integer default 15
) returns retail_inventory_units
language plpgsql security definer set search_path = public as $$
declare v_unit retail_inventory_units;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_unit::text, 9001));

  select * into v_unit from retail_inventory_units
    where id = p_unit and organization_id = p_org for update;

  if v_unit.status <> 'IN_STOCK' then
    raise exception 'unit_not_available' using errcode = 'P0001';
  end if;

  update retail_inventory_units
    set status = 'RESERVED', reserved_for_sale_id = p_sale,
        reserved_until = now() + make_interval(mins => p_ttl_minutes)
    where id = p_unit
    returning * into v_unit;

  insert into retail_inventory_movements (organization_id, unit_id, from_status, to_status, reason, related_sale_id)
    values (p_org, p_unit, 'IN_STOCK', 'RESERVED', 'reserved_for_sale', p_sale);

  return v_unit;
end;
$$;

revoke execute on function public.fn_retail_reserve_unit(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.fn_retail_reserve_unit(uuid, uuid, uuid, integer) to authenticated;
```

- `for update` inside the advisory-locked section is belt-and-suspenders against a second
  session that somehow bypasses the advisory lock namespace; the advisory lock is what actually
  serializes concurrent callers for the *same unit id*, cheaply, without escalating to a
  table-level lock that would stall unrelated units.
- **Expiry** is a cron (`app/api/v1/cron/retail-reservation-expiry/route.ts`, same shape as the
  existing 24-cron roster), not a trigger — a trigger doing time-based cleanup on every write
  would violate "trigger never does side effects beyond its own row," and a cron that flips
  `RESERVED → IN_STOCK` for rows past `reserved_until` is the same idiom as
  `recover-stuck-messages`. It must emit its own `retail_inventory_movements` row per release
  and — per the cron-audit doctrine (`ARCHITECTURE_AUDIT.md` §15) — only write an audit row when
  it actually released something, never on an empty sweep.
- The `retail_reserve_device` MCP tool (§4) calls this function via RPC, exactly the way
  existing write tools call `security definer` functions rather than doing raw multi-statement
  writes from TypeScript — keeps the invariant enforceable in one place regardless of caller
  (API route, MCP tool, or a future integration).
- Marking a unit `SOLD` (completing the sale, Phase 2) is a second function,
  `fn_retail_complete_sale`, which re-validates `status = 'RESERVED' and reserved_for_sale_id =
  p_sale` under the same advisory lock before flipping to `SOLD` inside the same transaction
  that writes `retail_sale_items`/`retail_payments` — so "reserve" and "sell" are two
  serialized steps, not one, matching the product flow (reserve while customer confirms on
  WhatsApp, complete at the counter with payment).

---

## 7. What this domain deliberately does *not* touch

- No change to `crm_pipelines`/`crm_stages`/`vocabulary` — a "sale" is not forced to be a CRM
  deal; if a store wants sales to also appear as pipeline stages, that's a `crm_lead_links`
  relationship layered on top, not a redesign of the funnel.
- No change to `channel_sessions`/WAHA/webhook code — nothing here is a new channel.
  `retail_reserve_device` being *called by* the agent during a WhatsApp conversation is the only
  connection point, and it's a normal tool call through the existing MCP path.
- No change to `ai_agents`/`ai_agent_versions` publishing mechanics — new tools are additive to
  the existing capability/tool catalog, not a new agent type.
- No new auth mechanism, no new RBAC role — the existing 4-role ladder
  (`viewer < agent < manager < admin`) is sufficient; §5 only decides the *floor* per table.
