import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMetaWebhook,
  verificationChallenge,
  verifyDatafySignature,
  verifyMetaSignature,
} from "@/lib/channels/meta/webhook";

const SECRET = "app-secret-de-teste";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

describe("verifyMetaSignature", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account" });

  it("aceita a assinatura correta", () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("recusa corpo adulterado — é a razão de o HMAC existir", () => {
    expect(verifyMetaSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("recusa quando o prefixo NÃO é sha256 (o WAHA usa sha512 — não reaproveite)", () => {
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyMetaSignature(body, `sha512=${hex}`, SECRET)).toBe(false);
  });

  it("recusa hex sem o prefixo — a Meta SEMPRE manda `sha256=`", () => {
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyMetaSignature(body, hex, SECRET)).toBe(false);
  });

  it("assinatura de tamanho errado devolve false, não estoura", () => {
    // timingSafeEqual lança quando os buffers têm tamanhos diferentes; sem o
    // guard isso viraria 500 e a Meta re-entregaria o payload em loop.
    expect(() => verifyMetaSignature(body, "sha256=abcd", SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, "sha256=abcd", SECRET)).toBe(false);
  });

  it("sem header e sem segredo = false (fail-closed)", () => {
    expect(verifyMetaSignature(body, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body), "")).toBe(false);
  });
});

describe("verifyDatafySignature", () => {
  const DATAFY_SECRET = "whsec_teste_de_segredo_por_numero";
  const body = JSON.stringify({ object: "whatsapp_business_account" });
  const AGORA = new Date("2026-09-15T12:00:00Z");
  const timestamp = String(Math.floor(AGORA.getTime() / 1000));

  const assinar = (ts: string, corpo: string, secret = DATAFY_SECRET) =>
    `sha256=${createHmac("sha256", secret).update(`${ts}.${corpo}`, "utf8").digest("hex")}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aceita a assinatura correta dentro da janela de replay", () => {
    expect(verifyDatafySignature(body, timestamp, assinar(timestamp, body), DATAFY_SECRET)).toBe(true);
  });

  it("recusa segredo errado", () => {
    expect(verifyDatafySignature(body, timestamp, assinar(timestamp, body), "whsec_outro_numero")).toBe(
      false,
    );
  });

  it("recusa corpo adulterado — o material assinado é `timestamp.body`, e o corpo mudou", () => {
    expect(
      verifyDatafySignature(body + " ", timestamp, assinar(timestamp, body), DATAFY_SECRET),
    ).toBe(false);
  });

  it("recusa timestamp fora da janela de 300s — é A RAZÃO de o campo existir (replay protection que a Meta não tem)", () => {
    const velho = String(Math.floor(AGORA.getTime() / 1000) - 301);
    expect(verifyDatafySignature(body, velho, assinar(velho, body), DATAFY_SECRET)).toBe(false);
  });

  it("aceita timestamp exatamente na borda da janela (300s)", () => {
    const borda = String(Math.floor(AGORA.getTime() / 1000) - 300);
    expect(verifyDatafySignature(body, borda, assinar(borda, body), DATAFY_SECRET)).toBe(true);
  });

  it("recusa timestamp do futuro fora da janela — não só o passado", () => {
    const futuro = String(Math.floor(AGORA.getTime() / 1000) + 301);
    expect(verifyDatafySignature(body, futuro, assinar(futuro, body), DATAFY_SECRET)).toBe(false);
  });

  it("recusa timestamp trocado sem recalcular a assinatura — ele É parte do HMAC, não decoração", () => {
    // A assinatura foi calculada com `timestamp`, mas o header diz outro valor:
    // o HMAC não bate porque o material assinado (`${ts}.${body}`) mudou.
    const outroTimestamp = String(Number(timestamp) - 10);
    expect(
      verifyDatafySignature(body, outroTimestamp, assinar(timestamp, body), DATAFY_SECRET),
    ).toBe(false);
  });

  it("recusa timestamp ausente ou não-numérico, header ausente e segredo ausente (fail-closed)", () => {
    expect(verifyDatafySignature(body, null, assinar(timestamp, body), DATAFY_SECRET)).toBe(false);
    expect(
      verifyDatafySignature(body, "nao-e-numero", assinar(timestamp, body), DATAFY_SECRET),
    ).toBe(false);
    expect(verifyDatafySignature(body, timestamp, null, DATAFY_SECRET)).toBe(false);
    expect(verifyDatafySignature(body, timestamp, assinar(timestamp, body), "")).toBe(false);
  });

  it("recusa quando o prefixo não é sha256", () => {
    const hex = createHmac("sha256", DATAFY_SECRET).update(`${timestamp}.${body}`, "utf8").digest("hex");
    expect(verifyDatafySignature(body, timestamp, `sha512=${hex}`, DATAFY_SECRET)).toBe(false);
  });

  it("assinatura de tamanho errado devolve false, não estoura (mesmo guard de verifyMetaSignature)", () => {
    expect(() => verifyDatafySignature(body, timestamp, "sha256=abcd", DATAFY_SECRET)).not.toThrow();
    expect(verifyDatafySignature(body, timestamp, "sha256=abcd", DATAFY_SECRET)).toBe(false);
  });
});

describe("verificationChallenge", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it("devolve o challenge quando mode e token batem", () => {
    const c = verificationChallenge(
      q({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1234" }),
      "tok",
    );
    expect(c).toBe("1234");
  });

  it("token errado devolve null (o handler responde 403)", () => {
    expect(
      verificationChallenge(
        q({ "hub.mode": "subscribe", "hub.verify_token": "errado", "hub.challenge": "1234" }),
        "tok",
      ),
    ).toBeNull();
  });

  it("mode diferente de subscribe devolve null", () => {
    expect(
      verificationChallenge(
        q({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1234" }),
        "tok",
      ),
    ).toBeNull();
  });

  it("verify token vazio no servidor NUNCA aceita — senão qualquer um verifica", () => {
    expect(
      verificationChallenge(
        q({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1234" }),
        "",
      ),
    ).toBeNull();
  });
});

describe("parseMetaWebhook", () => {
  it("extrai mudança de status de template — o evento que a Fase 3a persegue", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "2434045433735175",
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "APPROVED",
                message_template_id: "1",
                message_template_name: "pedido_confirmado",
                message_template_language: "pt_BR",
              },
            },
          ],
        },
      ],
    });
    expect(eventos).toEqual([
      {
        kind: "template_status",
        wabaId: "2434045433735175",
        templateName: "pedido_confirmado",
        templateLanguage: "pt_BR",
        event: "APPROVED",
        reason: null,
      },
    ]);
  });

  it("cartão de contato inbound vira type contact + sharedContact", () => {
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1103328999528818" },
                contacts: [{ wa_id: "5531998966398", profile: { name: "Cliente" } }],
                messages: [
                  {
                    id: "wamid.C",
                    from: "5531998966398",
                    timestamp: "1700000000",
                    type: "contacts",
                    contacts: [
                      {
                        name: { formatted_name: "Maria Silva", first_name: "Maria", last_name: "Silva" },
                        phones: [{ phone: "+5511999887766", wa_id: "5511999887766", type: "CELL" }],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({
      kind: "inbound_message",
      type: "contact",
      text: "Maria Silva",
      sharedContact: { name: "Maria Silva", phone_number: "+5511999887766" },
    });
  });

  it("extrai status de entrega, inclusive o erro quando falha", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba1",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.A", status: "delivered", recipient_id: "5531999" },
                  {
                    id: "wamid.B",
                    status: "failed",
                    recipient_id: "5531888",
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(eventos).toHaveLength(2);
    expect(eventos[1]).toMatchObject({
      kind: "message_status",
      externalId: "wamid.B",
      status: "failed",
      errorCode: 131047,
    });
  });

  it("campo desconhecido é IGNORADO, não erro — senão a Meta re-entrega em loop", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: "w", changes: [{ field: "account_alerts", value: { qualquer: "coisa" } }] }],
    });
    expect(eventos).toEqual([]);
  });

  it("objeto que não é whatsapp_business_account não produz evento", () => {
    expect(parseMetaWebhook({ object: "page", entry: [{ id: "x" }] })).toEqual([]);
  });

  it("template sem name/language é descartado — não vira linha meia-boca", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }],
        },
      ],
    });
    expect(eventos).toEqual([]);
  });

  it('rejected_reason "NONE" vira null — achado na prova AO VIVO com a Meta', () => {
    // O template real `deskcomm_prova_webhook_0088` foi aprovado e a Meta mandou
    // `reason: "NONE"`. O handler gravou o literal enquanto o sync gravava null:
    // a MESMA coluna com duas convenções, dependendo de quem tocou por último.
    // Sem este caso, o defeito volta na próxima vez que alguém mexer no parse.
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "APPROVED",
                reason: "NONE",
                message_template_name: "t",
                message_template_language: "pt_BR",
              },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ event: "APPROVED", reason: null });
  });

  it("motivo de recusa DE VERDADE é preservado", () => {
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "REJECTED",
                reason: "INVALID_FORMAT",
                message_template_name: "t",
                message_template_language: "pt_BR",
              },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ event: "REJECTED", reason: "INVALID_FORMAT" });
  });

  it("envelope vazio ou sem entry não estoura", () => {
    expect(parseMetaWebhook({})).toEqual([]);
    expect(parseMetaWebhook({ object: "whatsapp_business_account" })).toEqual([]);
  });
});
