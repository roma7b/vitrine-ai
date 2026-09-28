import { z } from "zod";

/**
 * O CONTRATO de produto/variante do domínio de varejo móvel (retail_*).
 *
 * Um schema por lado é como nasce controle decorativo (ver `lib/schemas/produtos.ts`
 * para o precedente) — aqui os dois lados (tela e rota) importam deste arquivo.
 *
 * Distinto de `lib/schemas/produtos.ts` (catalog_products, estoque plano sem
 * IMEI): este é o domínio serializado, MOBILE_RETAIL_DOMAIN.md §2. Produto e
 * variante são tabelas separadas porque quem tem preço é o SKU, não o modelo.
 */

const nome = z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(200);

export const retailProductCreateSchema = z.object({
  name: nome,
  brand: z.string().trim().max(80).optional(),
  model_line: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().max(2000).optional(),
  image_url: z.string().trim().url().max(2000).optional(),
  active: z.boolean().default(true),
});

export const retailProductPatchSchema = retailProductCreateSchema.partial();

export type RetailProductCreate = z.infer<typeof retailProductCreateSchema>;
export type RetailProductPatch = z.infer<typeof retailProductPatchSchema>;

export interface RetailProduct {
  id: string;
  name: string;
  brand: string | null;
  model_line: string | null;
  category: string | null;
  description: string | null;
  image_url: string | null;
  active: boolean;
  updated_at: string;
}

export const COLUNAS_DO_RETAIL_PRODUCT =
  "id, name, brand, model_line, category, description, image_url, active, updated_at";

// -----------------------------------------------------------------------------
// Variante (SKU)
// -----------------------------------------------------------------------------

const sku = z
  .string()
  .trim()
  .min(1, "o SKU não pode ficar em branco")
  .max(60)
  .transform((v) => v.replace(/\s+/g, " "));

export const retailVariantCreateSchema = z.object({
  sku,
  storage_gb: z.number().int().min(0).optional(),
  color: z.string().trim().max(60).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  // Preço de tabela para unidade NOVA/default — a unidade específica pode
  // sobrescrever via retail_inventory_units.sale_price_cents.
  list_price_cents: z.number().int().min(0, "preço não pode ser negativo").nullable().optional(),
});

export const retailVariantPatchSchema = retailVariantCreateSchema.partial();

export type RetailVariantCreate = z.infer<typeof retailVariantCreateSchema>;
export type RetailVariantPatch = z.infer<typeof retailVariantPatchSchema>;

export interface RetailVariant {
  id: string;
  product_id: string;
  sku: string;
  storage_gb: number | null;
  color: string | null;
  attributes: Record<string, unknown>;
  list_price_cents: number | null;
  currency: string;
  updated_at: string;
}

export const COLUNAS_DA_RETAIL_VARIANT =
  "id, product_id, sku, storage_gb, color, attributes, list_price_cents, currency, updated_at";
