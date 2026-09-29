import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/retail/suppliers — fornecedores de quem a loja compra estoque.
 * POST /api/v1/retail/suppliers — cadastra um fornecedor.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_RETAIL_SUPPLIER,
  retailSupplierCreateSchema,
} from "@/lib/schemas/retail-suppliers";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "retail_suppliers" });
  if (!authz.ok) return authz.response;

  const busca = req.nextUrl.searchParams.get("busca")?.trim() ?? "";
  const supabase = await createClient();

  let q = supabase
    .from("retail_suppliers")
    .select(COLUNAS_DO_RETAIL_SUPPLIER)
    .eq("organization_id", authz.org.orgId);
  if (busca !== "") q = q.or(`name.ilike.%${busca}%,document.ilike.%${busca}%`);

  const { data, error } = await q.order("active", { ascending: false }).order("name").limit(500);
  if (error) return fail("internal_error", "Erro ao listar os fornecedores.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_suppliers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = retailSupplierCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_suppliers")
    .insert({ ...parsed.data, organization_id: authz.org.orgId })
    .select(COLUNAS_DO_RETAIL_SUPPLIER)
    .single();

  if (error) return fail("internal_error", "Erro ao salvar o fornecedor.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_supplier.created",
    resourceType: "retail_suppliers",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
