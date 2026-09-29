import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_RETAIL_SUPPLIER, type RetailSupplier } from "@/lib/schemas/retail-suppliers";
import { createClient } from "@/lib/supabase/server";

import { RetailFornecedoresClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Fornecedores" };

export default async function RetailFornecedoresPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data } = await supabase
    .from("retail_suppliers")
    .select(COLUNAS_DO_RETAIL_SUPPLIER)
    .eq("organization_id", activeOrg.orgId)
    .order("active", { ascending: false })
    .order("name")
    .limit(500);

  return (
    <RetailFornecedoresClient
      inicial={(data ?? []) as unknown as RetailSupplier[]}
      podeEditar={podeEditar}
      textos={{
        titulo: t("Fornecedores"),
        subtitulo: t("De quem a loja compra o estoque serializado."),
        vazio: t("Nenhum fornecedor cadastrado ainda"),
        vazioDica: t("Cadastre para poder registrar uma compra e receber estoque."),
      }}
    />
  );
}
