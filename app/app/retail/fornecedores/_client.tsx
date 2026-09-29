"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import type { RetailSupplier } from "@/lib/schemas/retail-suppliers";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface Rascunho {
  name: string;
  document: string;
  contact_phone: string;
  contact_email: string;
}

const VAZIO: Rascunho = { name: "", document: "", contact_phone: "", contact_email: "" };

export function RetailFornecedoresClient({
  inicial,
  podeEditar,
  textos,
}: {
  inicial: RetailSupplier[];
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [salvando, setSalvando] = React.useState(false);

  async function salvar() {
    if (rascunho.name.trim().length < 2) {
      toast.error(t("O nome precisa de ao menos 2 letras."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/retail/suppliers", {
        name: rascunho.name.trim(),
        ...(rascunho.document.trim() ? { document: rascunho.document.trim() } : {}),
        ...(rascunho.contact_phone.trim() ? { contact_phone: rascunho.contact_phone.trim() } : {}),
        ...(rascunho.contact_email.trim() ? { contact_email: rascunho.contact_email.trim() } : {}),
      });
      toast.success(t("Fornecedor cadastrado"));
      setRascunho(VAZIO);
      setCriando(false);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6" data-testid="tela-retail-fornecedores">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      {podeEditar ? (
        <div className="mb-4">
          <Button onClick={() => setCriando((v) => !v)} data-testid="novo-retail-fornecedor">
            {t(criando ? "Cancelar" : "Novo fornecedor")}
          </Button>
        </div>
      ) : null}

      {criando && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-retail-fornecedor">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">
              {t("Nome")}
              <input
                value={rascunho.name}
                onChange={(e) => setRascunho({ ...rascunho, name: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="retail-fornecedor-nome"
              />
            </label>
            <label className="text-sm">
              {t("CNPJ/CPF")}
              <input
                value={rascunho.document}
                onChange={(e) => setRascunho({ ...rascunho, document: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Telefone")}
              <input
                value={rascunho.contact_phone}
                onChange={(e) => setRascunho({ ...rascunho, contact_phone: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              {t("E-mail")}
              <input
                value={rascunho.contact_email}
                onChange={(e) => setRascunho({ ...rascunho, contact_email: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
          </div>
          <div className="mt-4">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-retail-fornecedor">
              {t(salvando ? "Salvando…" : "Salvar fornecedor")}
            </Button>
          </div>
        </div>
      ) : null}

      {inicial.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="retail-fornecedores-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-retail-fornecedores">
          {inicial.map((s) => (
            <li key={s.id} className="p-3" data-testid={`retail-fornecedor-${s.id}`}>
              <p className="font-medium">{s.name}</p>
              <p className="text-xs text-muted-foreground">
                {[s.document, s.contact_phone, s.contact_email].filter(Boolean).join(" · ") || "—"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
