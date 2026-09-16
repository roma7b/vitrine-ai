import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * VAREJO MÓVEL — ISOLAMENTO RLS ENTRE DOIS TENANTS, NAS 15 TABELAS NOVAS.
 *
 * ═══ Por que este arquivo, e não uma extensão de `rls-isolation.test.ts` ═══
 *
 * Aquele arquivo tem seu próprio aviso, no cabeçalho: `TABLES` é uma LISTA
 * FIXA que precisa ganhar uma linha por tabela tenant-aware nova, NO MESMO
 * COMMIT da migration — senão a tabela nova passa verde sem prova de
 * isolamento. `tests/invariants/**` é CONGELADO por doutrina (adicione, não
 * edite/delete — `tests/invariants/README.md`), então em vez de editar
 * aquele arquivo (que É editável — é o padrão do repo acrescentar linha ali
 * — mas o seed daquele arquivo é grande e as 15 tabelas novas têm uma cadeia
 * de FK própria, `products → variants → units → …`, que não cabe bem no
 * `do $seed$` genérico de lá sem inflar o arquivo alheio), este arquivo
 * próprio faz a MESMA prova (`countAs`, JWT `authenticated` simulado, mesmo
 * caminho de produção) com seed dedicado à cadeia do domínio de varejo.
 *
 * ═══ O que é medido, e o que NÃO é ═══
 *
 * Comportamento (RLS de verdade, via `set role authenticated` + `request.jwt.claims`,
 * NÃO inspeção de catálogo — uma policy `... or true` passaria numa inspeção
 * de `pg_policy` e vazaria o vizinho aqui). NÃO mede o piso de PAPEL por
 * tabela (agent vs. manager) — o usuário semeado aqui é `manager` nas duas
 * organizações, que satisfai os dois pisos (`fn_role_at_least`: manager=3 >=
 * agent=2), de propósito: o eixo que este arquivo mede é só "o vizinho não
 * vaza", não "quem pode escrever o quê". Esse segundo eixo, quando precisar
 * de prova própria por tabela, ganha arquivo dedicado — mesmo padrão de
 * `catalogo-so-gestor-muda-preco.test.ts` para `catalog_products`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/**
 * Roda SELECTs como o papel `authenticated` com o JWT do usuário dado —
 * exatamente como o PostgREST/Supabase fazem: papel de sessão + `request.jwt.claims`.
 */
function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

// UUIDs próprios (prefixo "eeee...") — os arquivos de invariante compartilham
// a mesma base de Postgres, então cada arquivo usa seu próprio namespace.
const ORG_A = "eeeeeeee-0000-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-0000-4000-8000-00000000000b";
const USER_A = "eeeeeeee-1111-4000-8000-00000000000a";
const USER_B = "eeeeeeee-1111-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'retail-rls-a@invariant.test'),
      ('${USER_B}', 'retail-rls-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'retail-rls-a', 'Retail RLS Invariant A', 'Retail RLS A'),
      ('${ORG_B}', 'retail-rls-b', 'Retail RLS Invariant B', 'Retail RLS B')
      on conflict (id) do nothing;

    -- 'manager' satisfaz os dois pisos de escrita do domínio (agent+ e
    -- manager+, fn_role_at_least: manager=3 >= agent=2) — este arquivo mede
    -- isolamento entre tenants, não o piso de papel por tabela.
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'manager', now()),
      ('${USER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    do $seed$
    declare
      v_org uuid;
      v_product uuid;
      v_variant uuid;
      v_supplier uuid;
      v_purchase uuid;
      v_purchase_item uuid;
      v_unit uuid;
      v_sale uuid;
      v_sale_item uuid;
      v_payment uuid;
      v_trade_in uuid;
      v_repair_order uuid;
      v_tag text;
    begin
      foreach v_org in array array['${ORG_A}'::uuid, '${ORG_B}'::uuid] loop
        v_tag := replace(v_org::text, '-', '');

        if not exists (select 1 from public.retail_products where organization_id = v_org) then
          insert into public.retail_products (organization_id, name, brand, category)
            values (v_org, 'RLS Invariant iPhone', 'Apple', 'smartphone')
            returning id into v_product;
        else
          select id into v_product from public.retail_products where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_product_variants where organization_id = v_org) then
          insert into public.retail_product_variants
            (organization_id, product_id, sku, storage_gb, color, list_price_cents)
            values (v_org, v_product, 'RLS-SKU-' || v_tag, 128, 'Preto', 500000)
            returning id into v_variant;
        else
          select id into v_variant from public.retail_product_variants where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_suppliers where organization_id = v_org) then
          insert into public.retail_suppliers (organization_id, name, document)
            values (v_org, 'Fornecedor Invariante', '00000000000191')
            returning id into v_supplier;
        else
          select id into v_supplier from public.retail_suppliers where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_purchases where organization_id = v_org) then
          insert into public.retail_purchases
            (organization_id, supplier_id, purchase_date, total_cost_cents, status)
            values (v_org, v_supplier, current_date, 300000, 'received')
            returning id into v_purchase;
        else
          select id into v_purchase from public.retail_purchases where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_purchase_items where organization_id = v_org) then
          insert into public.retail_purchase_items
            (organization_id, purchase_id, variant_id, quantity, unit_cost_cents)
            values (v_org, v_purchase, v_variant, 1, 300000)
            returning id into v_purchase_item;
        else
          select id into v_purchase_item from public.retail_purchase_items where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_inventory_units where organization_id = v_org) then
          insert into public.retail_inventory_units
            (organization_id, variant_id, imei, cost_cents, status, supplier_id, purchase_item_id)
            values (v_org, v_variant, '35' || lpad(v_tag, 13, '0'), 300000, 'IN_STOCK', v_supplier, v_purchase_item)
            returning id into v_unit;
        else
          select id into v_unit from public.retail_inventory_units where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_inventory_movements where organization_id = v_org) then
          insert into public.retail_inventory_movements
            (organization_id, unit_id, from_status, to_status, reason, actor_type, related_purchase_id)
            values (v_org, v_unit, null, 'RECEIVING', 'received', 'system', v_purchase);
        end if;

        if not exists (select 1 from public.retail_sales where organization_id = v_org) then
          insert into public.retail_sales (organization_id, status, subtotal_cents, total_cents)
            values (v_org, 'draft', 500000, 500000)
            returning id into v_sale;
        else
          select id into v_sale from public.retail_sales where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_sale_items where organization_id = v_org) then
          insert into public.retail_sale_items
            (organization_id, sale_id, inventory_unit_id, description, unit_price_cents, quantity, line_total_cents)
            values (v_org, v_sale, v_unit, 'RLS invariant sale item', 500000, 1, 500000)
            returning id into v_sale_item;
        else
          select id into v_sale_item from public.retail_sale_items where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_payments where organization_id = v_org) then
          insert into public.retail_payments (organization_id, sale_id, method, amount_cents, status)
            values (v_org, v_sale, 'pix', 500000, 'confirmed')
            returning id into v_payment;
        else
          select id into v_payment from public.retail_payments where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_installments where organization_id = v_org) then
          insert into public.retail_installments
            (organization_id, payment_id, installment_number, due_date, amount_cents, status)
            values (v_org, v_payment, 1, current_date, 500000, 'paid');
        end if;

        if not exists (select 1 from public.retail_trade_ins where organization_id = v_org) then
          insert into public.retail_trade_ins (organization_id, status, offer_amount_cents)
            values (v_org, 'requested', 100000)
            returning id into v_trade_in;
        else
          select id into v_trade_in from public.retail_trade_ins where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_trade_in_evaluations where organization_id = v_org) then
          insert into public.retail_trade_in_evaluations
            (organization_id, trade_in_id, claimed_model, evaluation_method, calculated_offer_cents)
            values (v_org, v_trade_in, 'iPhone 12', 'ai_estimate', 90000);
        end if;

        if not exists (select 1 from public.retail_repair_orders where organization_id = v_org) then
          insert into public.retail_repair_orders (organization_id, issue_description, status)
            values (v_org, 'Tela trincada (invariante)', 'received')
            returning id into v_repair_order;
        else
          select id into v_repair_order from public.retail_repair_orders where organization_id = v_org limit 1;
        end if;

        if not exists (select 1 from public.retail_warranties where organization_id = v_org) then
          insert into public.retail_warranties
            (organization_id, inventory_unit_id, warranty_type, starts_at, expires_at, status)
            values (v_org, v_unit, 'store', current_date, current_date + interval '90 days', 'active');
        end if;
      end loop;
    end
    $seed$;
  `);
});

/**
 * As 15 tabelas de `MOBILE_RETAIL_DOMAIN.md` §2. Uma linha por tabela — sem
 * varredura genérica (o mesmo aviso de `rls-isolation.test.ts`: catálogo não
 * prova comportamento, só o JWT simulado prova).
 */
export const RETAIL_TABLES = [
  "retail_products",
  "retail_product_variants",
  "retail_suppliers",
  "retail_purchases",
  "retail_purchase_items",
  "retail_inventory_units",
  "retail_inventory_movements",
  "retail_sales",
  "retail_sale_items",
  "retail_payments",
  "retail_installments",
  "retail_trade_ins",
  "retail_trade_in_evaluations",
  "retail_repair_orders",
  "retail_warranties",
] as const;

describe("varejo móvel — isolamento RLS entre organizações (fn_user_org_ids)", () => {
  it("o cenário está montado — sem isto, os casos abaixo medem o vazio", () => {
    const unidadesDeB = Number(
      sql(
        `select count(*) from public.retail_inventory_units where organization_id = '${ORG_B}';`,
      ),
    );
    expect(unidadesDeB).toBeGreaterThan(0);
  });

  for (const table of RETAIL_TABLES) {
    it(`usuário da org A lê ZERO linhas de ${table} da org B`, () => {
      const cruzado = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_B}';`,
      );
      expect(cruzado).toBe(0);
    });

    it(`usuário da org A ainda lê a própria linha de ${table} (controle positivo)`, () => {
      const proprias = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_A}';`,
      );
      expect(proprias).toBeGreaterThanOrEqual(1);
    });
  }

  it("superuser vê as duas orgs (sanidade do seed: as linhas cruzadas existem de verdade)", () => {
    const total = Number(
      sql(
        `select count(distinct organization_id) from public.retail_inventory_units
          where organization_id in ('${ORG_A}','${ORG_B}');`,
      ),
    );
    expect(total).toBe(2);
  });

  it("a anon key não alcança nenhuma das 15 tabelas — o revoke, não só a policy", () => {
    // ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon do baseline
    // alcança toda tabela nova. Sem o revoke explícito em cada migration, o
    // domínio inteiro fica legível pela anon key que vai para o browser.
    for (const table of RETAIL_TABLES) {
      const grants = sql(`
        select count(*) from information_schema.role_table_grants
         where table_schema = 'public' and table_name = '${table}' and grantee = 'anon';
      `);
      expect(grants, `anon tem grant em ${table}`).toBe("0");
    }
  });
});
