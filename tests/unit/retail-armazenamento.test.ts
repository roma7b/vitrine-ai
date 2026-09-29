import { describe, expect, it } from "vitest";

import { armazenamentoParaGb } from "@/lib/schemas/retail-products";

/**
 * O campo "GB" da tela de SKU. O defeito real: `Number("256GB")` dava NaN, o JSON
 * o trocava por `null`, e a rota respondia só "Dados inválidos." sem dizer o campo.
 */
describe("armazenamentoParaGb — como o lojista escreve na caixa", () => {
  it("aceita número puro, com GB e com espaço, em qualquer caixa", () => {
    expect(armazenamentoParaGb("256")).toBe(256);
    expect(armazenamentoParaGb("256GB")).toBe(256);
    expect(armazenamentoParaGb("256 gb")).toBe(256);
    expect(armazenamentoParaGb("  128Gb ")).toBe(128);
  });

  it("TB vale 1024 GB — o iPhone de 1TB e o de 2TB", () => {
    expect(armazenamentoParaGb("1TB")).toBe(1024);
    expect(armazenamentoParaGb("2 tb")).toBe(2048);
  });

  it("recusa o que não se lê, em vez de chutar um número", () => {
    expect(armazenamentoParaGb("")).toBeNull();
    expect(armazenamentoParaGb("grande")).toBeNull();
    expect(armazenamentoParaGb("256MB")).toBeNull();
    expect(armazenamentoParaGb("2,5GB")).toBeNull(); // não é inteiro
    expect(armazenamentoParaGb("-256")).toBeNull();
    expect(armazenamentoParaGb("256GB extra")).toBeNull();
  });
});
