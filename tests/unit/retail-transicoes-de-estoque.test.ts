import { describe, expect, it } from "vitest";

import {
  RETAIL_UNIT_STATUSES,
  transicaoPermitida,
  type RetailUnitStatus,
} from "@/lib/schemas/retail-inventory";

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
