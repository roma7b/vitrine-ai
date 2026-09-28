import { z } from "zod";

/** O CONTRATO de fornecedor do domínio de varejo móvel — `retail_suppliers`. */

export const retailSupplierCreateSchema = z.object({
  name: z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(200),
  document: z.string().trim().max(30).optional(),
  contact_phone: z.string().trim().max(30).optional(),
  contact_email: z.string().trim().email("e-mail inválido").max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  active: z.boolean().default(true),
});

export const retailSupplierPatchSchema = retailSupplierCreateSchema.partial();

export type RetailSupplierCreate = z.infer<typeof retailSupplierCreateSchema>;
export type RetailSupplierPatch = z.infer<typeof retailSupplierPatchSchema>;

export interface RetailSupplier {
  id: string;
  name: string;
  document: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  active: boolean;
  updated_at: string;
}

export const COLUNAS_DO_RETAIL_SUPPLIER =
  "id, name, document, contact_phone, contact_email, notes, active, updated_at";
