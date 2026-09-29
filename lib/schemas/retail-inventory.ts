import { z } from "zod";

/**
 * O CONTRATO da unidade de estoque serializada (`retail_inventory_units`) e do
 * recebimento de compra que a origina (`retail_purchases`/`retail_purchase_items`).
 *
 * Ver MOBILE_RETAIL_DOMAIN.md §2/§3. "Quanto há em estoque" nunca é um
 * decremento — é sempre `count(*) where status = 'IN_STOCK'`; esta camada só
 * escreve transições de status, cada uma espelhada em `retail_inventory_movements`.
 */

/** Máquina de estados fechada — CHECK-locked no banco, mesma lista aqui. */
export const RETAIL_UNIT_STATUSES = [
  "RECEIVING",
  "INSPECTION",
  "IN_STOCK",
  "RESERVED",
  "SOLD",
  "DELIVERED",
  "RETURN_PENDING",
  "RETURNED",
  "REPAIR",
  "DAMAGED",
  "WARRANTY",
] as const;
export type RetailUnitStatus = (typeof RETAIL_UNIT_STATUSES)[number];

/**
 * Transições permitidas pela TELA/API de operação manual (Fase 1 — sem venda,
 * sem reserva, isso é Fase 2). Vocabulário fechado: uma transição fora daqui é
 * recusada com 422 antes de tocar o banco, mesmo que o CHECK do banco a
 * aceitasse — a tela não oferece um jeito de "pular" etapa do fluxo físico.
 */
const TRANSICOES_PERMITIDAS: Record<RetailUnitStatus, readonly RetailUnitStatus[]> = {
  RECEIVING: ["INSPECTION", "DAMAGED"],
  INSPECTION: ["IN_STOCK", "DAMAGED", "REPAIR"],
  IN_STOCK: ["REPAIR", "DAMAGED", "RETURN_PENDING"],
  RESERVED: [],
  SOLD: [],
  DELIVERED: ["RETURN_PENDING"],
  RETURN_PENDING: ["RETURNED", "DAMAGED"],
  RETURNED: ["IN_STOCK", "DAMAGED"],
  REPAIR: ["IN_STOCK", "DAMAGED"],
  DAMAGED: ["REPAIR"],
  WARRANTY: ["IN_STOCK", "DAMAGED"],
};

export function transicaoPermitida(de: RetailUnitStatus, para: RetailUnitStatus): boolean {
  return TRANSICOES_PERMITIDAS[de]?.includes(para) ?? false;
}

const condicoesAbertas = z.string().trim().max(40);

/**
 * IMEI: só números, de 14 a 17. Um aparelho tem 15 (14 + dígito verificador);
 * 16 é o IMEISV, e 14 aparece em etiqueta que perdeu o último dígito. A faixa é
 * larga de propósito — a recusa aqui é de DIGITAÇÃO (letra, traço, espaço), não
 * de validade: conferir o dígito verificador (Luhn) recusaria o IMEI de teste
 * que a loja digita numa demonstração. A tela e a rota leem esta mesma regra.
 */
export const IMEI_REGEX = /^\d{14,17}$/;
export function imeiValido(valor: string): boolean {
  return IMEI_REGEX.test(valor);
}

/**
 * Como a loja classifica o estado do aparelho. Vocabulário ABERTO no banco (sem
 * CHECK — `retail_inventory_units.condition` é `text`), e é decisão de NEGÓCIO
 * que cada loja vai querer refinar (a régua de "seminovo A/B/C" muda de dono
 * para dono). Estes quatro são o ponto de partida; o rótulo na tela sai do
 * código, e um valor gravado fora da lista continua aparecendo como veio.
 */
export const RETAIL_CONDITIONS = ["NOVO", "SEMINOVO", "USADO", "PARA_PECAS"] as const;
export type RetailCondition = (typeof RETAIL_CONDITIONS)[number];

export const retailUnitPatchSchema = z.object({
  status: z.enum(RETAIL_UNIT_STATUSES).optional(),
  imei: z.string().trim().regex(IMEI_REGEX, "o IMEI tem de 14 a 17 números").optional(),
  imei2: z.string().trim().regex(IMEI_REGEX, "o IMEI 2 tem de 14 a 17 números").optional(),
  serial_number: z.string().trim().max(80).optional(),
  condition: condicoesAbertas.optional(),
  battery_health_pct: z.number().int().min(0).max(100).nullable().optional(),
  sale_price_cents: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Motivo da transição — vira `reason` em `retail_inventory_movements`. */
  reason: z.string().trim().min(1).max(60).optional(),
});
export type RetailUnitPatch = z.infer<typeof retailUnitPatchSchema>;

export interface RetailInventoryUnit {
  id: string;
  variant_id: string;
  imei: string | null;
  imei2: string | null;
  serial_number: string | null;
  condition: string | null;
  battery_health_pct: number | null;
  cost_cents: number;
  sale_price_cents: number | null;
  currency: string;
  status: RetailUnitStatus;
  is_trade_in_origin: boolean;
  supplier_id: string | null;
  purchase_item_id: string | null;
  notes: string | null;
  updated_at: string;
}

export const COLUNAS_DA_RETAIL_UNIT =
  "id, variant_id, imei, imei2, serial_number, condition, battery_health_pct, cost_cents, " +
  "sale_price_cents, currency, status, is_trade_in_origin, supplier_id, purchase_item_id, notes, updated_at";

// -----------------------------------------------------------------------------
// Recebimento de compra — a operação que faz nascer as unidades serializadas
// -----------------------------------------------------------------------------

export const retailPurchaseCreateSchema = z.object({
  supplier_id: z.string().uuid().optional(),
  purchase_date: z.string().date().optional(),
  invoice_number: z.string().trim().max(60).optional(),
});
export type RetailPurchaseCreate = z.infer<typeof retailPurchaseCreateSchema>;

const receiveItem = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(500),
  unit_cost_cents: z.number().int().min(0, "custo não pode ser negativo"),
});

/**
 * Um item de linha "compramos 10 deste SKU" vira 10 `retail_inventory_units`
 * em RECEIVING, uma por aparelho físico — a costura entre compra em lote e
 * estoque serializado (MOBILE_RETAIL_DOMAIN.md §2, `retail_purchase_items`).
 */
export const retailPurchaseReceiveSchema = z.object({
  items: z.array(receiveItem).min(1, "informe ao menos um item para receber"),
});
export type RetailPurchaseReceive = z.infer<typeof retailPurchaseReceiveSchema>;

export interface RetailPurchase {
  id: string;
  supplier_id: string | null;
  purchase_date: string | null;
  invoice_number: string | null;
  total_cost_cents: number | null;
  currency: string;
  status: "draft" | "received" | "cancelled";
  updated_at: string;
}

export const COLUNAS_DA_RETAIL_PURCHASE =
  "id, supplier_id, purchase_date, invoice_number, total_cost_cents, currency, status, updated_at";
