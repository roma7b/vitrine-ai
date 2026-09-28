import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_RETAIL_PRODUCT, type RetailProduct } from "@/lib/schemas/retail-products";
import { createClient } from "@/lib/supabase/server";

import { RetailProdutosClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Produtos (varejo)" };

/**
 * Os MODELOS do domínio de varejo móvel serializado por IMEI — distinto de
 * `/app/products` (catalog_products, estoque plano). Ver MOBILE_RETAIL_DOMAIN.md
 * §0 para a checagem de colisão de nome entre os dois catálogos.
 *
 * `viewer` vê; cadastrar/editar é `manager` — a rota cobra de novo.
 */
export default async function RetailProdutosPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data } = await supabase
    .from("retail_products")
    .select(COLUNAS_DO_RETAIL_PRODUCT)
    .eq("organization_id", activeOrg.orgId)
    .order("active", { ascending: false })
    .order("name")
    .limit(500);

  return (
    <RetailProdutosClient
      inicial={(data ?? []) as unknown as RetailProduct[]}
      podeEditar={podeEditar}
      textos={{
        titulo: t("Produtos (varejo)"),
        subtitulo: t(
          "O modelo vendável do estoque serializado por IMEI — sem preço aqui: preço mora no SKU (variante).",
        ),
        vazio: t("Nenhum produto cadastrado ainda"),
        vazioDica: t("Cadastre o modelo (ex.: iPhone 15 Pro) e depois os SKUs (armazenamento/cor)."),
      }}
    />
  );
}
