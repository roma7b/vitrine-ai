"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";
import { precoParaCentavos } from "@/lib/schemas/produtos";
import {
  RETAIL_UNIT_STATUSES,
  transicaoPermitida,
  type RetailInventoryUnit,
  type RetailUnitStatus,
} from "@/lib/schemas/retail-inventory";

export interface VarianteComProduto {
  id: string;
  sku: string;
  storage_gb: number | null;
  color: string | null;
  produtoNome: string;
}

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface RascunhoRecebimento {
  supplier_id: string;
  variant_id: string;
  quantity: string;
  unit_cost_cents: string;
}

const RECEBIMENTO_VAZIO: RascunhoRecebimento = {
  supplier_id: "",
  variant_id: "",
  quantity: "1",
  unit_cost_cents: "",
};

function rotuloDaVariante(v: VarianteComProduto): string {
  return [v.produtoNome, v.sku, v.storage_gb ? `${v.storage_gb}GB` : null, v.color]
    .filter(Boolean)
    .join(" · ");
}

export function RetailEstoqueClient({
  inicial,
  variantes,
  fornecedores,
  podeReceber,
  textos,
}: {
  inicial: RetailInventoryUnit[];
  variantes: VarianteComProduto[];
  fornecedores: { id: string; name: string }[];
  podeReceber: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [recebendo, setRecebendo] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<RascunhoRecebimento>(RECEBIMENTO_VAZIO);
  const [salvando, setSalvando] = React.useState(false);
  const [filtroStatus, setFiltroStatus] = React.useState<string>("");
  const [movendo, setMovendo] = React.useState<Record<string, RetailUnitStatus | "">>({});

  const filtrados = React.useMemo(
    () => (filtroStatus ? inicial.filter((u) => u.status === filtroStatus) : inicial),
    [inicial, filtroStatus],
  );

  async function receber() {
    if (!rascunho.variant_id) {
      toast.error(t("Escolha o SKU."));
      return;
    }
    const quantity = Number(rascunho.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      toast.error(t("Quantidade inválida."));
      return;
    }
    const unit_cost_cents = precoParaCentavos(rascunho.unit_cost_cents);
    if (unit_cost_cents === null) {
      toast.error(t("Custo inválido. Escreva assim: 4.100,00"));
      return;
    }
    setSalvando(true);
    try {
      const compra = await apiClient.post<{ data: { id: string } }>("/api/v1/retail/purchases", {
        ...(rascunho.supplier_id ? { supplier_id: rascunho.supplier_id } : {}),
      });
      await apiClient.post(`/api/v1/retail/purchases/${compra.data.id}/receive`, {
        items: [{ variant_id: rascunho.variant_id, quantity, unit_cost_cents }],
      });
      toast.success(t("{n} unidades recebidas").replace("{n}", String(quantity)));
      setRascunho(RECEBIMENTO_VAZIO);
      setRecebendo(false);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function moverStatus(unidade: RetailInventoryUnit) {
    const proximo = movendo[unidade.id];
    if (!proximo) return;
    try {
      await apiClient.patch(`/api/v1/retail/inventory/${unidade.id}`, {
        status: proximo,
        reason: `moved_to_${proximo.toLowerCase()}`,
      });
      toast.success(t("Status atualizado"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-retail-estoque">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={filtroStatus}
          onChange={(e) => setFiltroStatus(e.target.value)}
          className="h-9 rounded-md border px-3 text-sm"
          data-testid="filtro-status-estoque"
        >
          <option value="">{t("Todos os status")}</option>
          {RETAIL_UNIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {podeReceber ? (
          <Button onClick={() => setRecebendo((v) => !v)} data-testid="receber-estoque">
            {t(recebendo ? "Cancelar" : "Receber estoque")}
          </Button>
        ) : null}
      </div>

      {recebendo && podeReceber ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-receber-estoque">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Fornecedor")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <select
                value={rascunho.supplier_id}
                onChange={(e) => setRascunho({ ...rascunho, supplier_id: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              >
                <option value="">—</option>
                {fornecedores.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {t("SKU")}
              <select
                value={rascunho.variant_id}
                onChange={(e) => setRascunho({ ...rascunho, variant_id: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="receber-sku"
              >
                <option value="">{t("Escolha")}</option>
                {variantes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {rotuloDaVariante(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {t("Quantidade")}
              <input
                value={rascunho.quantity}
                onChange={(e) => setRascunho({ ...rascunho, quantity: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="receber-quantidade"
              />
            </label>
            <label className="text-sm">
              {t("Custo por unidade")}
              <input
                value={rascunho.unit_cost_cents}
                onChange={(e) => setRascunho({ ...rascunho, unit_cost_cents: e.target.value })}
                placeholder="4.100,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="receber-custo"
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "Cada unidade nasce em RECEIVING, sem IMEI ainda — informe o IMEI de cada uma antes de mandá-la para INSPECTION.",
            )}
          </p>
          <div className="mt-4">
            <Button onClick={receber} disabled={salvando} data-testid="salvar-receber-estoque">
              {t(salvando ? "Recebendo…" : "Confirmar recebimento")}
            </Button>
          </div>
        </div>
      ) : null}

      {filtrados.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="retail-estoque-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-retail-estoque">
          {filtrados.map((u) => {
            const opcoes = RETAIL_UNIT_STATUSES.filter((s) => transicaoPermitida(u.status, s));
            return (
              <li key={u.id} className="flex items-center gap-4 p-3" data-testid={`retail-unidade-${u.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{u.imei ?? t("IMEI não informado")}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.status}
                    {u.condition ? ` · ${u.condition}` : ""}
                    {" · "}
                    {formatCents(u.cost_cents, u.currency)}
                  </p>
                </div>
                {podeReceber && opcoes.length > 0 ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={movendo[u.id] ?? ""}
                      onChange={(e) =>
                        setMovendo({ ...movendo, [u.id]: e.target.value as RetailUnitStatus | "" })
                      }
                      className="h-8 rounded-md border px-2 text-sm"
                      data-testid={`mover-status-${u.id}`}
                    >
                      <option value="">{t("Mover para…")}</option>
                      {opcoes.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!movendo[u.id]}
                      onClick={() => void moverStatus(u)}
                    >
                      {t("Ir")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
