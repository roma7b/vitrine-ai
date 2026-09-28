/**
 * GET /api/v1/retail/inventory — unidades físicas serializadas por IMEI.
 * Filtros: `variant_id`, `status`, `imei`. "Quanto há em estoque" é sempre
 * `count(*) where status = 'IN_STOCK'` — nunca um decremento
 * (MOBILE_RETAIL_DOMAIN.md §2). Escrever uma unidade nova não acontece aqui:
 * nasce em `POST /api/v1/retail/purchases/:id/receive`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_RETAIL_UNIT } from "@/lib/schemas/retail-inventory";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "retail_inventory_units" });
  if (!authz.ok) return authz.response;

  const variantId = req.nextUrl.searchParams.get("variant_id")?.trim();
  const status = req.nextUrl.searchParams.get("status")?.trim();
  const imei = req.nextUrl.searchParams.get("imei")?.trim();

  const supabase = await createClient();
  let q = supabase
    .from("retail_inventory_units")
    .select(COLUNAS_DA_RETAIL_UNIT)
    .eq("organization_id", authz.org.orgId);
  if (variantId) q = q.eq("variant_id", variantId);
  if (status) q = q.eq("status", status);
  if (imei) q = q.eq("imei", imei);

  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return fail("internal_error", "Erro ao listar o estoque.", 500, { requestId });
  return ok(data ?? [], { requestId });
}
