import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/retail/purchases — pedidos de compra ao fornecedor.
 * POST /api/v1/retail/purchases — abre um pedido em `draft`. Ainda não gera
 *      unidade de estoque nenhuma — isso só acontece no recebimento
 *      (`POST /api/v1/retail/purchases/:id/receive`), que é a operação que
 *      faz nascer as unidades serializadas (MOBILE_RETAIL_DOMAIN.md §2).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import {
  COLUNAS_DA_RETAIL_PURCHASE,
  retailPurchaseCreateSchema,
} from "@/lib/schemas/retail-inventory";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "retail_purchases" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim();
  const supabase = await createClient();

  let q = supabase
    .from("retail_purchases")
    .select(COLUNAS_DA_RETAIL_PURCHASE)
    .eq("organization_id", authz.org.orgId);
  if (status) q = q.eq("status", status);

  const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
  if (error) return fail("internal_error", "Erro ao listar as compras.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_purchases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = retailPurchaseCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);
  const { data, error } = await supabase
    .from("retail_purchases")
    .insert({ ...parsed.data, organization_id: authz.org.orgId, currency: moeda, status: "draft" })
    .select(COLUNAS_DA_RETAIL_PURCHASE)
    .single();

  if (error) return fail("internal_error", "Erro ao abrir a compra.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_purchase.created",
    resourceType: "retail_purchases",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
