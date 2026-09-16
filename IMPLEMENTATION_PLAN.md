# Implementation Plan — Mobile Retail Domain

> Depends on `ARCHITECTURE_AUDIT.md` (base-system conventions) and `MOBILE_RETAIL_DOMAIN.md`
> (schema, tools, RLS design referenced throughout). Every phase's Definition of Done is the
> repo's actual DoD (`CLAUDE.md`, bottom section), restated per-phase below so it isn't lost:
> `pnpm typecheck` zero, `pnpm lint` zero, RLS tested for every tenant-aware table touched,
> audit log emitted on every mutation, migration file **+** `baseline.sql` appendix **+**
> `MANIFEST.md` line for every schema change, `.env.example`/`lib/env.ts` updated for new env
> vars, nav entry (`lib/navigation/catalogo.ts`) for any new screen, UI changes proven by
> driving a real browser against a fresh VPS-like environment (not curl), and a `.changes/`
> fragment for anything a self-host operator would notice.

---

## ⚠️ MVP CUT — decided 2026-09-16, read this before starting any phase below

**Context:** schema for all 15 `retail_*` tables (Phase 1's data-model half) already shipped and
is fully verified (`pnpm test:db` green, migrations 0262-0269). Building full service layer + API
+ staff UI + AI tools for all 15 tables, then trade-in/repair/analytics/AI-business-analyst on top,
before a single real store ever touches this, is more spend than the business needs before
validating the core loop. This matches what the original research doc itself recommended (its
own §72-73 MVP list) — the phased plan below drifted wider than that MVP during design.

**Decision: cut scope to the smallest thing that is a real, sellable MVP loop**, then stop and
get a pilot store using it before building anything past this cut. "Smallest real loop" =
*a store can receive stock with IMEI, see accurate inventory, sell a unit, and the WhatsApp AI can
correctly answer "do you have X / how much" from real data* — that's the whole differentiator the
original pitch (`AI_OS_PARA_LOJAS_DE_IPHONE`) is built on; everything else is expansion after that
loop is proven.

**In scope for MVP** (build these, in this order):
- **Phase 1 — MVP slice only:** service layer (`lib/retail/`) + API routes + staff UI for
  `retail_products`, `retail_product_variants`, `retail_inventory_units`,
  `retail_inventory_movements`, `retail_suppliers`, `retail_purchases`, `retail_purchase_items`
  only. Skip building routes/UI for `retail_sales`/`retail_payments`/`retail_installments` here —
  those get their real UI in the Phase 2 slice below, not duplicated.
- **Phase 2 — MVP slice only:** `fn_retail_reserve_unit` + `fn_retail_complete_sale`
  (concurrency-safe, as designed in `MOBILE_RETAIL_DOMAIN.md` §6 — this is correctness, not scope
  creep, don't simplify the locking away) + a minimal POS flow: create a sale, add one or more
  `retail_inventory_units` as line items, take a payment, mark `SOLD`/`DELIVERED`. No installment
  UI, no multi-payment-method polish beyond what `retail_payments.method` already models — one
  payment row per sale is enough for MVP.
- **Phase 3 — MVP slice only:** wire **3 tools**, not all 9 from `MOBILE_RETAIL_DOMAIN.md` §4:
  `retail_search_products`, `retail_get_product`, `retail_search_inventory`. These are what make
  the WhatsApp pitch real ("temos 2 unidades..."). Skip `retail_reserve_device` (needs the AI Lab's
  guardrail-testing discipline before it touches real inventory — a mistake here holds a real
  customer's phone), skip everything repair/warranty/trade-in-related.

**Explicitly deferred until a pilot store validates the above** (schema already exists and needs
no rework when the time comes — do not delete or alter it):
- `retail_trade_ins` / `retail_trade_in_evaluations` UI, API, and the `retail_calculate_trade_in`
  tool (Phase 5 in the original numbering).
- `retail_repair_orders` UI/API (no phase number below — was implicit in Phase 1's "all 15
  tables get UI" scope, now cut).
- `retail_warranties` UI/API (same).
- `retail_reserve_device` / `retail_release_reservation` tools, and any other Phase 3 tool beyond
  the 3 listed above.
- Phase 4 (AI evaluation lab), Phase 6 (analytics), Phase 7 (AI business-analyst NL queries) —
  all deferred in full until the MVP loop has a real store's data behind it to build against
  (analytics and an AI analyst answering questions about zero real transactions is building
  against a guess, not a need).

**When to un-defer something:** when the pilot store actually asks for it, or the MVP loop is
solid enough in production that the next-highest-value gap is obviously one of the deferred
items — not on a fixed calendar. Re-read `MOBILE_RETAIL_DOMAIN.md`'s §2/§4 for the deferred
item's design before building it; nothing there needs to be redesigned, only picked back up.

---

## Phase 0 — WhatsApp via Datafy BSP (config + webhook signature, not domain logic)

**Goal:** WhatsApp goes live through Datafy (`https://app.datafyapi.com.br/docs`), a
Meta-homologated BSP proxying the Cloud API 1:1, instead of direct Meta Business Manager or
WAHA. **This removes the Meta app-review/approval flow entirely** — a number is connected via
Datafy's own dashboard and issues an `sk_live_...` token, no Meta Business Manager app approval
in the loop — which is a real timeline win worth calling out on its own, separate from anything
else in this plan. This phase is almost entirely configuration plus one new signature-verification
function; it does not touch CRM/AI/retail domain logic and can land independently of, and
before, Phase 1. See `ARCHITECTURE_AUDIT.md` §8.1 for the full code-level analysis this phase's
deliverables are based on.

**Deliverables**

- Add `graphBaseUrl()` next to `graphVersion()` in `lib/graph-version.ts`: reads a new env var
  (e.g. `META_GRAPH_BASE_URL`), defaults to `https://graph.facebook.com` so existing direct-Meta
  installs are unaffected. Replace the three literal `https://graph.facebook.com` prefixes in
  `lib/channels/adapters/meta-cloud.ts` (`send`, `checkHealth`, `fetchInboundMedia`) with it.
  Add the new var to `.env.example` and `lib/env.ts` (Zod-validated, per DoD item 9). Point it
  at `https://cloud.datafyapi.com.br/v1/` for a Datafy-connected org.
- Confirm (don't assume) whether Datafy's media-serving host matches the existing
  `.fbsbx.com`/`.fbcdn.net` allowlist in `fetchInboundMedia` (`meta-cloud.ts:238`) — if Datafy
  proxies media through its own domain, that allowlist needs a Datafy entry too, added by
  suffix per the existing comment's own stated policy ("grow by Meta domain suffix, never an
  arbitrary host"), extended here to "or Datafy's documented media host, once confirmed against
  their `/media` docs" — do not add a wildcard or guess a hostname.
- New function `verifyDatafySignature(rawBody, timestamp, signatureHeader, secret)` alongside
  (not replacing) `verifyMetaSignature()` in `lib/channels/meta/webhook.ts` (or a sibling
  `lib/channels/meta/webhook-datafy.ts` if keeping the two schemes visually separate reads
  better — match whichever the existing file's own organization suggests once you're in it):
  HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` against a `whsec_...` secret, header
  `x-datafy-signature-256`, reject if `x-datafy-timestamp` is >300s from now (replay
  protection) using `timingSafeEqual` exactly like `verifyMetaSignature` already does (don't
  regress the timing-safety property the existing function has). Secret storage follows the
  `platform_meta_app` pattern (migration `0257`): installation-scoped, encrypted via the
  existing `fn_encrypt_oauth`/`fn_decrypt_oauth` RPCs, never a new crypto path.
- `app/api/v1/webhooks/meta/[token]/route.ts`'s `POST` handler needs to select which
  verification function to run based on which provider this session/app is configured for
  (direct Meta vs. Datafy) — likely a field on `platform_meta_app` or `channel_sessions`
  recording the active transport, read the same "source of truth in the DB, `.env` as rollback
  floor" way `appDaMeta()` already resolves the verify token/app secret pair (§8.1) rather than
  inventing a second precedence scheme.
- Decide and implement delivery-level idempotency per §8.1's two-option analysis (default
  recommendation: **do nothing new**, rely on the existing `messages_org_external_id_unique`
  wamid dedup, since Datafy's payload carries the same `wamid`) — if the team instead wants
  defense-in-depth logging via `webhook_events_log`, that's a one-line CHECK-constraint
  migration (`provider` gains `'datafy'`) plus a small insert-before-process addition to the
  route; don't build it speculatively without a measured need.
- Outbound rate-limit awareness: verify whether `lib/agent-engine/pacing/`'s anti-ban knobs
  actually apply to the `meta_cloud` adapter (not just `waha`) — if they don't, add basic
  429-aware backoff to `meta-cloud.ts`'s `send()` (distinguish a 429 from a generic `meta_error`
  so callers can retry-after rather than treating it as a permanent failure) before any bulk
  send (campaign, bulk follow-up) goes through Datafy in production.
- Tests: unit tests for `verifyDatafySignature` (valid signature, wrong secret, stale timestamp,
  tampered body — mirror the coverage `verifyMetaSignature`/its test file already has), an
  integration-style test that the webhook route picks the correct verifier for a
  Datafy-configured vs. Meta-configured session, and a manual/E2E smoke test sending one real
  message through a sandboxed Datafy number before flipping any production traffic over.

**Phase 0 DoD:** header items from the top of this document, plus: no change to
`graph.facebook.com`-direct installs' behavior (the new base-URL env var must default to
today's literal), and the new signature verifier has explicit negative-case tests (stale
timestamp, wrong secret) — not just a happy-path test, since replay protection is the whole
point of the timestamp check.

---

## Phase 1 — Catalog + inventory + IMEI (no changes to existing CRM/WhatsApp/AI)

**Goal:** the 15 tables from `MOBILE_RETAIL_DOMAIN.md` §2 exist, are RLS-correct, and are
manageable from a staff-only UI. No AI tool wiring yet (that's Phase 3) — this phase is pure
data model + CRUD.

**Deliverables**

- Migration file(s) under `supabase/migrations/` — recommend **one migration per table or
  tight cluster** (e.g. `products+variants` together, `inventory_units+movements` together,
  `suppliers+purchases+purchase_items` together) rather than one giant migration, matching the
  repo's own convention of small, named, single-concern migrations (`0204_catalogo_de_produtos`
  is a good size reference — one table + indexes + RLS + grants + comments, ~110 lines).
  Get the next `NNNN` via `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`,
  **not** by filename listing order (`CLAUDE.md` migrations doctrine — the two have diverged
  before).
- Matching idempotent appendix block(s) in `supabase/baseline.sql` (`create table if not
  exists`, `create index if not exists`, `create policy` guarded by `drop policy if exists`
  first) — this is what self-hosters actually receive; a migration without a baseline appendix
  never reaches them.
- `supabase/migrations/MANIFEST.md` line per migration, in the existing format
  (`| timestamp | NNNN_slug | one/two sentence what+why |`).
- `fn_retail_reserve_unit`/`fn_retail_complete_sale` functions can be **stubbed or deferred to
  Phase 2** here if reservation isn't needed yet for pure catalog management — but if they ship
  in Phase 1, they need the two-origin `revoke`/`grant` treatment (`ARCHITECTURE_AUDIT.md` §3)
  from day one.
- Zod schemas: `lib/schemas/retail-products.ts`, `retail-inventory.ts`, `retail-suppliers.ts`,
  `retail-purchases.ts` — shared between API routes and forms, same pattern as
  `lib/schemas/produtos.ts` (`COLUNAS_DO_PRODUTO`, `produtoCreateSchema`).
- Service layer: `lib/retail/` (new top-level dir, mirroring `lib/catalogo/`) —
  `busca.ts` (variant/unit search, can start as a straight port of
  `lib/catalogo/busca.ts`'s token-matching approach), `movimentos.ts` (the one place that
  writes `retail_inventory_movements` — **every status transition goes through this module**,
  no route/worker writes the movements table directly, so the audit trail can't drift from the
  status column by construction).
- API routes: `app/api/v1/retail/products/route.ts` (+`[id]/route.ts`),
  `.../product-variants/`, `.../inventory-units/` (+ status-transition sub-route, e.g.
  `.../inventory-units/[id]/transition/route.ts` calling into `lib/retail/movimentos.ts`),
  `.../suppliers/`, `.../purchases/` (+ a `.../purchases/[id]/receive/route.ts` that's the
  operation spawning N inventory units from purchase items — this is the one non-trivial write
  path in this phase; wrap it in a transaction). All follow the `requireRole()` →
  Zod-validate → query scoped by `authz.org.orgId` → `audit()` → `ok()`/`fail()` shape of
  `app/api/v1/products/route.ts`.
- UI: inventory list/detail screens under `app/app/retail/` (or wherever the chosen
  `NavGroupId` lands them), with an IMEI scanner-friendly quick-add flow for receiving
  (barcode/manual entry — camera-based IMEI OCR is a nice-to-have, not a Phase 1 requirement).
  Nav entries added to `lib/navigation/catalogo.ts` under the new group.
- Tests:
  - Two-tenant RLS isolation test per table (or a shared harness covering all 15 if that keeps
    it maintainable — follow `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts`'s
    `pgComoSupabase` pattern), added to `tests/invariants/`.
  - Unit tests for `lib/retail/movimentos.ts` (status transition validity — e.g. reject
    `SOLD → IN_STOCK` as not a legal edge per §3's lifecycle graph) and `lib/retail/busca.ts`.
  - Unit tests for the partial-unique IMEI index behavior against the ephemeral Postgres
    (`pnpm test:db`) — specifically: two units in `RECEIVING` with `imei = null` must **not**
    collide, but two units with the same non-null IMEI **must** be rejected.

**Explicitly out of scope for Phase 1:** no MCP tools, no AI wiring, no payments, no sale
completion. A store can receive purchases and see accurate stock in the staff UI by the end of
this phase; nothing customer-facing changes yet.

**Phase 1 DoD:** all items in the header, plus: `retail_inventory_movements` has **zero** write
paths outside `lib/retail/movimentos.ts` (grep-verifiable, worth its own guard test in the
style of `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`'s AST scan).

---

## Phase 2 — POS: Sale/SaleItem/Payment, transactional, concurrency-safe reservation

**Goal:** a staff member can ring up a sale against real inventory units without a race
condition ever double-selling a device, with cash/PIX/card payment recorded and (optionally)
installments.

**Deliverables**

- `fn_retail_reserve_unit` and `fn_retail_complete_sale` (`MOBILE_RETAIL_DOMAIN.md` §6),
  shipped as their own migration + baseline appendix if not already done in Phase 1. Both are
  `security definer`, both get the two-origin `revoke`/`grant`, both are proven by an invariant
  test that fires N concurrent reservation attempts at the same unit and asserts exactly one
  wins (a real concurrency test, not just a logic test — spin N parallel `pg` client
  connections against the test container, matching the rigor the repo already applies to e.g.
  `fn_nascer_lead_da_conversa`'s dedup guarantee).
- `app/api/v1/retail/sales/route.ts` (create draft sale, add/remove items — each item add
  calls `fn_retail_reserve_unit` via RPC for serialized items), `.../sales/[id]/complete/route.ts`
  (calls `fn_retail_complete_sale`, requires a `retail_payments` row covering the total first —
  no completing a sale for less than its total without an explicit discount already reflected
  in `retail_sales.discount_cents`), `.../sales/[id]/cancel/route.ts` (releases any reserved
  units back to `IN_STOCK` via the same movement-logging path).
- `app/api/v1/retail/payments/route.ts`, `.../installments/route.ts` if store-financed
  installments are in scope for this phase (can slip to a later phase if the pilot store
  doesn't offer crediário — confirm with product before building).
- `app/api/v1/cron/retail-reservation-expiry/route.ts` — sweeps `reserved_until < now()`,
  releases, logs a movement per release, audits only when it released something
  (`ARCHITECTURE_AUDIT.md` §15 cron-audit doctrine), scheduled in the `scheduler` service's
  crontab generation.
- Idempotency: sale completion is a POST that moves money — give it `Idempotency-Key` support
  (`lib/api/idempotency.ts`, the same helper `message-templates` already uses) so a
  double-tapped "complete sale" button or a retried request can't double-charge/double-sell.
- UI: POS screen (item scan/search → cart → payment → receipt), sale history, a "my open
  reservations" view for staff to see what's currently held and why.
- Tests: the concurrency invariant above; unit tests for `fn_retail_complete_sale`'s guard
  against completing a sale whose reservation already expired; E2E (Playwright) for the full
  ring-up flow against a fresh baseline, per the QA Visual doctrine — this is exactly the kind
  of money-moving user flow that doctrine exists for.

**Phase 2 DoD:** all header items, plus the concurrency test above is green and demonstrably
would have failed against a naive check-then-write implementation (write it, prove it fails
against the naive version first, then fix it — TDD per `superpowers:test-driven-development`,
which `CLAUDE.md` names as the right skill for exactly this kind of critical feature).

---

## Phase 3 — Wire inventory into the existing AI agent as tools

**Goal:** the agent can answer stock/price/reservation questions over WhatsApp using the new
domain, with the "never invent stock/price" guarantee enforced structurally, not just by prompt
instruction.

**Deliverables**

- `lib/mcp/tools/catalogo/retail.ts` implementing the 9 tools from `MOBILE_RETAIL_DOMAIN.md` §4,
  wired into `lib/mcp/tools/index.ts`'s `allTools`.
- Tool catalog entries (`lib/mcp/tools/catalog.ts` / the `catalogo/` metadata) with both the
  model-facing `description` (uncertainty-signaling, per the `crm_search_products` template)
  and the human-facing `rotulo`/`explicacao`/`oQueToca` — checked by
  `tests/unit/catalogo-tools-leigo-friendly.test.ts`.
- Capability gating: add the new tools to `lib/ai/agents/capacidades-padrao.ts`'s allowlist
  machinery so they're opt-in per org/agent version, not silently available everywhere.
- `retail_reserve_device` and `retail_release_reservation` are the **only** write tools in this
  phase — no MCP tool completes a sale or sets a price; that stays a human action through the
  Phase 2 API routes. This boundary is a design decision worth encoding as a test: assert no
  tool in `retail.ts` can reach `fn_retail_complete_sale` or write `retail_sales.status =
  'completed'`.
- Two-tenant invariant tests for every new tool, specifically exercising the MCP handler path
  (service-role client, no RLS safety net) — per `MOBILE_RETAIL_DOMAIN.md` §5's explicit call-out
  that this is the higher-risk path compared to the API routes.
- Guardrail review: confirm the pre-send checklist (`lib/ai/guardrails/lista-de-conferencia.ts`)
  covers "did the agent state a price/IMEI/stock number that didn't come from a tool result in
  this turn" — extend it if it doesn't already generalize to the new domain.
- RAG note: if product **descriptions** (not price/stock) should be searchable via the
  knowledge base (e.g. "does the 15 Pro have a better camera than the 14?"), extend
  `lib/ai/rag/format-product.ts` or add a sibling formatter for `retail_products` and emit an
  indexing event (`retail_product.updated` → `rag-indexer`) — but price/stock/IMEI answers
  **always** go through the tools above, never through a RAG chunk, per
  `ARCHITECTURE_AUDIT.md` §10.

**Phase 3 DoD:** all header items, plus a test asserting the tool boundary above (no write tool
reaches sale completion), plus the guardrail review is a written note in the PR, not just
implied.

---

## Phase 4 — AI evaluation lab / test cases for the new tools

**Goal:** confidence that the agent actually uses the new tools correctly in realistic
conversations, before it's trusted with real customers — the repo already has a
flywheel/evaluation mechanism (`lib/agent-engine/flywheel/`, `avaliar-resposta-de-teste.ts`,
`scripts/flywheel-judge-live.ts`); this phase extends it rather than building a parallel one.

**Deliverables**

- A set of golden test conversations specific to retail intents: "do you have an iPhone 13 in
  blue," "how much for my old iPhone 12," "is my repair ready," "hold this one for me, I'll come
  by in an hour" — each with an expected tool-call sequence and an expected refusal-to-guess
  behavior when stock/price data is intentionally absent from the seed data (the negative case
  matters as much as the positive one: prove the agent says "let me confirm with the team"
  rather than inventing a number, mirroring the existing `varreduraParcial` test coverage
  pattern in `lib/mcp/tools/comercio.ts`'s test file).
- Wire these into whatever harness `lib/ai/agents/avaliar-resposta-de-teste.ts` already
  provides (`lib/agent-engine/golden-candidates/` looks like the existing home for this kind of
  fixture — confirm exact wiring by reading that directory before adding a parallel mechanism).
- A specific regression case for the trade-in estimate wording: assert the agent's phrasing
  always includes the "this is an estimate, in-store evaluation may differ" caveat that
  `retail_calculate_trade_in`'s tool description mandates — test the *output*, not just that the
  tool was called, since a model can call a tool correctly and still misstate its result in
  prose.
- Cost/budget check: confirm the new tools' typical call volume doesn't blow past
  `ai_budgets` per-org caps in a busy store scenario — this is a capacity-planning check, not
  new code, but worth doing before Phase 5 adds even more tool-call volume (trade-in flows are
  chatty).

**Phase 4 DoD:** golden test suite runs in CI (or is explicitly scheduled if too slow/costly for
every PR — match whatever cadence the existing flywheel eval already runs at), and includes at
least one negative case per tool (the "don't invent" case), not just happy-path coverage.

---

## Phase 5 — Trade-in

**Goal:** the AI-estimate → in-store-evaluation → offer → accept → device becomes inventory
flow is fully wired end to end.

**Deliverables**

- `app/api/v1/retail/trade-ins/route.ts` (+ `[id]/evaluate`, `[id]/offer`, `[id]/accept`,
  `[id]/decline` sub-routes) — each writes an audited state transition on `retail_trade_ins`
  and, where applicable, a `retail_trade_in_evaluations` row (append, never overwrite — §2's
  multi-evaluation design).
- On accept: a function (same `security definer` + advisory-lock discipline as §6, keyed by the
  trade-in id) that atomically creates a `retail_inventory_units` row in `RECEIVING` with
  `is_trade_in_origin = true`, links it back via `retail_trade_ins.resulting_inventory_unit_id`,
  and — if the trade-in was applied as credit toward a purchase — links
  `resulting_sale_id`. Resolve the `TRADED_IN`-as-status-vs-flag tension flagged in
  `MOBILE_RETAIL_DOMAIN.md` §3 with the product owner before writing this migration; it's a
  five-minute decision now and a data-migration headache later if deferred.
- **Reuse the follow-up engine** (`lib/followup/`, `lib/agent-engine/agent/followup-turn.ts`,
  `schedule-followup.ts`) for "customer got an estimate but never followed through" nudges,
  rather than building a parallel scheduler — this is a direct instance of the reuse
  `ARCHITECTURE_AUDIT.md` §14 flags as available. Confirm the follow-up engine's entity model
  can attach to a `retail_trade_ins` row (it's currently CRM-lead-centric; may need a
  polymorphic extension, which is itself worth scoping carefully rather than assuming it's free).
- UI: trade-in intake form (photos to Storage — mind the shared-quota note in
  `ARCHITECTURE_AUDIT.md` §16), evaluation screen for staff, offer/accept flow.
- Tests: RLS isolation for the two new tables (if not already covered in Phase 1's batch), the
  accept-flow atomic function under concurrency (two staff accepting the same trade-in
  simultaneously should not double-create inventory units), E2E for the full customer-facing
  quote flow.

**Phase 5 DoD:** header items, plus explicit sign-off on the `TRADED_IN` status-vs-flag decision
recorded in the migration's comment (the repo's own convention — see how migration `0256`'s
file documents *why* it didn't choose the unique-index approach it considered and rejected).

---

## Phase 6 — Analytics

**Goal:** margin, sell-through, aging inventory, and trade-in economics are visible without a
bespoke BI tool.

**Deliverables**

- `lib/retail/metrics.ts` (mirrors `lib/reports/atividades.ts` / `fn_attendant_metrics`'s
  existing pattern of a SQL-heavy aggregation function backing a reporting screen) covering at
  least: gross margin per sale (uses `retail_inventory_units.cost_cents` at time of sale —
  pull from the `retail_inventory_movements` snapshot metadata, not the live `cost_cents`
  column, in case it's ever corrected after the fact — historical reports must not silently
  change), inventory aging (days in `IN_STOCK` per unit, bucketed), sell-through rate per
  variant, trade-in acceptance rate and average estimate-vs-final delta (directly answerable
  from the multi-evaluation design in §2).
- `app/api/v1/retail/reports/route.ts` (+ sub-routes per report), following the existing
  `app/api/v1/reports/activities` shape.
- UI dashboard screens under the retail nav group.
- **Reuse, don't duplicate:** if attendant-level productivity should include retail sales
  (e.g. "who sold the most this month"), extend `fn_attendant_metrics` (already patched once
  for voice calls in migration `0235` — same extension pattern: add a CTE, add fields) rather
  than building a second metrics function that partially overlaps it.
- Tests: SQL aggregation correctness against seeded fixtures (known inputs → known margin/aging
  numbers), RLS on any new reporting tables/views.

**Phase 6 DoD:** header items; no new tenant-aware table here should exist without RLS just
because "it's just a report" — a report view over tenant data still needs the org filter,
whether that's a `security invoker` view relying on the underlying tables' RLS (preferred,
simplest) or an explicit filter in the query layer.

---

## Phase 7 — AI business-analyst natural-language queries

**Goal:** "how many iPhone 13s do we have left," "what's our average margin this month,"
"which trade-ins are we waiting on," answerable in natural language by the agent, backed by
Phase 6's metrics layer — **not** by giving the model free-form SQL access.

**Deliverables**

- New **read-only** MCP tools wrapping Phase 6's `lib/retail/metrics.ts` functions with
  bounded, parameterized inputs (date range, variant filter, etc.) — the same discipline as
  every other tool in this plan: the model chooses *which* pre-built query to run and with what
  parameters, it never constructs the query itself. This is a hard line worth stating
  explicitly in the PR description, since "AI business analyst" is exactly the kind of feature
  that invites "just let it write SQL" as a shortcut — that shortcut is a direct violation of
  the "AI must never invent stock/price" spirit extended to "AI must never invent an aggregate
  either," and it's also a straightforward SQL-injection-via-tool-call risk if ever implemented
  literally.
- Tool descriptions again follow the uncertainty-signaling template: a query over an empty date
  range or an org with no data returns an explicit "no data for this period," never a
  fabricated zero dressed up as a real answer versus an actually-measured zero — same
  distinction `crm_search_products` draws for the catalog.
- Rate/cost consideration: analytics queries are more likely to be run by staff via an admin
  chat surface than by the WhatsApp customer-facing agent — confirm which surface this ships on
  before building (`docs/specs/12-spec-ai-agents-ui.md` is the doc to check for whether an
  internal/staff-facing chat surface already exists or needs to be added; this plan doesn't
  assume one does).
- Tests: golden queries per report type (Phase 4's evaluation lab pattern, extended), and a
  cross-tenant check specifically for this tool family since "aggregate business metrics" is a
  textbook case where a lazy implementation forgets the org filter because "it's just a count."

**Phase 7 DoD:** header items, plus an explicit code-level guard (not just a description string)
that every new tool's underlying query is parameterized and org-scoped — e.g. a lint/test rule
scanning `lib/retail/metrics.ts` exports for an `organization_id` parameter, similar in spirit
to `tests/unit/hardening-definer-varredura.test.ts`'s exhaustive scan approach for `security
definer` functions.

---

## Top risks

1. **`CLAUDE.md` constraints that bind this whole plan, restated so they aren't missed:**
   - No trigger may ever do HTTP or a cross-cutting side effect — every "notify the AI /
     trigger a follow-up / reindex RAG" moment in this plan must go through `event_log`, not a
     trigger calling out directly.
   - Every schema change needs **both** a `supabase/migrations/` file **and** an idempotent
     `supabase/baseline.sql` appendix **and** a `MANIFEST.md` line, every time, no exceptions —
     15 new tables plus N functions across 7 phases is a lot of surface area for this to slip
     on any single PR.
   - Every new `security definer` function in `public` needs the two-origin
     `revoke from public, anon` / `grant to <role>` treatment or it's born exposed to the `anon`
     key that ships to the browser (`fn_retail_reserve_unit`, `fn_retail_complete_sale`, the
     trade-in accept function, and any Phase 7 analytics wrapper are all `security definer`
     candidates).
   - Service-role handlers (every MCP tool, by construction) must filter `organization_id`
     manually — RLS does not protect them. This is the single highest-consequence mistake
     available in this entire plan (cross-tenant IMEI/price/customer data leak), and it has no
     automated prevention in this codebase today beyond code review + the invariant tests this
     plan mandates writing for every new tool.

2. **Naming collisions, restated from `MOBILE_RETAIL_DOMAIN.md` §0:** `catalog_products` and
   `nuvemshop_products` already exist and mean something different from the new `retail_*`
   tables. Anyone joining this project mid-stream who hasn't read that section is likely to
   reach for `catalog_products` first (it's the obvious grep hit for "products") and either
   corrupt it or build against the wrong table. Worth a comment at the top of
   `lib/retail/` pointing at the distinction.

3. **Migration-chain gotchas** (`ARCHITECTURE_AUDIT.md` §3): migrations `0001`-`0009` and
   `0013` are stub `SELECT 1;` — a fresh clone's migration chain does **not** produce a working
   database; only `baseline.sql` does. Any Phase 1 work that tests against a fresh install must
   apply `baseline.sql`, not replay `supabase/migrations/` from scratch, or it will appear to
   work locally and then be absent for every self-hoster. The `NNNN` numbering is independent
   of the timestamp-based filename sort — always compute the next number with the `grep`
   command in `CLAUDE.md`, not by eyeballing `ls`.

4. **The advisory-lock reservation design (Phase 2) is new-to-this-domain but not new-to-this-
   codebase** — the risk isn't the primitive (it's proven, see `ARCHITECTURE_AUDIT.md` §15),
   it's under-testing the concurrency case. A logic-only unit test of
   `fn_retail_reserve_unit` that never actually fires concurrent connections at it will pass
   green while a real race still exists. Phase 2's DoD explicitly requires a test that launches
   parallel `pg` connections, not just parallel `Promise.all` calls against one shared
   in-process client (which wouldn't exercise real transaction isolation).

5. **`test:unit` vs `test:db` false-green trap applies directly to this project**: everything
   in Phases 1, 2, 3, 5 touches schema/RLS/security-definer functions. `pnpm gov:verify` and
   even `pnpm test:unit` passing is **not sufficient evidence** any of those phases are safe to
   ship — `pnpm test:db` (which needs Docker) is the only gate that actually applies
   `baseline.sql` fresh and exercises the invariants. This plan's phase-by-phase DoDs call out
   RLS/concurrency tests explicitly for exactly this reason; don't let a green `gov:verify` be
   mistaken for readiness.

6. **Capability/tool-catalog gating (Phase 3) is easy to forget and hard to notice you forgot**:
   a new MCP tool that isn't added to `lib/ai/agents/capacidades-padrao.ts`'s allowlist may
   simply not be offered to any agent, which fails silently (the feature "works" in isolation
   testing the tool directly, but no real conversation ever reaches it) — or, gotten backwards,
   a tool added without going through the allowlist mechanism at all might be available to
   *every* org's agent by default when it should be opt-in per the product's staged rollout
   intent. Confirm which failure mode the current allowlist defaults to before shipping Phase 3.

7. **Repair-order and warranty either/or FKs (`inventory_unit_id`/`repair_order_id`,
   `contact-owned device with no inventory_unit_id`) are exactly the kind of "polymorphic
   without standardization" anti-pattern #8 in `CLAUDE.md` warns about if the CHECK constraints
   enforcing "exactly one of X/Y" aren't airtight from the first migration.** Get the CHECK
   right in Phase 1/5, because loosening a constraint later is easy and tightening one after
   bad data has accumulated is not.

8. **Shared Storage quota** (`ARCHITECTURE_AUDIT.md` §16): trade-in photos, IMEI-box photos,
   and repair documentation all compete with `whatsapp-media` for the same 1 GB self-host
   quota on the smallest tier. Not a blocker for any phase, but worth sizing/compressing
   deliberately (thumbnail-first, don't store originals indefinitely) rather than discovering
   it when a pilot store's install starts failing media uploads.
