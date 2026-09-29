import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/retail/products/:id/variants — os SKUs de um modelo.
 * POST /api/v1/retail/products/:id/variants — cadastra um SKU (o que
 *      efetivamente tem preço de tabela — MOBILE_RETAIL_DOMAIN.md §2).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import {
  COLUNAS_DA_RETAIL_VARIANT,
  retailVariantCreateSchema,
} from "@/lib/schemas/retail-products";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "retail_product_variants" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("retail_product_variants")
    .select(COLUNAS_DA_RETAIL_VARIANT)
    .eq("organization_id", authz.org.orgId)
    .eq("product_id", id)
    .order("sku");

  if (error) return fail("internal_error", "Erro ao listar as variantes.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "retail_product_variants" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: productId } = await params;

  const parsed = retailVariantCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // O produto tem que existir NESTA org antes de aceitar a variante — sem
  // isto, `product_id` de outra organização passaria pelo FK check (que não
  // sabe de tenancy) e criaria uma variante órfã para quem lê.
  const { data: produto } = await supabase
    .from("retail_products")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", productId)
    .maybeSingle();
  if (!produto) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);
  const { data, error } = await supabase
    .from("retail_product_variants")
    .insert({
      ...parsed.data,
      product_id: productId,
      organization_id: authz.org.orgId,
      currency: moeda,
    })
    .select(COLUNAS_DA_RETAIL_VARIANT)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe uma variante com esse SKU."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar a variante.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "retail_variant.created",
    resourceType: "retail_product_variants",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
