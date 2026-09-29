import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DA_RETAIL_UNIT, type RetailInventoryUnit } from "@/lib/schemas/retail-inventory";
import { createClient } from "@/lib/supabase/server";

import { RetailEstoqueClient, type VarianteComProduto } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Estoque (varejo)" };

/**
 * Cada aparelho físico por IMEI. "Quanto há em estoque" é sempre
 * `count(*) where status = 'IN_STOCK'` (MOBILE_RETAIL_DOMAIN.md §2) — esta
 * tela lista as linhas cruas, não um contador derivado em outro lugar.
 *
 * `agent` já opera o dia a dia (receber, inspecionar, entregar — §5); cadastro
 * de fornecedor/SKU segue exigindo `manager`, então o botão "Receber estoque"
 * fica condicionado a `podeReceber` = agent, e o de criar SKU/fornecedor a
 * `podeCadastrar` = manager.
 */
export default async function RetailEstoquePage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeReceber = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  const supabase = await createClient();
  const [{ data: unidades }, { data: variantes }, { data: fornecedores }] = await Promise.all([
    supabase
      .from("retail_inventory_units")
      .select(COLUNAS_DA_RETAIL_UNIT)
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("retail_product_variants")
      .select("id, sku, storage_gb, color, retail_products(name)")
      .eq("organization_id", activeOrg.orgId)
      .order("sku"),
    supabase
      .from("retail_suppliers")
      .select("id, name")
      .eq("organization_id", activeOrg.orgId)
      .eq("active", true)
      .order("name"),
  ]);

  const variantesComProduto: VarianteComProduto[] = (variantes ?? []).map((v) => {
    const row = v as unknown as {
      id: string;
      sku: string;
      storage_gb: number | null;
      color: string | null;
      retail_products: { name: string } | { name: string }[] | null;
    };
    const produto = Array.isArray(row.retail_products) ? row.retail_products[0] : row.retail_products;
    return {
      id: row.id,
      sku: row.sku,
      storage_gb: row.storage_gb,
      color: row.color,
      produtoNome: produto?.name ?? "—",
    };
  });

  return (
    <RetailEstoqueClient
      inicial={(unidades ?? []) as unknown as RetailInventoryUnit[]}
      variantes={variantesComProduto}
      fornecedores={(fornecedores ?? []) as { id: string; name: string }[]}
      podeReceber={podeReceber}
      textos={{
        titulo: t("Estoque (varejo)"),
        subtitulo: t("Cada aparelho físico por IMEI, do recebimento até virar disponível para venda."),
        vazio: t("Nenhuma unidade em estoque ainda"),
        vazioDica: t("Receba uma compra para começar a ter unidades aqui."),
      }}
    />
  );
}
