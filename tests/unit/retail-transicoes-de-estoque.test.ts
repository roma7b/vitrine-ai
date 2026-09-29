import { describe, expect, it } from "vitest";

import {
  imeiValido,
  RETAIL_UNIT_STATUSES,
  retailUnitPatchSchema,
  transicaoPermitida,
  type RetailUnitStatus,
} from "@/lib/schemas/retail-inventory";

describe("IMEI — a regra que a tela e a rota compartilham", () => {
  it("aceita 15 números (o caso normal) e a faixa 14–17", () => {
    expect(imeiValido("356938035643809")).toBe(true);
    expect(imeiValido("35693803564380")).toBe(true);
    expect(imeiValido("3569380356438091")).toBe(true);
  });

  it("recusa erro de digitação: letra, traço, espaço, curto e longo demais", () => {
    expect(imeiValido("35693803564380A")).toBe(false);
    expect(imeiValido("356938-03-564380")).toBe(false);
    expect(imeiValido("3569 3803 5643 809")).toBe(false);
    expect(imeiValido("1234567890123")).toBe(false);
    expect(imeiValido("123456789012345678")).toBe(false);
    expect(imeiValido("")).toBe(false);
  });

  it("a rota recusa o mesmo que a tela: o corpo com letra no IMEI não passa", () => {
    expect(retailUnitPatchSchema.safeParse({ imei: "35693803564380A" }).success).toBe(false);
    expect(retailUnitPatchSchema.safeParse({ imei: "356938035643809" }).success).toBe(true);
  });

  it("IMEI, condição, bateria e preço juntos, com a inspeção no mesmo pedido", () => {
    const r = retailUnitPatchSchema.safeParse({
      imei: "356938035643809",
      condition: "SEMINOVO",
      battery_health_pct: 89,
      sale_price_cents: 549900,
      status: "INSPECTION",
      reason: "inspection_started",
    });
    expect(r.success).toBe(true);
  });

  it("bateria fora de 0–100 é recusada", () => {
    expect(retailUnitPatchSchema.safeParse({ battery_health_pct: 101 }).success).toBe(false);
    expect(retailUnitPatchSchema.safeParse({ battery_health_pct: -1 }).success).toBe(false);
  });
});

/**
 * A máquina de estados da unidade de estoque (MOBILE_RETAIL_DOMAIN.md §3) —
 * fechada por CHECK no banco, e fechada aqui de novo pela TELA/API: uma
 * transição fora do fluxo físico não deve nem chegar ao banco para ser
 * recusada lá, tem que ser recusada antes.
 */
describe("transicaoPermitida — estoque de varejo", () => {
  it("segue o caminho feliz do recebimento até a entrega", () => {
    expect(transicaoPermitida("RECEIVING", "INSPECTION")).toBe(true);
    expect(transicaoPermitida("INSPECTION", "IN_STOCK")).toBe(true);
  });

  it("recusa pular etapa — RECEIVING direto para IN_STOCK", () => {
    expect(transicaoPermitida("RECEIVING", "IN_STOCK")).toBe(false);
  });

  it("recusa venda/reserva por esta rota — isso é Fase 2, não Fase 1", () => {
    expect(transicaoPermitida("IN_STOCK", "RESERVED")).toBe(false);
    expect(transicaoPermitida("IN_STOCK", "SOLD")).toBe(false);
  });

  it("SOLD e RESERVED não têm transição de saída nesta camada — só a venda/reserva de verdade mexe nelas", () => {
    expect(transicaoPermitida("SOLD", "DELIVERED")).toBe(false);
    expect(transicaoPermitida("RESERVED", "IN_STOCK")).toBe(false);
  });

  it("todo status conhecido aparece como chave da máquina — nenhum status órfão", () => {
    // Controle: se um status novo entrar em RETAIL_UNIT_STATUSES sem entrar no
    // mapa de transições, `transicaoPermitida` devolveria `false` para tudo
    // dele em silêncio, e este teste é o que denuncia.
    for (const status of RETAIL_UNIT_STATUSES) {
      const algumaTransicao = RETAIL_UNIT_STATUSES.some((destino) =>
        transicaoPermitida(status as RetailUnitStatus, destino),
      );
      const terminal: RetailUnitStatus[] = ["SOLD", "RESERVED"];
      if (!terminal.includes(status)) {
        expect(algumaTransicao, `${status} não tem NENHUMA transição de saída`).toBe(true);
      }
    }
  });

  it("um dano pode voltar para reparo, e um reparo concluído volta ao estoque", () => {
    expect(transicaoPermitida("DAMAGED", "REPAIR")).toBe(true);
    expect(transicaoPermitida("REPAIR", "IN_STOCK")).toBe(true);
  });
});
