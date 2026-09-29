import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/retail/suppliers/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/retail/suppliers/:id — remove (RESTRICT se houver compra ou
 *        unidade ligada — histórico de fornecedor não desaparece).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_RETAIL_SUPPLIER,
  retailSupplierPatchSchema,
} from "@/lib/schemas/retail-suppliers";
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
  const authz = await requireRole("manager", { requestId, resource: "retail_suppliers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = retailSupplierPatchSchema.safeParse(await req.json().catch(() => null));
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
    .from("retail_suppliers")
    .update(parsed.data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DO_RETAIL_SUPPLIER)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao salvar o fornecedor.", 500, { requestId });
  if (!data) return fail("not_found", t("Fornecedor não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_supplier.updated",
    resourceType: "retail_suppliers",
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
  const authz = await requireRole("manager", { requestId, resource: "retail_suppliers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_suppliers")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23503") {
      return fail(
        "conflict",
        t("Este fornecedor tem compras ou unidades registradas e não pode ser removido."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao remover o fornecedor.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Fornecedor não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_supplier.deleted",
    resourceType: "retail_suppliers",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
