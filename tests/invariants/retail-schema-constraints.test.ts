import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * VAREJO MÓVEL — CONSTRAINTS DE FORMA (either/or e IMEI), medidas no BANCO.
 *
 * ═══ O que este arquivo prova, e por quê medir aqui e não só ler o SQL ═══
 *
 * `MOBILE_RETAIL_DOMAIN.md` §2 pede duas disciplinas de dado que só um INSERT
 * de verdade prova:
 *
 *  1. **Either/or por CHECK** em `retail_sale_items`
 *     (`inventory_unit_id`/`catalog_product_id`) e `retail_warranties`
 *     (`inventory_unit_id`/`repair_order_id`) — exatamente um dos dois, nunca
 *     os dois, nunca nenhum. Ler a migration e confirmar que o `check
 *     (num_nonnulls(...) = 1)` está lá NÃO prova que ele bloqueia — um typo no
 *     nome da coluna dentro do CHECK compilaria e nunca dispararia.
 *
 *  2. **Índice único PARCIAL de IMEI** em `retail_inventory_units` — duas
 *     unidades em `RECEIVING` com `imei = null` não podem colidir (índice
 *     parcial `where imei is not null` tem que tolerar N nulos), mas duas
 *     unidades com o MESMO IMEI não nulo na mesma organização têm que ser
 *     rejeitadas. E o CHECK companheiro — status diferente de `RECEIVING`
 *     exige IMEI — tem que barrar a promoção sem IMEI.
 *
 * Conecta como `postgres` (bypassa RLS) porque o que está sob teste é
 * CONSTRAINT de tabela, não RLS — `rls-isolation`/`retail-rls-isolation`
 * já cobrem o eixo de tenant.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 5,
});

const ORG = "ffffffff-0000-4000-8000-000000000001";
let productId = "";
let variantId = "";
let existingUnitId = "";
let saleId = "";
let repairOrderId = "";

interface PgError {
  code?: string;
  message: string;
}

/** Roda o INSERT e devolve o código de erro Postgres, ou null se deu certo. */
async function codigoDeErro(query: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(query, params);
    return null;
  } catch (e) {
    const err = e as PgError;
    return err.code ?? "unknown";
  }
}

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'retail-constraints-inv', 'Retail Constraints Invariant', 'Retail Constraints')
     on conflict (id) do nothing`,
    [ORG],
  );

  const { rows: p } = await pool.query<{ id: string }>(
    `insert into public.retail_products (organization_id, name)
     values ($1, 'Constraint Invariant iPhone') returning id`,
    [ORG],
  );
  productId = p[0]!.id;

  const { rows: v } = await pool.query<{ id: string }>(
    `insert into public.retail_product_variants (organization_id, product_id, sku, list_price_cents)
     values ($1, $2, 'CONSTRAINT-INV-SKU', 500000) returning id`,
    [ORG, productId],
  );
  variantId = v[0]!.id;

  // Uma unidade IN_STOCK de verdade, para os casos positivos do either/or.
  const { rows: u } = await pool.query<{ id: string }>(
    `insert into public.retail_inventory_units
       (organization_id, variant_id, imei, cost_cents, status)
     values ($1, $2, '359999000000001', 300000, 'IN_STOCK') returning id`,
    [ORG, variantId],
  );
  existingUnitId = u[0]!.id;

  const { rows: s } = await pool.query<{ id: string }>(
    `insert into public.retail_sales (organization_id, status)
     values ($1, 'draft') returning id`,
    [ORG],
  );
  saleId = s[0]!.id;

  const { rows: r } = await pool.query<{ id: string }>(
    `insert into public.retail_repair_orders (organization_id, issue_description, status)
     values ($1, 'Constraint invariant issue', 'received') returning id`,
    [ORG],
  );
  repairOrderId = r[0]!.id;
});

afterAll(async () => {
  await pool.query("delete from public.organizations where id = $1", [ORG]);
  await pool.end();
});

describe("retail_sale_items — either/or (inventory_unit_id XOR catalog_product_id)", () => {
  it("os dois NULOS é rejeitado", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_sale_items
         (organization_id, sale_id, description, unit_price_cents, line_total_cents)
       values ($1, $2, 'sem produto', 100, 100)`,
      [ORG, saleId],
    );
    expect(codigo).toBe("23514"); // check_violation
  });

  it("os dois PREENCHIDOS é rejeitado", async () => {
    // Precisa de um catalog_products válido para isolar a violação no CHECK
    // either/or, não numa FK ausente.
    const { rows: cp } = await pool.query<{ id: string }>(
      `insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
       values ($1, 'CONSTRAINT-INV-ACC', 'Capinha invariante', 5000) returning id`,
      [ORG],
    );
    const codigo = await codigoDeErro(
      `insert into public.retail_sale_items
         (organization_id, sale_id, inventory_unit_id, catalog_product_id, description, unit_price_cents, line_total_cents)
       values ($1, $2, $3, $4, 'os dois', 100, 100)`,
      [ORG, saleId, existingUnitId, cp[0]!.id],
    );
    expect(codigo).toBe("23514");
  });

  it("exatamente inventory_unit_id (controle positivo, lado unidade serializada)", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_sale_items
         (organization_id, sale_id, inventory_unit_id, description, unit_price_cents, quantity, line_total_cents)
       values ($1, $2, $3, 'aparelho', 500000, 1, 500000)`,
      [ORG, saleId, existingUnitId],
    );
    expect(codigo).toBeNull();
  });

  it("exatamente catalog_product_id (controle positivo, lado acessório)", async () => {
    const { rows: cp } = await pool.query<{ id: string }>(
      `insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
       values ($1, 'CONSTRAINT-INV-ACC2', 'Capinha invariante 2', 4000) returning id`,
      [ORG],
    );
    const codigo = await codigoDeErro(
      `insert into public.retail_sale_items
         (organization_id, sale_id, catalog_product_id, description, unit_price_cents, quantity, line_total_cents)
       values ($1, $2, $3, 'capinha', 4000, 2, 8000)`,
      [ORG, saleId, cp[0]!.id],
    );
    expect(codigo).toBeNull();
  });

  it("unidade serializada com quantity != 1 é rejeitada (IMEI não é 'quantidade 3')", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_sale_items
         (organization_id, sale_id, inventory_unit_id, description, unit_price_cents, quantity, line_total_cents)
       values ($1, $2, $3, 'aparelho em dobro', 500000, 3, 1500000)`,
      [ORG, saleId, existingUnitId],
    );
    expect(codigo).toBe("23514");
  });
});

describe("retail_warranties — either/or (inventory_unit_id XOR repair_order_id)", () => {
  it("os dois NULOS é rejeitado", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_warranties
         (organization_id, warranty_type, starts_at, expires_at)
       values ($1, 'store', current_date, current_date + interval '30 days')`,
      [ORG],
    );
    expect(codigo).toBe("23514");
  });

  it("os dois PREENCHIDOS é rejeitado", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_warranties
         (organization_id, inventory_unit_id, repair_order_id, warranty_type, starts_at, expires_at)
       values ($1, $2, $3, 'store', current_date, current_date + interval '30 days')`,
      [ORG, existingUnitId, repairOrderId],
    );
    expect(codigo).toBe("23514");
  });

  it("exatamente inventory_unit_id (controle positivo)", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_warranties
         (organization_id, inventory_unit_id, warranty_type, starts_at, expires_at)
       values ($1, $2, 'manufacturer', current_date, current_date + interval '365 days')`,
      [ORG, existingUnitId],
    );
    expect(codigo).toBeNull();
  });

  it("exatamente repair_order_id (controle positivo)", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_warranties
         (organization_id, repair_order_id, warranty_type, starts_at, expires_at)
       values ($1, $2, 'store', current_date, current_date + interval '90 days')`,
      [ORG, repairOrderId],
    );
    expect(codigo).toBeNull();
  });
});

describe("retail_inventory_units — IMEI parcial-único e CHECK de recebimento", () => {
  it("duas unidades RECEIVING com imei = null NÃO colidem", async () => {
    const primeira = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, cost_cents, status)
       values ($1, $2, 100000, 'RECEIVING')`,
      [ORG, variantId],
    );
    const segunda = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, cost_cents, status)
       values ($1, $2, 100000, 'RECEIVING')`,
      [ORG, variantId],
    );
    expect(primeira).toBeNull();
    expect(segunda).toBeNull();
  });

  it("duas unidades com o MESMO imei não nulo na mesma org são rejeitadas", async () => {
    const primeira = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, imei, cost_cents, status)
       values ($1, $2, '351122000000099', 200000, 'IN_STOCK')`,
      [ORG, variantId],
    );
    const segunda = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, imei, cost_cents, status)
       values ($1, $2, '351122000000099', 200000, 'IN_STOCK')`,
      [ORG, variantId],
    );
    expect(primeira).toBeNull();
    expect(segunda).toBe("23505"); // unique_violation
  });

  it("o MESMO imei em organizações DIFERENTES não colide (unique é por organização)", async () => {
    const outraOrg = "ffffffff-0000-4000-8000-000000000002";
    await pool.query(
      `insert into public.organizations (id, slug, legal_name, display_name)
       values ($1, 'retail-constraints-inv-2', 'Retail Constraints Invariant 2', 'Retail Constraints 2')
       on conflict (id) do nothing`,
      [outraOrg],
    );
    const { rows: p2 } = await pool.query<{ id: string }>(
      `insert into public.retail_products (organization_id, name) values ($1, 'Produto outra org') returning id`,
      [outraOrg],
    );
    const { rows: v2 } = await pool.query<{ id: string }>(
      `insert into public.retail_product_variants (organization_id, product_id, sku)
       values ($1, $2, 'CONSTRAINT-INV-SKU-2') returning id`,
      [outraOrg, p2[0]!.id],
    );
    const codigo = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, imei, cost_cents, status)
       values ($1, $2, '351122000000099', 200000, 'IN_STOCK')`,
      [outraOrg, v2[0]!.id],
    );
    expect(codigo).toBeNull();
    await pool.query("delete from public.organizations where id = $1", [outraOrg]);
  });

  it("status diferente de RECEIVING sem imei é rejeitado pelo CHECK", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, cost_cents, status)
       values ($1, $2, 100000, 'INSPECTION')`,
      [ORG, variantId],
    );
    expect(codigo).toBe("23514");
  });

  it("IN_STOCK COM imei é aceito (controle positivo do CHECK acima)", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, imei, cost_cents, status)
       values ($1, $2, '351122000000123', 100000, 'IN_STOCK')`,
      [ORG, variantId],
    );
    expect(codigo).toBeNull();
  });

  it("status fora do vocabulário fechado é rejeitado", async () => {
    const codigo = await codigoDeErro(
      `insert into public.retail_inventory_units
         (organization_id, variant_id, imei, cost_cents, status)
       values ($1, $2, '351122000000124', 100000, 'TRADED_IN')`,
      [ORG, variantId],
    );
    // 'TRADED_IN' não é status — é is_trade_in_origin (decisão da Fase 1).
    expect(codigo).toBe("23514");
  });
});
