import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * A rota `/api/v1/webhooks/meta/[token]` escolhe o verificador de assinatura
 * pelo TRANSPORTE da sessão (migration 0261), não por um esquema único.
 *
 * Sessão `'datafy'` usa `verifyDatafySignature` (segredo POR NÚMERO,
 * `channel_sessions.bsp_webhook_secret_encrypted`); qualquer outra coisa —
 * incluindo `'direct'` e o `null` de toda sessão que existia antes desta
 * migration — usa `verifyMetaSignature` (App Secret da instalação), o
 * comportamento de sempre. Este arquivo prova as duas pontas e a fronteira
 * entre elas: um esquema não deve validar a entrega do outro.
 */

const DATAFY_SECRET = "whsec_numero_de_teste";
const APP_SECRET = "app-secret-de-teste";

/** Mutável: cada teste ajusta o transporte/segredo antes de chamar a rota. */
const SESSAO: {
  id: string;
  organizationId: string;
  wabaId: string | null;
  transport: "direct" | "datafy";
  datafySecretEncrypted: string | null;
} = {
  id: "sess-1",
  organizationId: "org-1",
  wabaId: "waba-1",
  transport: "direct",
  datafySecretEncrypted: null,
};

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));

vi.mock("@/lib/channels/meta/ingest", () => ({
  ingestMetaInbound: async () => ({ status: "ingested" }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({}) }) }) }) }),
    }),
    // Decifra de mentira para `decryptWebhookSecret`: qualquer ciphertext com
    // "QUEBRADO" simula chave mestra ausente/errada (RPC devolve erro);
    // qualquer outro devolve o segredo Datafy de teste em claro.
    rpc: async (_fn: string, args: { ciphertext: string }) => {
      if (args.ciphertext.includes("QUEBRADO")) return { data: null, error: { message: "erro" } };
      return { data: DATAFY_SECRET, error: null };
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;
const corpo = JSON.stringify({ object: "whatsapp_business_account" });

const pedidoMeta = (secret = APP_SECRET) =>
  ({
    text: async () => corpo,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(corpo, "utf8").digest("hex")}`,
    }),
  }) as never;

const pedidoDatafy = (timestamp: string, secret = DATAFY_SECRET) =>
  ({
    text: async () => corpo,
    headers: new Headers({
      "x-datafy-timestamp": timestamp,
      "x-datafy-signature-256": `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${corpo}`, "utf8")
        .digest("hex")}`,
    }),
  }) as never;

const agoraEmSegundos = () => String(Math.floor(Date.now() / 1000));

describe("a rota escolhe o verificador pelo transporte da sessão", () => {
  it("sessão 'direct' (padrão de toda sessão pré-0261): verifica com o App Secret da instalação", async () => {
    vi.stubEnv("META_APP_SECRET", APP_SECRET);
    Object.assign(SESSAO, { transport: "direct", datafySecretEncrypted: null });

    const res = await POST(pedidoMeta(), ctx);
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });

  it("sessão 'direct' recebendo cabeçalhos da Datafy: 401 — os dois esquemas não se misturam", async () => {
    vi.stubEnv("META_APP_SECRET", APP_SECRET);
    Object.assign(SESSAO, { transport: "direct", datafySecretEncrypted: null });

    const res = await POST(pedidoDatafy(agoraEmSegundos()), ctx);
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("sessão 'datafy' com segredo configurado e assinatura válida: 200", async () => {
    Object.assign(SESSAO, { transport: "datafy", datafySecretEncrypted: "\\xDEADBEEF" });

    const res = await POST(pedidoDatafy(agoraEmSegundos()), ctx);
    expect(res.status).toBe(200);
  });

  it("sessão 'datafy' com segredo configurado e assinatura errada: 401", async () => {
    Object.assign(SESSAO, { transport: "datafy", datafySecretEncrypted: "\\xDEADBEEF" });

    const res = await POST(pedidoDatafy(agoraEmSegundos(), "whsec_segredo_errado"), ctx);
    expect(res.status).toBe(401);
  });

  it("sessão 'datafy' recebendo a assinatura da Meta no lugar da Datafy: 401", async () => {
    Object.assign(SESSAO, { transport: "datafy", datafySecretEncrypted: "\\xDEADBEEF" });

    const res = await POST(pedidoMeta(), ctx);
    expect(res.status).toBe(401);
  });

  it("sessão 'datafy' SEM segredo configurado: 200 mesmo sem nenhum cabeçalho de assinatura — a Datafy documenta a assinatura como opcional por número", async () => {
    Object.assign(SESSAO, { transport: "datafy", datafySecretEncrypted: null });

    const res = await POST({ text: async () => corpo, headers: new Headers() } as never, ctx);
    expect(res.status).toBe(200);
  });

  it("sessão 'datafy' com segredo gravado que NÃO decifra: 401 — falha de leitura não é ausência de configuração", async () => {
    Object.assign(SESSAO, { transport: "datafy", datafySecretEncrypted: "\\xQUEBRADO" });

    const res = await POST(pedidoDatafy(agoraEmSegundos()), ctx);
    expect(res.status).toBe(401);
  });
});
