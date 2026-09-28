import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/retail/variants/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/retail/variants/:id — remove o SKU (RESTRICT se houver
 *        `retail_inventory_units` ligada — nenhuma unidade fica órfã de
 *        variante).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DA_RETAIL_VARIANT,
  retailVariantPatchSchema,
} from "@/lib/schemas/retail-products";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_product_variants" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = retailVariantPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_product_variants")
    .update(parsed.data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DA_RETAIL_VARIANT)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe uma variante com esse SKU."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar a variante.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Variante não encontrada."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_variant.updated",
    resourceType: "retail_product_variants",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_product_variants" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_product_variants")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23503") {
      return fail(
        "conflict",
        t("Esta variante tem unidades de estoque registradas e não pode ser removida."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao remover a variante.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Variante não encontrada."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_variant.deleted",
    resourceType: "retail_product_variants",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
