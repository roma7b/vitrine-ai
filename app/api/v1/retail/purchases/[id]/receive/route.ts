import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/retail/purchases/:id/receive — o gesto que faz nascer estoque.
 *
 * Uma linha "compramos 10 deste SKU" (`retail_purchase_items`) vira 10
 * `retail_inventory_units` em `RECEIVING`, uma por aparelho físico — cada uma
 * carregando `purchase_item_id` e `cost_cents` de volta pra linha da compra
 * (MOBILE_RETAIL_DOMAIN.md §2). Cada unidade nasce com uma linha em
 * `retail_inventory_movements` (`from_status` nulo — é o nascimento da linha).
 *
 * Só recebe compra em `draft`: recebimento é operação que acontece uma vez.
 *
 * ⚠️ Isto NÃO usa uma função `security definer` com advisory lock — ao
 * contrário da reserva (Fase 2, MOBILE_RETAIL_DOMAIN.md §6), receber uma
 * compra não tem concorrência a serializar (duas pessoas não recebem a MESMA
 * compra ao mesmo tempo pelo mesmo motivo que duas não fecham a MESMA venda).
 * A ordem de escrita ainda importa: unidades entram DEPOIS dos itens de
 * compra (para carregar `purchase_item_id`), e cada lote (itens, unidades,
 * movimentos) é um único INSERT em array — atômico dentro de si, não entre si.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { retailPurchaseReceiveSchema } from "@/lib/schemas/retail-inventory";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_purchases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: purchaseId } = await params;

  const parsed = retailPurchaseReceiveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const { data: purchase, error: purchaseError } = await supabase
    .from("retail_purchases")
    .select("id, supplier_id, currency, status")
    .eq("organization_id", authz.org.orgId)
    .eq("id", purchaseId)
    .maybeSingle();
  if (purchaseError) return fail("internal_error", "Erro ao buscar a compra.", 500, { requestId });
  if (!purchase) return fail("not_found", t("Compra não encontrada."), 404, { requestId });
  if (purchase.status !== "draft") {
    return fail("conflict", t("Esta compra já foi recebida ou foi cancelada."), 409, { requestId });
  }

  // Toda variante citada precisa ser desta org — sem isto, um id de outra
  // organização passaria pelo FK check (que não sabe de tenancy) e o
  // recebimento criaria estoque ligado a uma variante que não existe para
  // quem está vendo a tela.
  const variantIds = [...new Set(parsed.data.items.map((i) => i.variant_id))];
  const { data: variantRows, error: variantError } = await supabase
    .from("retail_product_variants")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .in("id", variantIds);
  if (variantError) return fail("internal_error", "Erro ao validar as variantes.", 500, { requestId });
  const variantIdsValidos = new Set((variantRows ?? []).map((v) => (v as { id: string }).id));
  const faltando = variantIds.filter((v) => !variantIdsValidos.has(v));
  if (faltando.length > 0) {
    return fail("validation_failed", t("Uma ou mais variantes não foram encontradas."), 422, {
      requestId,
      details: { variant_ids: faltando },
    });
  }

  const { data: purchaseItems, error: itemsError } = await supabase
    .from("retail_purchase_items")
    .insert(
      parsed.data.items.map((item) => ({
        organization_id: authz.org.orgId,
        purchase_id: purchaseId,
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit_cost_cents: item.unit_cost_cents,
      })),
    )
    .select("id, variant_id, quantity, unit_cost_cents");
  if (itemsError || !purchaseItems) {
    return fail("internal_error", "Erro ao registrar os itens da compra.", 500, { requestId });
  }

  const novasUnidades = purchaseItems.flatMap((item) =>
    Array.from({ length: item.quantity }, () => ({
      organization_id: authz.org.orgId,
      variant_id: item.variant_id,
      cost_cents: item.unit_cost_cents,
      currency: purchase.currency,
      status: "RECEIVING" as const,
      supplier_id: purchase.supplier_id,
      purchase_item_id: item.id,
    })),
  );

  const { data: unidades, error: unidadesError } = await supabase
    .from("retail_inventory_units")
    .insert(novasUnidades)
    .select("id");
  if (unidadesError || !unidades) {
    return fail("internal_error", "Erro ao criar as unidades de estoque.", 500, { requestId });
  }

  const { error: movimentosError } = await supabase.from("retail_inventory_movements").insert(
    unidades.map((u) => ({
      organization_id: authz.org.orgId,
      unit_id: u.id,
      from_status: null,
      to_status: "RECEIVING",
      reason: "received",
      actor_user_id: authz.user.id,
      actor_type: "human",
      related_purchase_id: purchaseId,
    })),
  );
  if (movimentosError) {
    return fail("internal_error", "Erro ao registrar o movimento de estoque.", 500, { requestId });
  }

  const totalCents = purchaseItems.reduce((soma, i) => soma + i.quantity * i.unit_cost_cents, 0);
  const { error: updateError } = await supabase
    .from("retail_purchases")
    .update({ status: "received", total_cost_cents: totalCents })
    .eq("organization_id", authz.org.orgId)
    .eq("id", purchaseId);
  if (updateError) {
    return fail("internal_error", "Erro ao fechar o recebimento.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_purchase.received",
    resourceType: "retail_purchases",
    resourceId: purchaseId,
    requestId,
    metadata: { units_created: unidades.length, total_cost_cents: totalCents },
  });

  return ok({ purchase_id: purchaseId, units_created: unidades.length }, { requestId });
}
