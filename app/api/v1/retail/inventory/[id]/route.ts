import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/retail/inventory/:id — detalhe de uma unidade, IMEI incluso.
 * PATCH /api/v1/retail/inventory/:id — atualiza atributos e/ou transiciona o
 *       status. Toda transição de status gera uma linha em
 *       `retail_inventory_movements` — nenhuma exceção (MOBILE_RETAIL_DOMAIN.md
 *       §3). Role `agent`: recebimento/inspeção/entrega são operação de
 *       balcão, não decisão financeira (§5) — venda/reserva ficam para a
 *       Fase 2, e não são alcançáveis por esta rota.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DA_RETAIL_UNIT,
  retailUnitPatchSchema,
  transicaoPermitida,
  type RetailUnitStatus,
} from "@/lib/schemas/retail-inventory";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "retail_inventory_units" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_inventory_units")
    .select(COLUNAS_DA_RETAIL_UNIT)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao buscar a unidade.", 500, { requestId });
  if (!data) return fail("not_found", t("Unidade não encontrada."), 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "retail_inventory_units" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = retailUnitPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { status: novoStatus, reason, ...resto } = parsed.data;
  if (Object.keys(resto).length === 0 && !novoStatus) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  const supabase = await createClient();

  const { data: atual, error: atualError } = await supabase
    .from("retail_inventory_units")
    .select("id, status")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (atualError) return fail("internal_error", "Erro ao buscar a unidade.", 500, { requestId });
  if (!atual) return fail("not_found", t("Unidade não encontrada."), 404, { requestId });

  const statusAtual = atual.status as RetailUnitStatus;
  if (novoStatus && novoStatus !== statusAtual && !transicaoPermitida(statusAtual, novoStatus)) {
    return fail(
      "validation_failed",
      t("Esta unidade não pode ir de {de} para {para}.")
        .replace("{de}", statusAtual)
        .replace("{para}", novoStatus),
      422,
      { requestId },
    );
  }

  const { data, error } = await supabase
    .from("retail_inventory_units")
    .update({ ...resto, ...(novoStatus ? { status: novoStatus } : {}) })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DA_RETAIL_UNIT)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe uma unidade com este IMEI."), 409, { requestId });
    }
    // CHECK `imei obrigatório após recebimento` — sair de RECEIVING sem IMEI.
    if (error.code === "23514") {
      return fail(
        "validation_failed",
        t("Informe o IMEI antes de tirar esta unidade de recebimento."),
        422,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao salvar a unidade.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Unidade não encontrada."), 404, { requestId });

  if (novoStatus && novoStatus !== statusAtual) {
    await supabase.from("retail_inventory_movements").insert({
      organization_id: authz.org.orgId,
      unit_id: id,
      from_status: statusAtual,
      to_status: novoStatus,
      reason: reason ?? "adjustment",
      actor_user_id: authz.user.id,
      actor_type: "human",
    });
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "inventory_unit.status_changed",
      resourceType: "retail_inventory_units",
      resourceId: id,
      requestId,
      metadata: { from_status: statusAtual, to_status: novoStatus, reason: reason ?? "adjustment" },
    });
  } else {
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "inventory_unit.updated",
      resourceType: "retail_inventory_units",
      resourceId: id,
      requestId,
    });
  }

  return ok(data, { requestId });
}
