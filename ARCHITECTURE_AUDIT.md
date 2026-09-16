# Architecture Audit — DeskcommCRM (base for AI OS iPhone)

> Read-only audit. Sources: `CLAUDE.md`, `ARCHITECTURE.md`, `VISION.md`, `docs/index.md`,
> `docs/specs/*`, `supabase/baseline.sql` (25 043 lines — the authoritative schema; migrations
> 0001-0009 and 0013 are stub `SELECT 1;`, do not trust them), and real code under `lib/`,
> `app/api/v1/`, `lib/mcp/`, `lib/agent-engine/`. Docs sometimes drift from code — where they
> did, this file notes the actual behavior and cites the line/file that proves it.
>
> `docs/current-state.md` is dated 2026-07-29 (v1.0.0, commit `789dfa6`) and admits itself to
> be ~1000+ commits stale relative to `main` today (`main` is at migration `0260`,
> 2026-09-15). Treat its specific numbers as historical color, not current fact.

---

## 1. Frontend

- **Stack:** Next.js 16 App Router (Turbopack), React 19, TypeScript strict, Tailwind 4
  (CSS-first — no `tailwind.config.ts`; tokens in `app/globals.css` under `:root`/`[data-theme]`),
  shadcn/ui (`components.json`, style `new-york`, neutral).
- **Route groups:** `app/(admin)/` (platform admin), `app/(public)/` (marketing/login/signup),
  `app/app/` (authenticated tenant app — inbox, kanban, CRM, IA, settings), `app/api/` (route
  handlers). Edge middleware lives in `proxy.ts` (Next 16 renamed `middleware.ts` → `proxy.ts`;
  injects `X-Request-Id`/`x-pathname`, gates public paths, validates session cookie).
- **Components:** `components/{admin,agenda,ai,app,auth,branding,connections,contacts,empty,
  feedback,inbox,kanban,operacao,shell,team,theme,ui,voice}/` — organized by domain, not by
  atomic-design layer.
- **Navigation:** single source of truth is `lib/navigation/catalogo.ts` (`NAV_CATALOG`), typed
  by `NavGroupId = "atendimento" | "crm" | "ia" | "canais" | "analise" | "organizacao"`.
  Sidebar, the Settings hub and the ⌘K palette are pure projections of this array —
  `tests/unit/navegacao-completude.test.ts` fails CI if a page exists but isn't reachable from
  here. **Adding a screen without an entry here is a DoD violation (item 14).**
- **Realtime:** Supabase Realtime — `postgres_changes` for inbox/kanban live updates,
  `broadcast` for lightweight signals. New tables that need live UI must be added to the
  `supabase_realtime` publication explicitly (migration `0234` is a cautionary tale: a table
  was created but never added to the publication, so its UI silently never updated — verify
  with `select * from pg_publication_tables`).
- **Extension pattern:** new domain screen → page under `app/app/<area>/`, entry in
  `lib/navigation/catalogo.ts` under an existing or new `NavGroupId`, data via `/api/v1/*`
  fetched from Server Components by default (Client Components only where interactive state is
  needed).

## 2. Backend

- **Route handlers:** `app/api/v1/**/route.ts` — 196 handlers today (was 169 at the stale
  audit). Grouped by domain folder (`admin`, `ads`, `agenda`, `ai`, `attendants`, `audit`,
  `auth`, `automation-rules`, `channel-sessions`, `channels`, `contacts`, `conversation-tags`,
  `conversations`, `cron`, `demandas`, `health`, `integrations`, `lead-captures`, `leads`,
  `lgpd`, `marca`, `mcp`, `message-templates`, `messages`, `metrics`, `notifications`,
  `onboarding`, `pipelines`, `products`, `reports`, `settings`, `system`, `tasks`, `team`,
  `voice`, `webhook-sources`, `webhooks`).
- **Canonical request flow** (`ARCHITECTURE.md` §"Fluxo de uma requisição", confirmed against
  `app/api/v1/products/route.ts`):
  1. `proxy.ts` stamps `X-Request-Id`, checks `isPublicPath`, validates the Supabase session
     cookie for non-public paths.
  2. Handler: Zod validates external input → `requireRole(min, opts)` from
     `lib/auth/require-role.ts` (the **only** authorized way to gate by role — hand-rolled
     `ROLE_RANK` comparisons in a route are an anti-pattern) → resolve
     `organization_id` from a trusted source (never the body) → query (RLS via session client,
     or manual `organization_id` filter with the admin client) → `audit()` fire-and-forget on
     mutation → `ok(data, meta)` / `fail(code, message, status)` from `lib/api/wrappers.ts`.
  3. Non-cookie surfaces: `/api/v1/cron/*` (Bearer `INTERNAL_CRON_SECRET`, fail-closed),
     `/api/internal/*` (`x-internal-secret`), `/api/mcp` (Bearer `tok_...` against
     `api_tokens`), `/api/v1/webhooks/*` (HMAC + path token).
- **Response envelope:** `{ data, meta?: { cursor, has_more, total } }` on success,
  `{ error: { code, message, details? } }` on failure — always via `ok()`/`fail()`, never raw
  `NextResponse.json`.
- **Extension pattern (new resource):** copy the shape of `app/api/v1/products/route.ts` —
  `requireRole()` → Zod schema from `lib/schemas/<resource>.ts` (shared between the API route
  and the frontend form, e.g. `lib/schemas/produtos.ts` exports `COLUNAS_DO_PRODUTO` +
  `produtoCreateSchema`) → Supabase client scoped to the resolved org → `audit()` on
  create/update/delete → `ok()`/`fail()`.

## 3. Database schema

- **`supabase/baseline.sql`** (25 043 lines) is authoritative — a `pg_dump --schema-only`
  snapshot plus an **idempotent appendix** of labeled blocks (`-- ---- <what> (migration NNNN)
  ----`) that the self-host kit's `install.sh`/`update.sh` apply. It currently covers through
  migration `0260`.
- **`supabase/migrations/`** has 242 files but **0001-0009 and 0013 are stub `SELECT 1;`** —
  never treat them as real schema. Real migrations start meaningfully later; the numbering is
  independent of filename ordering (see `NNNN` warning in `CLAUDE.md` — the next number is
  `max(NNNN)`, not `ls | tail -1`, because timestamp and NNNN can disagree).
- **Core tables** (from `CREATE TABLE` scan of the dump + appendix, non-exhaustive but
  covering everything relevant to this audit): `organizations`, `platform_admins`,
  `user_organizations`, `user_recovery_codes`, `api_tokens`, `api_audit_log`, `event_log`,
  `idempotency_keys`, `incidents`, `merge_queue`, `contacts`, `conversations`, `messages`,
  `channel_sessions`, `channel_session_warmup`, `crm_pipelines`, `crm_stages`, `crm_leads`,
  `crm_lead_activities`, `crm_lead_links`, `orders` (Nuvemshop-origin orders),
  `nuvemshop_products` (mirror of a remote Nuvemshop store — **not** an editable local
  catalog), `catalog_products` (added migration `0204` — the store's **own** sellable catalog,
  see §7), `ai_agents`, `ai_agent_versions`, `ai_agent_runs`, `ai_budgets`, `ai_chunks`,
  `ai_faq_items`, `ai_invocations`, `ai_knowledge_sources`, `ai_knowledge_versions`,
  `ai_models`, `ai_pricing`, `ai_provider_credentials`, `lgpd_requests`,
  `tenant_integrations`, `webhook_events_log`, `storage_redaction_queue`, plus large appendix
  additions: agenda/calendar tables (`calendar_*`), `agent_cases`, `agent_inbox_items`,
  `voice_calls`, `team_invites`, `platform_meta_app`, `platform_branding`, `platform_settings`.
- **Modeling doctrine** (`CLAUDE.md` "Doutrina DIRC" + "Modelagem"):
  - Before adding a field: **D**uplicate (does it belong here)? **I**ntegrate (FK to another
    table)? **R**eference (pointer only)? **C**alculate (derivable on demand)?
  - `type`/vocabulary columns are `text` + `CHECK`, **never** Postgres `enum` (hard to extend)
    — **except** columns that may carry legacy values across clones, which get **no CHECK** at
    all (open vocabulary, constant lives in TypeScript only, e.g.
    `crm_lead_activities.type`, `catalog_products.origem`, `agent_cases.kind`). These columns
    are deliberately excluded from `tests/invariants/vocabulario-banco-x-typescript.test.ts`
    (which only polices columns that *do* have a CHECK).
  - `position_in_stage numeric` for kanban ordering uses **fractional indexing**
    (`midpoint()`), never `int`.
  - Money is always `<field>_cents bigint` + a `currency`/`moeda text` column matching
    `^[A-Z]{3}$` (see `catalog_products` — the migration's own comment calls out
    `nuvemshop_products` lacking a currency column as "the wrong exception, not the pattern").
  - `custom_fields jsonb` uses a declarative schema (`pipeline.settings.fields`) with a Zod
    schema built dynamically, rather than ad hoc JSON reads.
  - `tags text[]` + GIN index; promote to a generated column only once it's a hot path.
- **Every schema change ships as BOTH**: a file in `supabase/migrations/` (source of truth for
  Supabase CLI) **and** an idempotent appended block in `supabase/baseline.sql` (what the
  self-host kit actually applies) **and** a line in `supabase/migrations/MANIFEST.md`. Missing
  the baseline appendix means self-hosters never receive the change even though the migration
  file exists.
- **Function exposure trap:** any new `create function` in `public` is born **exposed** via two
  independent grants — the baseline's blanket `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
  FUNCTIONS TO anon` for anything created after it, and Postgres's own default grant to
  `PUBLIC`. Every new function must end with both
  `revoke execute ... from public, anon;` and an explicit `grant execute ... to <role>;`
  (policed by `tests/invariants/hardening-definer-varredura.test.ts`).

## 4. Authentication

- Supabase Auth via `@supabase/ssr`, cookie `sb-deskcomm-auth`, `SameSite=Strict`, `HttpOnly`,
  `Secure`.
- **Always `getUser()`** on the server (validates JWT against Supabase) — **never
  `getSession()`** (trusts the local cookie unchecked). This is anti-pattern #11 in
  `CLAUDE.md`.
- `lib/auth/require-role.ts` → `requireRole(min, opts)` is the single sanctioned gate: resolves
  the authenticated user, resolves the active org from a trusted cookie (never request body),
  fetches the *effective* role via the `fn_user_role_in_org()` RPC (the same function RLS
  policies use — single source of truth, not a cached snapshot), enforces an MFA-in-session
  check (`mfaEmDivida()`) before granting access, and fires `authz.denied` to the audit log on
  rejection.
- **MFA (TOTP) is optional, admin-configured**, not forced by role. Two independent policies
  sum: `platform_admins.mfa_required` (super-admin) and
  `organizations.settings.security.mfa_required` (tenant admin) — both default **off**. Pure
  logic in `lib/auth/politica-mfa.ts`. Distinct from `mfaEmDivida()`, which asks "did *this*
  session prove the factor it has," independent of the enrollment policy.

## 5. Multi-tenancy

- `organization_id uuid not null references organizations(id) on delete cascade` on **every**
  tenant-aware table — non-negotiable.
- Resolution of the active org is always from a trusted source: session cookie (validated
  against real membership rows), JWT, webhook secret, or path token — **never** the request
  body (anti-pattern #10 in `CLAUDE.md`).
- Every cross-table query inside a tenant-aware flow filters `organization_id` explicitly, even
  under RLS (defense in depth) — critical when the query runs through the service-role admin
  client, which bypasses RLS entirely.
- **CI-enforced isolation tests**: `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts` and
  `tests/invariants/envio-nao-alcanca-conversa-de-outro-tenant.test.ts` spin up two real
  organizations against a real Postgres container (`pgComoSupabase`, connects as `postgres` —
  i.e., with RLS off, simulating the service-role view) and assert the *handler* refuses to
  leak org B's data to org A's actor. This is the pattern any new service-role-backed handler
  or MCP tool must be proven against.
- **Risk on record** (`docs/current-state.md` §5, still architecturally true): 89+ of the
  handlers use `createAdminClient()` (service role); the "filter `organization_id` manually"
  rule has no automated enforcement besides code review + the invariants above — there is no
  lint rule that fails a new handler for skipping the filter.

## 6. Row-Level Security (RLS)

- Every tenant-aware table: `alter table ... enable row level security;` plus a
  `tenant_isolation_<table>_all` (or resource-named) policy built on the helper
  `public.fn_user_org_ids()` — a `security definer stable` SQL function returning the set of
  org IDs the current `auth.uid()` belongs to (plus active-support-session orgs via
  `fn_support_context()`). See definition at `supabase/baseline.sql:18454`.
- Role-gated write policies additionally call `public.fn_role_at_least(organization_id,
  'manager')` (see `catalog_products_write` policy, `supabase/baseline.sql:17284`) —
  the canonical pattern for "read for the whole org, write only for role X+".
- Platform admin bypass is `public.fn_is_platform_admin()`, OR'd into both read and write
  policies.
- **The `ALTER DEFAULT PRIVILEGES` trap**: every Supabase project is born with a default ACL
  granting `anon`/`authenticated`/`service_role` full table privileges in `public`. A brand new
  table is reachable by the `anon` key (which ships to the browser) unless it explicitly does:
  ```sql
  revoke all on public.<table> from anon;
  grant select, insert, update, delete on public.<table> to authenticated;
  grant all on public.<table> to service_role;
  ```
  This is *not* optional boilerplate — migration `0258` is a forward-fix for exactly this gap
  having silently left `api_audit_log` writable via `UPDATE`/`DELETE`/`TRUNCATE` for years.
- Every RLS-bearing table gets `trg_<table>_updated_at` via `public.fn_set_updated_at()`.
- **Extension pattern**: any new tenant-aware table copies the `catalog_products` block
  verbatim in shape — enable RLS → `_select` policy (`fn_user_org_ids()` OR
  `fn_is_platform_admin()`) → `_write` policy (adds `fn_role_at_least()`) → the two-origin
  `revoke`/`grant` block → `updated_at` trigger → `comment on table`. Then prove it with a
  two-tenant invariant test in the style of `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts`.

## 7. CRM

- **5 core tables**: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`
  (polymorphic timeline), `crm_lead_links` (polymorphic relations to other entities).
- **`vocabulary jsonb`** on `crm_pipelines` lets a niche relabel the whole funnel —
  e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado; clinic:
  lead=Paciente, etc. This is the mechanism the product spec's "per-niche configurable
  vocabulary" claim in the prompt maps to.
- **Product catalog already exists, twice, for different reasons — do not collide with
  either:**
  - `nuvemshop_products` — a **read-only mirror** of a remote Nuvemshop store (external source
    of truth); not editable locally.
  - `catalog_products` (migration `0204`, `supabase/baseline.sql:17208`) — the store's **own**
    sellable catalog: `codigo` (SKU, unique per org), `nome`, `descricao`, `marca`,
    `categoria`, `preco_cents` + `moeda`, `custo_cents`, `controla_estoque boolean`,
    `quantidade integer`, `ativo`, `origem` (open vocab: `manual`/`planilha`/`nuvemshop`),
    `imagem_url`. This is a **flat, non-serialized** catalog — one row per SKU, a bare
    integer quantity, no variants, no per-unit identity (no IMEI equivalent). It is what the
    AI agent's `crm_search_products` tool (`lib/mcp/tools/comercio.ts`) reads today, and what
    `app/api/v1/products/route.ts` + `lib/schemas/produtos.ts` (`produtoCreateSchema`) serve to
    the store-management screen. `lib/catalogo/busca.ts` does fuzzy token search (handles
    typos like "ifone"); `lib/catalogo/planilha.ts` handles CSV/spreadsheet import;
    `lib/catalogo/moeda-da-org.ts` resolves org currency (never trust client-supplied currency).
- **Orders**: `orders` table stores Nuvemshop-origin purchase history per contact (`status`,
  `total_cents`, `payment_method`, `fulfillment_status`, `tracking_code`) — read via
  `crm_list_contact_orders` MCP tool. This is not a POS/sales table; it is inbound e-commerce
  order history.
- **Extension pattern**: a new CRM-adjacent entity follows the `crm_*` naming, a polymorphic
  link into `crm_lead_links`/`crm_lead_activities` if it should show up on a lead's timeline,
  and an MCP tool under the appropriate `lib/mcp/tools/catalogo/<domain>.ts` file plus wiring
  into `lib/mcp/tools/index.ts`.

## 8. WhatsApp integration

- **WAHA Plus**, engine NOWEB, fixed default image `devlikeapro/waha:latest-2026.7.2`.
- Client/adapter code in `lib/waha/`; channel abstraction (multi-provider: WAHA, Meta Cloud
  API, WaCalls, Zernio) in `lib/channels/` and `channel_sessions` table (provider-specific
  nullable columns on one shared table, not one table per provider — see `voice_calls`
  migration `0233` comment describing this as "the same pattern as `zernio`/`meta_cloud`").
- Webhooks: HMAC-SHA512 with `crypto.timingSafeEqual`. Anti-ban throttle 1 msg/1.2s + jitter
  ≤800ms, campaign rate 1 msg/5s, warm-up 7-14d, copy spinning, send window 7h-22h (Sunday
  open by default since 2026-08-20, a per-channel knob).
- STOP detection is centralized in `lib/opt-out/deteccao.ts`, used identically by both
  ingestion (`is_blocked=true`) and the agent runtime.
- Media goes to Supabase Storage first (bucket `whatsapp-media`, private, signed URLs) — WAHA
  is only ever given the URL, never inline base64.
- Cron `recover-stuck-messages` marks `status='sending'` >5min as `failed` and opens a
  `agent_inbox_items` warning; it explicitly does not touch `queued` (owned by the agent's own
  retry, `SEND_QUEUED_RETRY_MS`) and never re-sends (double-send is worse than no-send).
- **Not touched by, and should not be touched by, the new retail domain** — the new domain
  reads/writes CRM+AI state but has no reason to alter WAHA/channel code.

### 8.1 Meta Cloud API channel — Datafy BSP swap (read against the actual adapter code)

The user has decided to connect WhatsApp via **Datafy** (`https://app.datafyapi.com.br/docs`),
a Meta-homologated BSP that proxies the Cloud API 1:1 (same endpoint shapes, swap host + token),
instead of Meta Business Manager directly or WAHA. This avoids the Meta App-review/approval
bottleneck entirely. What follows is what the existing Meta Cloud API adapter actually does,
checked line-by-line against `lib/channels/adapters/meta-cloud.ts` and
`lib/channels/meta/webhook.ts` — not assumed from the spec.

**Base URL — hardcoded, not parameterized. Swapping to Datafy needs a small patch, not just an
env var.** `graph.facebook.com` is a **literal string** at all three of the adapter's `fetch`
call sites:
- `send()` — `` `https://graph.facebook.com/${creds.graphVersion}/${creds.phoneNumberId}/messages` `` (`meta-cloud.ts:291`)
- `checkHealth()` — `` `https://graph.facebook.com/${version}/${input.sessionRef}?fields=...` `` (`meta-cloud.ts:154`)
- `fetchInboundMedia()` — media-id lookup at `` `https://graph.facebook.com/${creds.graphVersion}/...` `` (`meta-cloud.ts:208`)

Only the Graph **version** is centralized and env-overridable — `lib/graph-version.ts`'s
`graphVersion()` reads `META_GRAPH_VERSION` with a documented single-source-of-truth rationale
(a dedicated test, `tests/unit/versao-da-graph-num-lugar-so.test.ts`, fails the build if a Graph
version literal appears anywhere else). The **host** has no equivalent — `MetaCredentials`
(`lib/channels/meta/credentials.ts`) carries `phoneNumberId`, `token`, `graphVersion`, `source`,
but no `baseUrl`. Adopting Datafy means: add a `graphBaseUrl()` sibling to `graphVersion()`
(reads a new env var, e.g. `META_GRAPH_BASE_URL`, defaulting to `https://graph.facebook.com`
so nothing changes for installs still on direct Meta access) and replace the three literal
`https://graph.facebook.com` prefixes above with it. Small, mechanical, three call sites — but
it is not a pure config change today; it's a one-file code patch plus a new env var.
`fetchInboundMedia`'s media-download allowlist (`.fbsbx.com`/`.fbcdn.net` host suffix check,
`meta-cloud.ts:238`) is a **separate** concern — that's the CDN host the Graph API's media
lookup *returns* a `url` pointing at, not the API host itself, so it does not need to change for
Datafy unless Datafy's media proxy serves from its own CDN (verify against Datafy's `/media`
docs before assuming the existing allowlist is still correct once media flows through Datafy).

**Token placement — already correct for Datafy.** Every one of the three call sites sends the
token as `Authorization: Bearer ${creds.token}` — there is **no** `?access_token=` query-string
usage anywhere in this adapter. Datafy's requirement ("Bearer header only, rejects query param")
is already satisfied by the existing code; nothing to change here beyond the token *value*
itself becoming a Datafy-issued `sk_live_...` token instead of a Meta system-user token, resolved
through the exact same `resolveMetaCreds()`/`channel_sessions` credential path that already
exists (`lib/channels/meta/credentials.ts`) — no Meta Business Manager app review is needed to
obtain it, per Datafy's dashboard-based connection flow, which directly removes the approval
bottleneck the base system otherwise has no way around.

**Webhook idempotency — two different identifiers, only one of which the codebase already
uses for dedup, and it still works unchanged with Datafy.**
- **Message-content dedup** (the one that matters for correctness) is
  `messages_org_external_id_unique` — `unique(organization_id, external_id)` on the `messages`
  table (`supabase/baseline.sql:2301`, `DEFERRABLE INITIALLY DEFERRED`), where `external_id` is
  the WhatsApp message id (`wamid...`), extracted in `parseMetaWebhook()` from
  `messages[].id` in the payload (`lib/channels/meta/webhook.ts:202`,
  `InboundMessageEvent.externalId`, whose own doc-comment already calls it "a chave de
  idempotência. A Meta re-entrega o que não recebe 2xx"). Because Datafy is payload-compatible
  with Meta, the same `messages[].id` field carries the same wamid through Datafy's proxy, so
  **this dedup mechanism needs zero changes** for the Datafy swap.
- **Delivery-level dedup** (guarding against the same HTTP POST being processed twice, as
  opposed to the same message appearing in two different POSTs) does **not exist today** for
  the Meta webhook route — `app/api/v1/webhooks/meta/[token]/route.ts` never touches
  `webhook_events_log`. That table (schema: `supabase/baseline.sql:1868`, columns include
  `provider`, `external_id`, a `unique(org, provider, event_type, external_id)`-style key) is
  used by the generic webhook-source ingestion route (`app/api/v1/webhooks/in/[token]/route.ts`)
  and by the Nuvemshop LGPD webhooks — **not** by WhatsApp channel webhooks, WAHA or Meta.
  `x-datafy-delivery-id` therefore doesn't need to "slot into" an existing field, because there
  is no existing delivery-level idempotency field for this route to slot into. The user's
  original spec's assumption of a `provider_event_id`-unique-index pattern matches the
  `webhook_events_log` shape used elsewhere in the repo, but that pattern isn't wired to the
  WhatsApp channel routes at all today. **Two honest options, not one obviously-correct one:**
  1. Do nothing new — the existing `wamid`-based dedup on `messages` already prevents the
     customer-visible failure mode (duplicate inbound message rows), and status updates
     (`message_status`) are idempotent `UPDATE`s by `external_id` regardless of redelivery
     count. This is consistent with how the repo already treats the Meta webhook route.
  2. For defense-in-depth parity with the generic webhook path, add `'datafy'` (or `'meta'`) to
     `webhook_events_log.provider`'s CHECK constraint (a small migration) and log each delivery
     keyed by `x-datafy-delivery-id` before processing, skip-and-200 on a repeat. This is more
     work and duplicates protection the `messages` unique constraint already provides for the
     one case (inbound messages) that actually needs it — recommend **option 1** unless a
     concrete Datafy-specific redelivery storm is observed, per the repo's own pattern of not
     building protection against a failure mode that hasn't been measured.

**Signature verification — Datafy needs a new function, cannot reuse `verifyMetaSignature`
as-is.** The existing `verifyMetaSignature()` (`lib/channels/meta/webhook.ts:56`) computes
`HMAC-SHA256(rawBody)` against `META_APP_SECRET` and compares to the `X-Hub-Signature-256:
sha256=<hex>` header. Datafy's scheme signs `{timestamp}.{raw_body}` (not the raw body alone),
delivers the signature in `x-datafy-signature-256`, the timestamp in `x-datafy-timestamp`, and
uses a differently-formatted, differently-scoped secret (`whsec_...`, rotatable in Datafy's
dashboard — not the Meta App Secret, which is an app-level secret shared across every WABA the
app serves; a `whsec_...` is presumably per-webhook-endpoint, worth confirming against Datafy's
dashboard before assuming its scope). This needs a **new, parallel function**
(`verifyDatafySignature(rawBody, timestamp, signatureHeader, secret)`), not a parameter tweak to
the existing one — and it must independently reject a timestamp more than ~300s old (replay
protection Datafy documents but the current Meta verification has no equivalent of, since Meta's
own scheme has no timestamp component to check). Where the secret is stored should follow the
`platform_meta_app` pattern (migration `0257`) — installation-scoped, encrypted with the same
`fn_encrypt_oauth`/`fn_decrypt_oauth` RPCs the rest of the repo uses, never a second bespoke
crypto path (`CLAUDE.md` doctrine referenced throughout `lib/channels/meta/`).

**Rate limits** (Datafy: 500/min sends, 60/min media upload, 60/min everything else, 429 on
excess) are **tighter** than the existing anti-ban throttle the repo already applies to the
*unofficial* WAHA channel (1 msg/1.2s ≈ 50/min steady-state, so WAHA's pacing is well inside
Datafy's 500/min send limit) but the **official/Meta-Cloud-API adapter path currently has no
outbound throttle of its own** — the anti-ban pacing knobs (`lib/agent-engine/pacing/`) are
generic to the channel abstraction, but confirm they're actually applied on the `meta_cloud`
provider (not just `waha`) before assuming Datafy's 500/min is automatically respected; a burst
send (e.g. a campaign) hitting the Cloud-API-style adapter without channel-aware pacing could
plausibly exceed it and start seeing 429s that the adapter's current error handling
(`meta_${code}: ${detail}`) surfaces as a generic send failure rather than a distinguished
"back off and retry" signal — worth a small addition (detect HTTP 429 specifically, honor a
Retry-After-style backoff) rather than treating it as just another `meta_error`.

## 9. AI agents

- **Runtime**: `lib/agent-engine/agent/` — the hot path is `inbound-turn.ts` (flagged in
  `current-state.md` as the largest file in the repo, ~1800 lines — a maintenance risk worth
  knowing about but not touching for this project). Also: `operator-turn.ts` (structured
  "Operator" turn, distinct from the "Conversador" turn), `followup-turn.ts`,
  `draft-reply.ts`/`approved-reply.ts` (human-in-the-loop review), `intent-classifier.ts`,
  `stage-classifier.ts`, `tool-breaker.ts` (circuit breaker for a misbehaving tool),
  `prune-tool-results.ts` (context management), `human-handoff.ts`, `router-config.ts`.
- **Three roles doctrine** (`docs/specs/16-spec-tres-papeis-do-agente.md`): Conversador
  (talks), Operador (acts on CRM state), Segurança (guardrails) — a new domain's tools are
  consumed by the Operador role.
- **Agent lifecycle** (`lib/ai/agents/`): `publish.ts`, `validation.ts`,
  `bloqueio-de-publicacao.test.ts` (publish gate), `escolher-modelo.ts` (model selection, via
  `lib/ai/gateway.ts` → Vercel AI Gateway, strings like `"anthropic/claude-sonnet-4-6"`),
  `capacidades-padrao.ts` (default tool/capability set — **new tools must be added to whatever
  capability allowlist governs which orgs/agents can call them**, since capability grants are
  explicit, not "every tool is on for everyone").
- **Guardrails**: `lib/ai/guardrails/` + `lib/ai/guardrails-schema.ts` — pre-send checklist
  (`lib/ai/guardrails/lista-de-conferencia.ts`). The "never invent stock/price" requirement
  this project must satisfy is **already a working pattern**, not something to invent: see
  `crm_search_products` in `lib/mcp/tools/comercio.ts`, whose `description` field explicitly
  instructs the model "use SEMPRE que a pessoa perguntar preço... nunca com um valor que você
  lembra ou estima" and whose handler returns an explicit `varreduraParcial` (partial-scan)
  flag so the model can distinguish "confirmed absent" from "haven't finished checking" rather
  than guessing. **This exact discipline — tool descriptions that forbid guessing, and
  responses that carry an explicit uncertainty signal instead of silent truncation — is the
  template the new inventory tools must follow.**
- **Extension pattern (new tool)**: add a Zod input shape + `McpToolDefinition` object in a new
  or existing file under `lib/mcp/tools/catalogo/<domain>.ts` or `lib/mcp/tools/<domain>.ts`
  (both patterns exist — `catalog.ts` is the stable metadata-only entry point,
  `lib/mcp/tools/catalogo/` holds the actual per-domain tool catalog files consumed by
  `TOOL_CATALOG`), wire the handler export into `lib/mcp/tools/index.ts`'s `allTools` array,
  and give it a human-facing `rotulo`/`explicacao`/`oQueToca` in the tool catalog (policed by
  `tests/unit/catalogo-tools-leigo-friendly.test.ts` — descriptions must be legible to a
  non-technical shop owner, not just to the model).

## 10. RAG

- `lib/ai/rag/`: `chunker.ts`, `debounce.ts` (Upstash-backed reindex debounce),
  `extractors/`, `ingest/`, `tipos-de-fonte.ts` (source types), `format-product.ts` (formats a
  product row for embedding — **directly relevant**: this is where a richer product/variant
  model would need a corresponding formatter if products are to be RAG-searchable in addition
  to tool-searchable).
- Vector storage: `ai_chunks` table with `pgvector`; `ai_knowledge_sources` /
  `ai_knowledge_versions` track provenance and versioning of what was ingested (materials
  versioned by content, not by agent — see migration `0205` note: "acervo version conta por
  MATERIAL, não por agente").
- Indexing is triggered via `event_log` (`nuvemshop.product_synced`, `knowledge_source.updated`
  → `rag-indexer.handler.ts` → `workers/rag-indexer.ts`), not synchronous writes — new product
  data that should be searchable by RAG (as opposed to just tool-callable) should emit an event
  rather than call the indexer directly.
- **Design note for this project**: the existing `crm_search_products`/`catalog_products` path
  is a **structured tool call**, not RAG — exact price/stock must never be answered from a
  vector-similarity match (a stale or approximate chunk). The new inventory tools should follow
  the same discipline: tool calls for anything transactional (price, stock, IMEI, reservation),
  RAG only for descriptive/marketing knowledge (e.g. product specs prose, repair policy text).

## 11. Memory

- `lib/ai/memoria-da-org.ts` + MCP tools `crmGetOrgMemory`/`crmSaveOrgMemory`
  (`lib/mcp/tools/evolucao.ts`) — a per-organization memory store the agent can read/write
  across conversations (distinct from per-conversation context). This is the flywheel
  mechanism referenced in `VISION.md` ("conversas resolvidas viram conhecimento novo").
- `lib/agent-engine/agent/org-memory.ts` — engine-side counterpart consumed during a turn.
- `lib/agent-engine/agent/lead-notes.ts` / `lead-notes-recall.ts` — per-lead sticky notes the
  agent accumulates and recalls, a narrower/entity-scoped memory distinct from org memory.
- **Extension relevance**: a trade-in evaluation or repair history is exactly the kind of thing
  that could be surfaced through `lead-notes-recall.ts`-style entity memory rather than a fresh
  mechanism — reuse before inventing.

## 12. Tools / function-calling

- Two entry points call the **same** tool definitions with **different trust boundaries**:
  the in-process agent runtime (`lib/ai/runtime/tools.ts`, feeding the LLM tool-use loop
  directly) and the external MCP server (`lib/mcp/server.ts`, for MCP clients like a
  Claude Desktop connection or a partner integration). Both sanitize a known bug class
  identically — `lib/mcp/uuid-de-aterro.ts` / the equivalent in `lib/ai/runtime/tools.ts`
  strips "landfill UUIDs" (placeholder UUIDs the model sometimes hallucinates into optional ID
  fields) before the query runs, because an optional filter on a UUID that doesn't exist
  silently returns empty and gets read by the model as "there is none."
- **Tool contract** (`lib/mcp/types.ts`): `McpToolDefinition<TInput>` = `{ name, description,
  inputSchema (Zod raw shape), category: "read"|"write"|"handoff", requiresRole: Role,
  requiresScope: "mcp:read"|"mcp:write", handler(input, ctx) }`. `ctx: McpContext` carries
  `organizationId, role, actor, apiTokenId, requestId`, and a **service-role** Supabase client
  — **every handler must filter `organization_id` itself**, RLS does not help here.
- **Tool names are a wire contract** — published agents and external MCP clients reference the
  literal `name` string; renaming a published tool breaks integrations. Get the name right
  before publishing a tool, not after (`lib/mcp/tools/catalog.ts` header comment).
- **Two audiences, two texts**: `description` talks to the model (technical, drives tool
  selection); `rotulo`/`explicacao`/`oQueToca` in the catalog talk to the human configuring the
  agent (a shop/clinic owner — no jargon). Both are required.

## 13. MCP

- `app/api/mcp/route.ts` is the single HTTP entry point; `lib/mcp/server.ts` builds an
  `@modelcontextprotocol/sdk` `McpServer`, registers every tool from `lib/mcp/tools/index.ts`'s
  `allTools`, and wraps each call: sanitize landfill UUIDs → `ensureScope()` +
  `ensureRole()` (`lib/mcp/auth.ts`) → call `tool.handler(args, ctx)` → `auditMcpToolCall()`
  (always, success or failure) → return MCP `content[]` (errors become `{isError:true,
  content:[...text]}`, not a JSON-RPC protocol error).
- Auth: Bearer `tok_...` validated against `api_tokens` (plaintext shown once at creation, only
  a SHA-256 hash stored thereafter); `scopes` column enforces `mcp:read`/`mcp:write`.
- Everything a tool touches goes through the **admin (service-role) client** created once per
  request in `createMcpServer` — this is why §12's "filter `organization_id` yourself" rule is
  load-bearing for every tool, new or old, and why `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts`
  exists as the enforcement mechanism instead of RLS.
- ~29 tools registered today across contacts, conversations, leads, pipelines, messages,
  governance/handoff, escalation, evolution/knowledge, commerce (`crm_list_contact_orders`,
  `crm_search_products`), privacy, operations (stages/tags/automation/webhooks/templates),
  agenda/scheduling, and retention/follow-up (`lib/mcp/tools/index.ts`).
- **Extension pattern**: exactly §9's "Extension pattern (new tool)" — this is the same
  registry.

## 14. Follow-ups

- `lib/followup/` (product logic) + `lib/agent-engine/agent/followup-turn.ts`,
  `schedule-followup.ts`, `followup-flow-classify.ts` (engine side) — MCP tools
  `crmScheduleFollowup`, `crmCancelFollowup`, `crmListFollowups`, `crmListAtRiskLeads`,
  `crmCloseDemand`, `crmProposeReactivation` (`lib/mcp/tools/retencao.ts`).
- Adaptive timing lives in a "dossiê" the AI reasons over (migration `0145`: "o dossiê do
  follow-up: tempo escolhido pela IA + pausa manual") plus a fixed DB clock
  (`fn_relogio`/migration `0147`) so scheduling math is deterministic against the database's
  own clock rather than app-server wall time.
- Worker: `workers/` doesn't have a dedicated follow-up handler file per se — it runs through
  the `followup-flow-worker` cron (`app/api/v1/cron/followup-flow-worker` — confirm exact path
  under `app/api/v1/cron/`) draining `event_log`.
- **Not something this project needs to extend** — a trade-in/repair "no news in N days, nudge
  the customer" flow can very plausibly reuse this exact mechanism rather than building a new
  one (see `IMPLEMENTATION_PLAN.md` risk notes).

## 15. Queues / workers

- **`event_log`** (schema in §3) is the internal bus. Doctrine (`docs/specs/07`): Postgres
  triggers **never** do HTTP — a trigger only ever `insert into event_log`; a worker (cron
  pull-loop or Realtime listener) does the side effect outside the transaction. This is
  anti-pattern #9 in `CLAUDE.md`, called "letal" — waiting on network inside a transaction.
  Event type format is enforced by a CHECK regex `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
  (`entity.action` snake_case, e.g. `lead.stage_changed`).
- **Claim pattern**: `FOR UPDATE SKIP LOCKED` pull-loop with per-org fairness (migration
  `0146`, "claim justo entre organizações" — the claim query pulls a bounded batch per org so
  one noisy tenant can't starve the others). Idempotency for external events:
  `unique(organization_id, external_id)` + catching Postgres error `23505` on insert.
- **Concurrency-safe single-writer sections** (directly relevant to POS/reservation in Phase 2)
  use `pg_advisory_xact_lock(hashtextextended(<key>, <namespace_int>))` inside the function
  body, scoped to a transaction — used repeatedly for "only one of these can happen at a time
  for this key" invariants: channel routing reservation (migration `0228`,
  `hashtextextended(p_org||':'||p_user, 228)`), lead-from-conversation dedup (migration `0256`,
  keyed by org+contact), tenant creation dedup (migration `0231`/`0219`/`0221`, keyed by
  actor+idempotency-key). **This is the pattern to reuse for "reserve one physical IMEI unit
  for a sale without a race"** — no new mechanism needed.
- **Workers directory** (`workers/`): `agent-worker/`, `ai-response-worker`,
  `ai-sentiment-worker`, `ai-handoff-from-sentiment`, `rag-indexer`, `media-persist-worker`,
  `media-derive-worker`, `lgpd-export-worker`, `lgpd-redact-worker`, `storage-cleanup-worker`.
  Each has a thin `*.handler.ts` adapter (declares `key` + `events: [...]` + `handle`) plus the
  actual `*.ts` pipeline — the adapter/pipeline split exists so unit tests can import the
  pipeline directly without pulling in the dispatcher registry.
- **Crons** (`app/api/v1/cron/`, 24 endpoints today, Bearer `INTERNAL_CRON_SECRET`,
  fail-closed, scheduled by the `scheduler` service's `crond` in `docker-compose.prod.yml` —
  **not** Vercel Cron; per `current-state.md` §5.6 there is no `vercel.json`, so any assumption
  that "the cron runs" only holds for the VPS deployment). Includes `event-log-drain` (the
  generic dispatcher), `agent-dispatcher`, `followup-flow-worker`, `recover-stuck-messages`,
  `data-retention`, and domain-specific watchers (`case-stale-watcher`, `risk-watcher`,
  `snooze-watcher`, etc).
- **Extension pattern**: new async side-effect → emit an `entity.action` event from the
  mutating handler/trigger → register a handler (`key` + `events` + `handle`) → wire it into
  the dispatcher registry consumed by `event-log-drain` → if a genuinely new recurring sweep is
  needed (not event-driven), add a cron under `app/api/v1/cron/<name>/route.ts` and register it
  in the scheduler's crontab generation.
- **Audit nuance**: a cron run that did nothing must **not** write an audit row; a cron run
  that had an effect **must**. This is enforced by AST-scanning every route under
  `app/api/v1/cron/` (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`) — get this wrong
  and a quiet install generates tens of thousands of no-op audit rows/month.

## 16. Storage

- Supabase Storage, bucket `whatsapp-media`, private, signed URLs only.
- `lib/media/` (implied — media persistence/derivation workers exist) handles inbound
  attachments: `media-persist-worker` uploads to Storage, `media-derive-worker` generates
  derivatives (thumbnails, transcodes — `ffmpeg` is baked into the app image, `Dockerfile:55`).
- `storage-cleanup-worker` + `storage_redaction_queue` table implement scheduled deletion for
  LGPD redact cascades (media removed from Storage as part of contact anonymization).
- **Quota note relevant to a Brazilian self-host operator**: `docs/runbooks/custo-e-cota-do-supabase.md`
  documents that a self-host client's entire Storage quota (1 GB on the smallest tier) is
  **shared** between `whatsapp-media` and anything else stored there — a future feature that
  stores product photos or IMEI-box photos competes for the same quota and should be sized
  with that in mind.

## 17. Tests

- `pnpm typecheck` (`tsc --noEmit -p tsconfig.typecheck.json`), `pnpm lint` (`eslint .`),
  `pnpm test:unit` (`vitest run`, **no path** — reaches co-located tests across
  `lib/`/`app/`/`components/`/`hooks/`, not just `tests/unit/`; 566 files as last measured),
  `pnpm test:db` (`scripts/test-db.sh` — spins up `pgvector/pgvector:pg15` **as the declared
  floor**, applies `baseline.sql` in install mode (`ON_ERROR_STOP=1`) then update mode
  (idempotency check), runs `tests/invariants/**` — includes the 2-org RLS isolation tests),
  `pnpm test:e2e` (Playwright, needs a dev server), `pnpm test:shell` (packaging/kit shell
  scripts).
- **`tests/invariants/**` is explicitly excluded from `vitest.config.ts`** — it needs a real
  Postgres and only runs via `vitest.db.config.ts`/`scripts/test-db.sh`. Running only
  `pnpm test:unit` and calling it "green" is a **false green** for anything touching
  schema/RLS — this is called out explicitly in `CLAUDE.md` and repeated in the DoD.
- **`pnpm gov:verify`** (`typecheck && lint && lint:channels && lint:role-rank && test:unit`)
  is **not** full coverage — it omits `test:db` and `test:e2e` entirely.
- **5 required CI status checks** on `main` (as configured, not just documented — verify with
  `gh api repos/.../branches/main/protection`): `verify`, `invariants` (`test:db`),
  `build-and-size` (`pnpm build` on Node 22), `e2e` (Playwright, all specs except those listed
  in the `FORA_DO_CI` YAML variable — currently `vps-fresh-onboarding` is the one everyone
  cares about, since it's the P0 fresh-install journey and it stays out of CI because it needs
  WAHA+Redis+Resend+Nuvemshop on the runner), `imagens-ok` (all 3 Docker images build).
- **QA Visual doctrine**: any UI/user-flow change must be proven by actually driving a browser
  (Playwright) against a **fresh, VPS-like** environment (`baseline.sql` applied to a clean
  pg15, `next build && next start`, optional envs *absent*) — curl/API calls don't count as
  proof of UX. Evidence goes in `.superpowers/evidence/` and `docs/testing/user-journey-map.md`
  is the living index of journeys/priority/findings.

## 18. Deployment

- **Docker images**: `Dockerfile` (app), `Dockerfile.worker`, `Dockerfile.scheduler` — all
  three are **published by CI**, never built on a client VPS (`imagens-ok` CI job enforces this
  for all three; historically the `worker` service had no `image:` for two months and silently
  never received updates on any installed VPS — `current-state.md` §4.0, now fixed).
  `docker-compose.prod.yml` + `docker-compose.traefik.yml` are both required on any `up -d` on
  a VPS with its own reverse proxy — omitting `-f docker-compose.traefik.yml` silently drops
  routing labels and the whole domain 404s while the container reports healthy.
  `hostgator-setup-kit/` is the 1-command installer (`install.sh`, `update.sh`, `backup.sh`,
  `reset-mfa.sh`).
- **Version pinning discipline**: client installs point at a version number, never a moving
  tag; upstream deps (WAHA, Redis, Caddy, `serverless-redis-http`) are referenced by fixed tag,
  never republished (WAHA is licensed — republishing is a legal liability).
- **A bump must never require the VPS operator to hand-edit `.env`/compose** — if it would,
  it's not a patch, it needs a migration plan and becomes a major version.
- Standard flow: commit → push → PR → merge to `main` → CI publishes to GHCR → the VPS pulls.
  Building on the VPS itself is an emergency-only escape hatch and counts as tech debt.

## 19. Observability

- **Sentry** (`sentry.{server,edge}.config.ts`, `instrumentation{,-client}.ts`) with a
  `beforeSend` that scrubs PII (CPF/email/phone) and sensitive headers before anything leaves
  the process.
- **`api_audit_log`** is the structured business-event trail (§"Multi-tenancy"/"RLS" above for
  its hardening) — append-only, fire-and-forget on write, failure surfaces as a Sentry alert
  rather than blocking the mutation. Retention default 5 years, configurable via
  `AUDIT_LOG_RETENTION_DAYS`, actually executed by `fn_expurgar_auditoria_vencida` (a
  `security definer` with a **90-day floor hard-coded in the function body**, not just in
  config) via the `data-retention` cron.
- **`X-Request-Id`** on every response, injected in `proxy.ts`, correlates a request across
  API response → audit log row → Sentry event.
- **Structured logger** — `lib/logger.ts`; `console.log` outside it is a lint-policed
  anti-pattern (DoD item 8; measured at 0 occurrences as of the last audit).
- Gaps on record (still architecturally relevant): HTTP rate limiting via Upstash Redis
  (`lib/ai/dispatcher/rate-limit.ts`) is wired at only 2 call sites today (capture webhook, AI
  dispatcher) — most of `/api/v1/*` has no rate limit; a fixed-window (`INCR`+`EXPIRE`)
  counter, not sliding window, with a silent in-memory fallback (`logger.warn` only) when
  Upstash env vars are absent.

---

## Appendix: files worth opening first if extending this system

| Purpose | File |
|---|---|
| Response envelope | `lib/api/wrappers.ts` |
| Error codes | `lib/api/errors.ts` |
| Role gate | `lib/auth/require-role.ts` |
| RLS helper functions | `supabase/baseline.sql:18454` (`fn_user_org_ids`), search `fn_role_at_least`, `fn_is_platform_admin` |
| Audit writer | `lib/audit/index.ts`, action enum `lib/audit/actions.ts` |
| MCP tool contract | `lib/mcp/types.ts` |
| MCP tool registry | `lib/mcp/tools/index.ts` |
| Example rich MCP tool (search-with-uncertainty pattern) | `lib/mcp/tools/comercio.ts` |
| Existing generic product catalog (flat, non-serialized) | `supabase/baseline.sql:17208` (`catalog_products`), `app/api/v1/products/route.ts`, `lib/schemas/produtos.ts`, `lib/catalogo/busca.ts` |
| Event bus doctrine | `docs/specs/07-spec-events-workers.md` |
| Event table + example worker adapter | `supabase/baseline.sql:1522`, `workers/rag-indexer.handler.ts` |
| Advisory-lock reservation pattern | `supabase/migrations/20260907040000_0228_roteamento_por_canal_e_reservas.sql` |
| Navigation single source of truth | `lib/navigation/catalogo.ts` |
| Non-negotiable doctrine | `CLAUDE.md` (read first, in full) |
| Migration manifest / numbering | `supabase/migrations/MANIFEST.md` |
