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
import type { RetailProduct, RetailVariant } from "@/lib/schemas/retail-products";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface RascunhoProduto {
  name: string;
  brand: string;
  model_line: string;
  category: string;
}

const PRODUTO_VAZIO: RascunhoProduto = { name: "", brand: "", model_line: "", category: "" };

interface RascunhoVariante {
  sku: string;
  storage_gb: string;
  color: string;
  list_price_cents: string;
}

const VARIANTE_VAZIA: RascunhoVariante = { sku: "", storage_gb: "", color: "", list_price_cents: "" };

function VariantesDoProduto({
  produtoId,
  podeEditar,
  t,
}: {
  produtoId: string;
  podeEditar: boolean;
  t: (s: string) => string;
}) {
  const [variantes, setVariantes] = React.useState<RetailVariant[] | null>(null);
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<RascunhoVariante>(VARIANTE_VAZIA);
  const [salvando, setSalvando] = React.useState(false);

  const carregar = React.useCallback(async () => {
    try {
      const res = await apiClient.get<RetailVariant[]>(
        `/api/v1/retail/products/${produtoId}/variants`,
      );
      setVariantes(res);
    } catch (e) {
      showApiError(e);
    }
  }, [produtoId]);

  React.useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    if (rascunho.sku.trim() === "") {
      toast.error(t("Informe o SKU."));
      return;
    }
    let list_price_cents: number | null = null;
    if (rascunho.list_price_cents.trim() !== "") {
      list_price_cents = precoParaCentavos(rascunho.list_price_cents);
      if (list_price_cents === null) {
        toast.error(t("Preço inválido. Escreva assim: 5.499,00"));
        return;
      }
    }
    setSalvando(true);
    try {
      await apiClient.post(`/api/v1/retail/products/${produtoId}/variants`, {
        sku: rascunho.sku.trim(),
        ...(rascunho.storage_gb.trim() ? { storage_gb: Number(rascunho.storage_gb) } : {}),
        ...(rascunho.color.trim() ? { color: rascunho.color.trim() } : {}),
        list_price_cents,
      });
      toast.success(t("SKU cadastrado"));
      setRascunho(VARIANTE_VAZIA);
      setCriando(false);
      await carregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  if (variantes === null) {
    return <p className="px-4 pb-3 text-xs text-muted-foreground">{t("Carregando SKUs…")}</p>;
  }

  return (
    <div className="border-t bg-muted/30 px-4 py-3">
      {variantes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("Nenhum SKU ainda.")}</p>
      ) : (
        <ul className="space-y-1">
          {variantes.map((v) => (
            <li key={v.id} className="flex items-center justify-between text-sm">
              <span>
                {v.sku}
                {v.storage_gb ? ` · ${v.storage_gb}GB` : ""}
                {v.color ? ` · ${v.color}` : ""}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {v.list_price_cents != null ? formatCents(v.list_price_cents, v.currency) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {podeEditar ? (
        criando ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <input
              placeholder={t("SKU")}
              value={rascunho.sku}
              onChange={(e) => setRascunho({ ...rascunho, sku: e.target.value })}
              className="h-8 rounded-md border px-2 text-sm"
            />
            <input
              placeholder={t("GB")}
              value={rascunho.storage_gb}
              onChange={(e) => setRascunho({ ...rascunho, storage_gb: e.target.value })}
              className="h-8 rounded-md border px-2 text-sm"
            />
            <input
              placeholder={t("Cor")}
              value={rascunho.color}
              onChange={(e) => setRascunho({ ...rascunho, color: e.target.value })}
              className="h-8 rounded-md border px-2 text-sm"
            />
            <input
              placeholder={t("Preço (5.499,00)")}
              value={rascunho.list_price_cents}
              onChange={(e) => setRascunho({ ...rascunho, list_price_cents: e.target.value })}
              className="h-8 rounded-md border px-2 text-sm"
            />
            <div className="col-span-full flex gap-2">
              <Button size="sm" onClick={salvar} disabled={salvando}>
                {t(salvando ? "Salvando…" : "Salvar SKU")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCriando(false)}>
                {t("Cancelar")}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setCriando(true)}>
            {t("Novo SKU")}
          </Button>
        )
      ) : null}
    </div>
  );
}

export function RetailProdutosClient({
  inicial,
  podeEditar,
  textos,
}: {
  inicial: RetailProduct[];
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<RascunhoProduto>(PRODUTO_VAZIO);
  const [salvando, setSalvando] = React.useState(false);
  const [aberto, setAberto] = React.useState<string | null>(null);

  async function salvar() {
    if (rascunho.name.trim().length < 2) {
      toast.error(t("O nome precisa de ao menos 2 letras."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/retail/products", {
        name: rascunho.name.trim(),
        ...(rascunho.brand.trim() ? { brand: rascunho.brand.trim() } : {}),
        ...(rascunho.model_line.trim() ? { model_line: rascunho.model_line.trim() } : {}),
        ...(rascunho.category.trim() ? { category: rascunho.category.trim() } : {}),
      });
      toast.success(t("Produto cadastrado"));
      setRascunho(PRODUTO_VAZIO);
      setCriando(false);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-retail-produtos">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      {podeEditar ? (
        <div className="mb-4">
          <Button onClick={() => setCriando((v) => !v)} data-testid="novo-retail-produto">
            {t(criando ? "Cancelar" : "Novo produto")}
          </Button>
        </div>
      ) : null}

      {criando && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-retail-produto">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Nome")}
              <input
                value={rascunho.name}
                onChange={(e) => setRascunho({ ...rascunho, name: e.target.value })}
                placeholder={t("iPhone 15 Pro")}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="retail-produto-nome"
              />
            </label>
            <label className="text-sm">
              {t("Marca")}
              <input
                value={rascunho.brand}
                onChange={(e) => setRascunho({ ...rascunho, brand: e.target.value })}
                placeholder="Apple"
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Linha")}
              <input
                value={rascunho.model_line}
                onChange={(e) => setRascunho({ ...rascunho, model_line: e.target.value })}
                placeholder="iPhone 15"
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Categoria")}
              <input
                value={rascunho.category}
                onChange={(e) => setRascunho({ ...rascunho, category: e.target.value })}
                placeholder="smartphone"
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
          </div>
          <div className="mt-4">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-retail-produto">
              {t(salvando ? "Salvando…" : "Salvar produto")}
            </Button>
          </div>
        </div>
      ) : null}

      {inicial.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="retail-produtos-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-retail-produtos">
          {inicial.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setAberto(aberto === p.id ? null : p.id)}
                className="flex w-full items-center gap-4 p-3 text-left hover:bg-muted/40"
                data-testid={`retail-produto-${p.id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[p.brand, p.model_line, p.category].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
              </button>
              {aberto === p.id ? (
                <VariantesDoProduto produtoId={p.id} podeEditar={podeEditar} t={t} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
