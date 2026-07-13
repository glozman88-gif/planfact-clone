import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadFile, money } from "../api/client";
import type { Product } from "../api/types";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useDealStatuses, useLegalEntities, useProducts, useProjects } from "../api/hooks";
import { Modal } from "../components/Modal";
import { OperationModal } from "./Operations";
import type { Operation } from "../api/types";

const today = () => new Date().toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const DEAL_INVALIDATE = ["deal", "deal-summary", "deal-items", "deal-ops", "shipments", "invoices",
  "deals-calc", "operations", "balances", "dashboard", "balance", "cashflow", "pnl"];

export function DealCard() {
  const id = Number(useParams().id);
  const { companyId } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const categories = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();
  const statuses = useDealStatuses();
  const products = useProducts();
  const entities = useLegalEntities();

  const [tab, setTab] = useState<"items" | "income" | "outcome" | "shipments" | "invoices">("items");
  const [editOp, setEditOp] = useState<Partial<Operation> | null>(null);
  const [attachType, setAttachType] = useState<"income" | "outcome" | null>(null);
  const [invoicing, setInvoicing] = useState(false);
  const [printInvoiceId, setPrintInvoiceId] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [statusMenu, setStatusMenu] = useState(false);
  const [uchetMenu, setUchetMenu] = useState(false);

  const invalidate = () => DEAL_INVALIDATE.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const dealQ = useQuery({ queryKey: ["deal", id], queryFn: async () => (await api.get(`/api/deals/${id}`)).data });
  const sumQ = useQuery({
    queryKey: ["deal-summary", id], enabled: !!companyId,
    queryFn: async () => (await api.get(`/api/deals/${id}/summary`, { params: { company_id: companyId } })).data,
  });
  const itemsQ = useQuery({ queryKey: ["deal-items", id], queryFn: async () => (await api.get(`/api/deals/${id}/items`)).data as any[] });
  const opsQ = useQuery({
    queryKey: ["deal-ops", id, companyId], enabled: !!companyId,
    queryFn: async () => (await api.get("/api/operations", { params: { company_id: companyId, deal_id: id, limit: 500 } })).data.items as Operation[],
  });
  const shipQ = useQuery({ queryKey: ["shipments", id], queryFn: async () => (await api.get(`/api/deals/${id}/shipments`)).data as any[] });
  const invQ = useQuery({
    queryKey: ["invoices", id, companyId], enabled: !!companyId,
    queryFn: async () => (await api.get("/api/invoices", { params: { company_id: companyId, deal_id: id } })).data as any[],
  });

  const deal = dealQ.data;
  const s = sumQ.data;
  const isSale = deal?.kind === "sale";
  const income = (opsQ.data ?? []).filter((o) => o.type === "income");
  const outcome = (opsQ.data ?? []).filter((o) => o.type === "outcome");

  const updateDeal = useMutation({
    mutationFn: (patch: any) => api.put(`/api/deals/${id}`, { ...pickDeal(deal), ...patch }),
    onSuccess: invalidate,
  });
  const saveOp = useMutation({
    mutationFn: (op: any) => op.id
      ? api.put(`/api/operations/${op.id}`, { ...op, deal_id: id })
      : api.post("/api/operations", { ...op, deal_id: id }, { params: { company_id: companyId } }),
    onSuccess: () => { invalidate(); setEditOp(null); },
  });
  const removeOp = useMutation({ mutationFn: (opId: number) => api.delete(`/api/operations/${opId}`), onSuccess: invalidate });
  const removeDeal = useMutation({ mutationFn: () => api.delete(`/api/deals/${id}`), onSuccess: () => { invalidate(); navigate("/deals"); } });

  const accName = (x?: number | null) => accounts.data?.find((a) => a.id === x)?.name ?? "—";
  const catName = (x?: number | null) => categories.data?.find((c) => c.id === x)?.name ?? "";
  const partyName = (x?: number | null) => parties.data?.find((p) => p.id === x)?.name ?? "Не выбран";
  const curStatus = statuses.data?.find((st) => st.id === deal?.status_id);
  const dot = (st: any) => st?.is_won ? "bg-emerald-500" : st?.is_lost ? "bg-red-500" : st?.name === "В работе" ? "bg-sky-500" : "bg-amber-400";

  if (dealQ.isLoading || !deal) return <div className="text-slate-500">Загрузка сделки…</div>;

  const amount = Number(s?.amount ?? deal.amount ?? 0);
  const received = Number(s?.received ?? 0);
  const shipped = Number(s?.shipped ?? 0);
  const openAddOp = (type: "income" | "outcome") =>
    setEditOp({ type, status: "committed", op_date: today(), counterparty_id: deal.counterparty_id, project_id: deal.project_id } as any);
  const uchet = (deal.accounting_method || "calculation") === "cash" ? "Кассовым методом" : "Методом начисления";

  const TABS: [typeof tab, string, number][] = [
    ["items", "Товары и услуги", itemsQ.data?.length ?? 0],
    ["income", "Поступления", income.length],
    ["outcome", "Расходы", outcome.length],
    ["shipments", isSale ? "Отгрузки" : "Поставки", shipQ.data?.length ?? 0],
    ["invoices", "Счета", invQ.data?.length ?? 0],
  ];

  return (
    <div className="space-y-4">
      <div className="text-xs text-slate-400"><Link to="/deals" className="hover:underline">{isSale ? "Сделки продаж" : "Сделки закупок"}</Link></div>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{deal.name}</h1>
        <div className="relative ml-auto">
          <button className="rounded-md border px-3 py-1.5 text-slate-500 hover:bg-slate-50" onClick={() => setMenu(!menu)}>⋯</button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border bg-white py-1 text-sm shadow-lg">
                <button className="block w-full px-4 py-2 text-left hover:bg-slate-50" onClick={() => { setMenu(false); updateDeal.mutate({ closed: !deal.closed }); }}>
                  {deal.closed ? "Открыть сделку" : "Закрыть сделку"}
                </button>
                <button className="block w-full px-4 py-2 text-left text-red-600 hover:bg-slate-50" onClick={() => { setMenu(false); if (confirm("Удалить сделку?")) removeDeal.mutate(); }}>
                  Удалить сделку
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Сводные карточки */}
      <div className="grid gap-4 lg:grid-cols-4">
        {/* Сумма + статус */}
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase text-slate-400">Сделка на сумму <span title="Максимум из суммы позиций, оплат и отгрузок" className="cursor-help text-slate-300">ⓘ</span></span>
            <div className="relative">
              <button className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1 text-sm" onClick={() => setStatusMenu(!statusMenu)}>
                <span className={`h-2 w-2 rounded-full ${dot(curStatus)}`} />{curStatus?.name ?? "Без статуса"} ▾
              </button>
              {statusMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setStatusMenu(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border bg-white py-1 text-sm shadow-lg">
                    {statuses.data?.map((st) => (
                      <button key={st.id} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                        onClick={() => { setStatusMenu(false); updateDeal.mutate({ status_id: st.id }); }}>
                        <span className={`h-2 w-2 rounded-full ${dot(st)}`} />{st.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="text-2xl font-bold">{money(amount)}</div>
          <div className="space-y-1 border-t pt-2 text-sm">
            <Row label="Тип" value={isSale ? "Продажа" : "Закупка"} />
            <Row label={isSale ? "Клиент" : "Поставщик"} value={partyName(deal.counterparty_id)} />
            <Row label="Создана" value={deal.start_date ?? "—"} />
          </div>
        </div>

        {/* Поступления */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase text-slate-400">Поступления</span>
            <button className="text-lg text-slate-400 hover:text-brand" title="Добавить поступление" onClick={() => setAttachType("income")}>⊕</button>
          </div>
          <div className="text-2xl font-bold text-emerald-700">{money(received)}</div>
          {amount > 0 ? (
            <>
              <div className="text-xs text-slate-400">из {money(amount)}</div>
              <Progress value={pct(received, amount)} color="bg-emerald-500" />
              <div className="text-xs text-slate-500">Поступило: {pct(received, amount)}%</div>
              <div className="text-sm">{isSale ? "Клиент должен" : "Мы должны"}: <b>{money(Number(s?.debt ?? 0))}</b></div>
            </>
          ) : <div className="text-sm text-slate-400">Нет поступлений</div>}
        </div>

        {/* Отгрузки */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase text-slate-400">{isSale ? "Отгрузки клиенту" : "Поставки"}</span>
            <button className="text-lg text-slate-400 hover:text-brand" title="Добавить" onClick={() => setTab("shipments")}>⊕</button>
          </div>
          <div className="text-2xl font-bold text-sky-700">{money(shipped)}</div>
          {shipped > 0 && amount > 0 ? (
            <>
              <div className="text-xs text-slate-400">из {money(amount)}</div>
              <Progress value={pct(shipped, amount)} color="bg-sky-500" />
              <div className="text-xs text-slate-500">{isSale ? "Отгружено" : "Поставлено"}: {pct(shipped, amount)}%</div>
              <div className="text-sm">{isSale ? "Мы должны" : "Нам должны"}: <b>{money(Number(s?.goods_debt ?? 0))}</b></div>
            </>
          ) : <div className="text-sm text-slate-400">Нет {isSale ? "отгрузок" : "поставок"}</div>}
        </div>

        {/* Прибыль */}
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase text-slate-400">Прибыль сделки <span title="Доходы минус расходы по сделке" className="cursor-help text-slate-300">ⓘ</span></span>
            <div className="relative">
              <button className="text-sm text-brand" onClick={() => setUchetMenu(!uchetMenu)}>Учёт ▾</button>
              {uchetMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setUchetMenu(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border bg-white py-1 text-sm shadow-lg">
                    {([["calculation", "Методом начисления"], ["cash", "Кассовым методом"]] as const).map(([v, lbl]) => (
                      <button key={v} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                        onClick={() => { setUchetMenu(false); updateDeal.mutate({ accounting_method: v }); }}>
                        <span className={`h-3 w-3 rounded-full border ${(deal.accounting_method || "calculation") === v ? "border-brand bg-brand" : "border-slate-300"}`} />{lbl}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className={`text-2xl font-bold ${Number(s?.profit ?? 0) < 0 ? "text-red-600" : "text-slate-800"}`}>
            {s?.profit == null ? "—" : money(Number(s.profit))}
          </div>
          <div className="text-xs text-slate-400">Рентабельность {s?.margin == null ? "н/о" : s.margin + "%"} · {uchet}</div>
          <div className="space-y-1 border-t pt-2 text-sm">
            <Row label="Доходы" value={s?.income == null ? "—" : money(Number(s.income))} />
            <Row label="Расходы" value={money(Number(s?.outcome ?? 0))} valueClass="text-red-600" />
          </div>
        </div>
      </div>

      {/* Вкладки */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card p-0">
          <div className="flex flex-wrap gap-1 border-b px-3 pt-3">
            {TABS.map(([k, lbl, n]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`rounded-t-md px-3 py-2 text-sm uppercase ${tab === k ? "border-b-2 border-brand font-semibold text-brand-dark" : "text-slate-500 hover:text-slate-700"}`}>
                {lbl} <span className="text-slate-400">{n}</span>
              </button>
            ))}
          </div>

          <div className="p-4">
            {tab === "items" && <ItemsTab dealId={id} companyId={companyId} items={itemsQ.data ?? []} products={products.data ?? []} onSaved={invalidate} closed={deal.closed} />}
            {tab === "income" && (
              <OpsTab title="Платежи от клиентов за проданные товары или услуги" rows={income}
                accName={accName} partyName={partyName} catName={catName}
                onAdd={() => setAttachType("income")} onEdit={(o) => setEditOp(o)} onDel={(oid) => confirm("Удалить операцию?") && removeOp.mutate(oid)} />
            )}
            {tab === "outcome" && (
              <OpsTab title="Понесённые затраты по сделке" rows={outcome}
                accName={accName} partyName={partyName} catName={catName}
                onAdd={() => setAttachType("outcome")} onEdit={(o) => setEditOp(o)} onDel={(oid) => confirm("Удалить операцию?") && removeOp.mutate(oid)} />
            )}
            {tab === "shipments" && <ShipmentsTab dealId={id} isSale={isSale} rows={shipQ.data ?? []} onSaved={invalidate} closed={deal.closed} />}
            {tab === "invoices" && <InvoicesTab rows={invQ.data ?? []} partyName={partyName} onIssue={() => setInvoicing(true)} onOpen={(iid: number) => setPrintInvoiceId(iid)} />}
          </div>
        </div>

        {/* Файлы и комментарии */}
        <DealComments dealId={id} />
      </div>

      {editOp && (
        <OperationModal op={editOp} error={saveOp.error}
          onClose={() => { saveOp.reset(); setEditOp(null); }} onSave={(o: any) => saveOp.mutate(o)}
          accounts={accounts.data ?? []} categories={categories.data ?? []} projects={projects.data ?? []} parties={parties.data ?? []} />
      )}
      {attachType && (
        <AttachOpsModal dealId={id} companyId={companyId} type={attachType} attached={attachType === "income" ? income : outcome}
          accName={accName} partyName={partyName} catName={catName}
          onClose={() => setAttachType(null)} onSaved={invalidate}
          onCreateNew={() => { const t = attachType; setAttachType(null); openAddOp(t); }} />
      )}
      {invoicing && (
        <InvoiceModal dealId={id} companyId={companyId} counterpartyId={deal.counterparty_id}
          products={products.data ?? []} entities={entities.data ?? []} parties={parties.data ?? []}
          existingCount={invQ.data?.length ?? 0}
          onClose={() => setInvoicing(false)}
          onSaved={(iid?: number) => { invalidate(); setInvoicing(false); if (iid) setPrintInvoiceId(iid); }} />
      )}
      {printInvoiceId && <InvoicePrintView invoiceId={printInvoiceId} onClose={() => setPrintInvoiceId(null)} />}
    </div>
  );
}

function pickDeal(d: any) {
  return {
    kind: d.kind, name: d.name, status_id: d.status_id, counterparty_id: d.counterparty_id, project_id: d.project_id,
    amount: String(d.amount), cost: String(d.cost), currency_code: d.currency_code, start_date: d.start_date,
    close_date: d.close_date, note: d.note, accounting_method: d.accounting_method, vat_mode: d.vat_mode, closed: d.closed,
  };
}

function Row({ label, value, valueClass = "" }: { label: string; value: any; valueClass?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-400">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function Progress({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100">
      <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

// ---- Файлы и комментарии сделки ----
function DealComments({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const comments = useQuery({ queryKey: ["deal-comments", dealId], queryFn: async () => (await api.get(`/api/deals/${dealId}/comments`)).data as any[] });
  const files = useQuery({ queryKey: ["deal-files", dealId], queryFn: async () => (await api.get(`/api/deals/${dealId}/files`)).data as any[] });
  const inv = () => { qc.invalidateQueries({ queryKey: ["deal-comments", dealId] }); qc.invalidateQueries({ queryKey: ["deal-files", dealId] }); };
  const send = useMutation({ mutationFn: () => api.post(`/api/deals/${dealId}/comments`, { text: text.trim() }), onSuccess: () => { setText(""); inv(); } });
  const upload = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append("file", f); return api.post(`/api/deals/${dealId}/files`, fd); }, onSuccess: inv });
  const delComment = useMutation({ mutationFn: (id: number) => api.delete(`/api/deal-comments/${id}`), onSuccess: inv });
  const delFile = useMutation({ mutationFn: (id: number) => api.delete(`/api/deal-files/${id}`), onSuccess: inv });
  const fmtSize = (n: number) => n > 1024 * 1024 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ";
  const empty = !(comments.data?.length || files.data?.length);

  return (
    <div className="card flex flex-col">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Файлы и комментарии</h3>
      <div className="flex-1 space-y-2 overflow-y-auto" style={{ maxHeight: 380 }}>
        {empty && <div className="py-8 text-center text-xs text-slate-400">Прикрепляйте файлы и оставляйте комментарии для себя и своих коллег</div>}
        {files.data?.map((f) => (
          <div key={"f" + f.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5 text-sm">
            <span className="text-slate-400">📎</span>
            <button className="flex-1 truncate text-left text-brand hover:underline" title={f.filename} onClick={() => downloadFile(`/api/deal-files/${f.id}/download`, {}, f.filename)}>{f.filename}</button>
            <span className="text-xs text-slate-400">{fmtSize(f.size)}</span>
            <button className="text-red-400 hover:text-red-600" onClick={() => delFile.mutate(f.id)}>×</button>
          </div>
        ))}
        {comments.data?.map((c) => (
          <div key={"c" + c.id} className="group rounded-md bg-slate-50 px-2 py-1.5 text-sm">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{c.author ?? "—"}</span>
              <span className="flex items-center gap-2">{c.created_at ? c.created_at.slice(0, 16).replace("T", " ") : ""}
                <button className="text-red-400 opacity-0 group-hover:opacity-100" onClick={() => delComment.mutate(c.id)}>×</button></span>
            </div>
            <div className="whitespace-pre-wrap">{c.text}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-end gap-1 rounded-md border p-1">
        <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
        <button type="button" className="px-1 text-lg text-slate-400 hover:text-brand" title="Прикрепить файл" onClick={() => fileRef.current?.click()}>📎</button>
        <textarea className="min-h-[36px] flex-1 resize-none border-0 text-sm outline-none" placeholder="Написать комментарий" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) send.mutate(); } }} />
        <button type="button" className="px-2 text-lg text-brand disabled:text-slate-300" disabled={!text.trim() || send.isPending} title="Отправить" onClick={() => send.mutate()}>➤</button>
      </div>
    </div>
  );
}

// ---- Комбобокс выбора товара из справочника /products (с фильтром и созданием на лету) ----
function ProductPicker({ value, products, companyId, onSelect, disabled }: {
  value: string; products: Product[]; companyId: number | null;
  onSelect: (sel: { product_id?: number | null; name: string; unit?: string; price?: string }) => void; disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value);
  useEffect(() => { setQ(value); }, [value]);
  const term = q.trim().toLowerCase();
  const filtered = products.filter((p) => !p.is_archived && p.name.toLowerCase().includes(term));
  const exact = products.find((p) => p.name.toLowerCase() === term);
  const create = useMutation({
    mutationFn: async (name: string) => (await api.post("/api/products", { name, unit: "шт", price: "0" }, { params: { company_id: companyId } })).data as Product,
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["products"] }); onSelect({ product_id: p.id, name: p.name, unit: p.unit ?? "шт", price: String(p.price) }); setOpen(false); },
  });
  return (
    <div className="relative">
      <input className="input" value={q} disabled={disabled} placeholder="Товар или услуга из справочника"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); onSelect({ name: e.target.value, product_id: null }); }} />
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-56 w-full min-w-[240px] overflow-auto rounded-md border bg-white py-1 text-sm shadow-lg">
            {filtered.map((p) => (
              <button type="button" key={p.id} className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-slate-50"
                onClick={() => { onSelect({ product_id: p.id, name: p.name, unit: p.unit ?? "шт", price: String(p.price) }); setQ(p.name); setOpen(false); }}>
                <span>{p.name}{p.is_service && <span className="ml-1 text-xs text-slate-400">услуга</span>}</span>
                <span className="whitespace-nowrap text-slate-400">{money(p.price)}</span>
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-1.5 text-slate-400">Ничего не найдено</div>}
            {term && !exact && (
              <button type="button" className="block w-full border-t px-3 py-1.5 text-left text-brand hover:bg-slate-50" disabled={create.isPending}
                onClick={() => create.mutate(q.trim())}>+ Создать товар «{q.trim()}»</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Вкладка «Товары и услуги» ----
function ItemsTab({ dealId, companyId, items, products, onSaved, closed }: any) {
  const [rows, setRows] = useState<any[]>(() => items.length ? items.map((i: any) => ({ ...i })) : []);
  const [dirty, setDirty] = useState(false);
  const upd = (idx: number, k: string, v: any) => { setRows(rows.map((r, i) => i === idx ? { ...r, [k]: v } : r)); setDirty(true); };
  const addRow = () => { setRows([...rows, { name: "", quantity: "1", unit: "шт", price: "0", discount: "0" }]); setDirty(true); };
  const delRow = (idx: number) => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true); };
  const selectItem = (idx: number, sel: any) => {
    setRows(rows.map((r, i) => i === idx ? (sel.product_id
      ? { ...r, product_id: sel.product_id, name: sel.name, unit: sel.unit ?? r.unit, price: sel.price ?? r.price }
      : { ...r, name: sel.name, product_id: null }) : r));
    setDirty(true);
  };
  const lineTotal = (r: any) => Number(r.quantity || 0) * Number(r.price || 0) * (1 - Number(r.discount || 0) / 100);
  const total = rows.reduce((s, r) => s + lineTotal(r), 0);

  const save = useMutation({
    mutationFn: () => api.put(`/api/deals/${dealId}/items`, rows.filter((r) => r.name).map((r) => ({
      product_id: r.product_id || null, name: r.name, quantity: String(r.quantity || "0"),
      unit: r.unit || "шт", price: String(r.price || "0"), discount: String(r.discount || "0"),
    }))),
    onSuccess: () => { setDirty(false); onSaved(); },
  });

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-2xl text-slate-300">▥</div>
        <div className="font-semibold">Добавьте товары или услуги в сделку</div>
        <div className="max-w-sm text-sm text-slate-400">Наполните сделку товарами/услугами, которые покупаете или продаёте своим клиентам</div>
        {!closed && <button className="btn-primary" onClick={addRow}>Добавить</button>}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Выберите товары или услуги для {closed ? "просмотра" : "продажи"}</p>
        {!closed && <button className="btn-ghost" onClick={addRow}>+ Добавить позицию</button>}
      </div>
      <div className="overflow-x-auto">
        <table className="table text-sm">
          <thead><tr><th>Наименование</th><th className="text-right">Кол-во</th><th>Ед.</th><th className="text-right">Цена</th><th className="text-right">Скидка %</th><th className="text-right">Сумма</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td className="min-w-[220px]">
                  <ProductPicker value={r.name} products={products} companyId={companyId} disabled={closed}
                    onSelect={(sel) => selectItem(idx, sel)} />
                </td>
                <td><input type="number" step="0.001" className="input w-20 text-right" value={r.quantity} disabled={closed} onChange={(e) => upd(idx, "quantity", e.target.value)} /></td>
                <td><input className="input w-14" value={r.unit ?? ""} disabled={closed} onChange={(e) => upd(idx, "unit", e.target.value)} /></td>
                <td><input type="number" step="0.01" className="input w-28 text-right" value={r.price} disabled={closed} onChange={(e) => upd(idx, "price", e.target.value)} /></td>
                <td><input type="number" step="0.01" className="input w-20 text-right" value={r.discount} disabled={closed} onChange={(e) => upd(idx, "discount", e.target.value)} /></td>
                <td className="text-right font-medium">{money(lineTotal(r))}</td>
                <td className="text-right">{!closed && <button className="text-red-500" onClick={() => delRow(idx)}>×</button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="border-t-2 font-semibold"><td colSpan={5} className="text-right">Итого</td><td className="text-right">{money(total)}</td><td></td></tr></tfoot>
        </table>
      </div>
      {dirty && !closed && (
        <div className="flex items-center gap-2">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Сохранение…" : "Сохранить позиции"}</button>
          <span className="text-xs text-slate-400">Сумма сделки станет равна итогу позиций.</span>
        </div>
      )}
    </div>
  );
}

// ---- Вкладки «Поступления» / «Расходы» ----
function OpsTab({ title, rows, accName, partyName, catName, onAdd, onEdit, onDel }: any) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{title}</p>
        <button className="btn-primary" onClick={onAdd}>Добавить</button>
      </div>
      <table className="table text-sm">
        <thead><tr><th>Дата</th><th>Счёт</th><th>Контрагент</th><th>Статья</th><th className="text-right">Сумма</th><th></th></tr></thead>
        <tbody>
          {rows.map((o: Operation) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="whitespace-nowrap">{o.op_date}</td>
              <td>{accName(o.account_id)}</td>
              <td>{partyName(o.counterparty_id)}</td>
              <td>{o.items.length ? <span className="italic text-slate-400">разбито</span> : catName(o.category_id)}</td>
              <td className={`text-right font-medium ${o.type === "income" ? "text-emerald-700" : "text-red-700"}`}>{o.type === "income" ? "+" : "−"}{money(o.amount)}</td>
              <td className="whitespace-nowrap text-right">
                <button className="text-brand hover:underline" onClick={() => onEdit(o)}>ред.</button>
                <button className="ml-2 text-red-500 hover:underline" onClick={() => onDel(o.id)}>×</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">Нет операций</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Модалка привязки существующих операций к сделке ----
function AttachOpsModal({ dealId, companyId, type, attached, accName, partyName, catName, onClose, onSaved, onCreateNew }: any) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const label = type === "income" ? "поступлений" : "расходов";
  const pool = useQuery({
    queryKey: ["attach-pool", companyId, type],
    queryFn: async () => (await api.get("/api/operations", { params: { company_id: companyId, types: type, limit: 500 } })).data.items as Operation[],
  });
  const set = useMutation({
    mutationFn: ({ id, deal }: { id: number; deal: number | null }) =>
      api.post("/api/operations/bulk-update", { ids: [id], set: { deal_id: deal } }, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["attach-pool"] }); onSaved(); },
  });
  const match = (o: Operation) => !search || (o.description ?? "").toLowerCase().includes(search.toLowerCase()) || String(o.amount).includes(search);
  const attachable = (pool.data ?? []).filter((o) => o.deal_id == null && match(o));
  const attachedRows = (attached as Operation[]).filter(match);
  const attachedSum = attachedRows.reduce((s, o) => s + Number(o.amount), 0);

  const RowLine = ({ o, action }: { o: Operation; action: any }) => (
    <tr className="hover:bg-slate-50">
      <td className="whitespace-nowrap">{o.op_date}</td><td>{accName(o.account_id)}</td><td>{partyName(o.counterparty_id)}</td>
      <td>{catName(o.category_id)}</td><td className="text-right">{money(o.amount)}</td><td className="text-right">{action}</td>
    </tr>
  );

  return (
    <Modal title="" onClose={onClose} wide>
      <div className="space-y-3">
        <h2 className="text-lg font-bold">Добавьте операции к сделке или <button className="text-brand hover:underline" onClick={onCreateNew}>создайте новую</button></h2>
        <input className="input" placeholder="Поиск по операциям" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div>
          <div className="mb-1 text-sm font-medium text-slate-500">Прикреплённые к сделке <span className="text-slate-400">{attachedRows.length}</span></div>
          <table className="table text-sm">
            <thead><tr><th>Дата</th><th>Счёт</th><th>Контрагент</th><th>Статья</th><th className="text-right">Сумма</th><th></th></tr></thead>
            <tbody>
              {attachedRows.map((o) => <RowLine key={o.id} o={o} action={<button className="text-red-500 hover:underline" onClick={() => set.mutate({ id: o.id, deal: null })}>открепить</button>} />)}
              {attachedRows.length === 0 && <tr><td colSpan={6} className="py-2 text-center text-slate-400">—</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mb-1 text-sm font-medium text-slate-500">Можно прикрепить к сделке <span className="text-slate-400">{attachable.length}</span></div>
          <div className="max-h-64 overflow-y-auto">
            <table className="table text-sm">
              <tbody>
                {attachable.map((o) => <RowLine key={o.id} o={o} action={<button className="text-brand hover:underline" onClick={() => set.mutate({ id: o.id, deal: dealId })}>прикрепить</button>} />)}
                {attachable.length === 0 && <tr><td colSpan={6} className="py-2 text-center text-slate-400">Нет свободных операций</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <div className="text-sm">Сумма {label} в сделке: <b>{money(attachedSum)}</b></div>
          <button className="btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Вкладка «Отгрузки/Поставки» ----
function ShipmentsTab({ dealId, isSale, rows, onSaved, closed }: any) {
  const [f, setF] = useState({ ship_date: today(), amount: "", note: "" });
  const add = useMutation({
    mutationFn: () => api.post(`/api/deals/${dealId}/shipments`, { ship_date: f.ship_date, amount: String(f.amount || "0"), note: f.note || null }),
    onSuccess: () => { setF({ ship_date: today(), amount: "", note: "" }); onSaved(); },
  });
  const del = useMutation({ mutationFn: (id: number) => api.delete(`/api/shipments/${id}`), onSuccess: onSaved });
  const word = isSale ? "отгрузок" : "поставок";
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{isSale ? "Отгруженные клиенту товары/услуги на сумму" : "Полученные от поставщика товары/услуги на сумму"}</p>
      <table className="table text-sm">
        <thead><tr><th>Дата</th><th className="text-right">Сумма {isSale ? "отгрузки" : "поставки"}</th><th>Примечание</th><th></th></tr></thead>
        <tbody>
          {rows.map((sh: any) => (
            <tr key={sh.id}><td>{sh.ship_date}</td><td className="text-right">{money(sh.amount)}</td>
              <td className="text-slate-500">{sh.note}</td>
              <td className="text-right">{!closed && <button className="text-red-500" onClick={() => del.mutate(sh.id)}>×</button>}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-slate-400">Нет {word}</td></tr>}
        </tbody>
      </table>
      {!closed && (
        <form onSubmit={(e) => { e.preventDefault(); if (f.amount) add.mutate(); }} className="flex flex-wrap items-end gap-2">
          <div><label className="label">Дата {isSale ? "отгрузки" : "поставки"}</label><input type="date" className="input" value={f.ship_date} onChange={(e) => setF({ ...f, ship_date: e.target.value })} /></div>
          <div><label className="label">Сумма</label><input type="number" step="0.01" className="input w-36" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="flex-1"><label className="label">Примечание</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <button className="btn-primary">Добавить</button>
        </form>
      )}
    </div>
  );
}

// ---- Вкладка «Счета» ----
function InvoicesTab({ rows, partyName, onIssue, onOpen }: any) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Список выставленных счетов вашим клиентам</p>
        <button className="btn-primary" onClick={onIssue}>Выставить счёт</button>
      </div>
      <table className="table text-sm">
        <thead><tr><th>Дата</th><th>№ счёта</th><th>Контрагент</th><th className="text-right">Сумма</th><th></th></tr></thead>
        <tbody>
          {rows.map((inv: any) => (
            <tr key={inv.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(inv.id)}>
              <td>{inv.invoice_date}</td><td className="text-brand">{inv.number}</td>
              <td>{partyName(inv.counterparty_id)}</td><td className="text-right">{money(inv.total)}</td>
              <td className="text-right text-brand">Печать →</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">Нет счетов</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceModal({ dealId, companyId, counterpartyId, products, entities, parties, existingCount, onClose, onSaved }: any) {
  const d = today();
  const plus3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const [f, setF] = useState<any>({
    number: `${d}-${existingCount + 1}`, invoice_date: d, due_date: plus3,
    legal_entity_id: entities[0]?.id ? String(entities[0].id) : "", counterparty_id: counterpartyId ? String(counterpartyId) : "",
    vat_included: true, director_name: "", accountant_name: "", comment: "",
  });
  const [items, setItems] = useState<any[]>([{ name: "", quantity: "1", price: "0", unit: "шт.", discount: "0", vat_rate: "0" }]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const upd = (i: number, k: string, v: any) => setItems(items.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const lineOf = (x: any) => Number(x.quantity || 0) * Number(x.price || 0) * (1 - Number(x.discount || 0) / 100);
  const total = items.reduce((s, x) => s + lineOf(x), 0);
  const vat = items.reduce((s, x) => { const vr = Number(x.vat_rate || 0); return s + (vr > 0 ? (f.vat_included ? lineOf(x) * vr / (100 + vr) : lineOf(x) * vr / 100) : 0); }, 0);

  const save = useMutation({
    mutationFn: async () => (await api.post("/api/invoices", {
      number: f.number, invoice_date: f.invoice_date, due_date: f.due_date || null,
      legal_entity_id: f.legal_entity_id ? Number(f.legal_entity_id) : null,
      counterparty_id: f.counterparty_id ? Number(f.counterparty_id) : null, deal_id: dealId,
      vat_included: f.vat_included, director_name: f.director_name || null, accountant_name: f.accountant_name || null, comment: f.comment || null,
      items: items.filter((x) => x.name).map((x) => ({
        product_id: x.product_id || null, name: x.name, unit: x.unit || "шт.",
        quantity: String(x.quantity || "1"), price: String(x.price || "0"),
        discount: String(x.discount || "0"), vat_rate: String(x.vat_rate || "0"),
      })),
    }, { params: { company_id: companyId } })).data,
  });
  const submit = async (preview: boolean) => { const inv = await save.mutateAsync(); onSaved(preview ? inv.id : undefined); };

  return (
    <Modal title="Выставление счёта" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label">№ счёта</label><input className="input" value={f.number} onChange={(e) => set("number", e.target.value)} /></div>
          <div><label className="label">Дата выставления</label><input type="date" className="input" value={f.invoice_date} onChange={(e) => set("invoice_date", e.target.value)} /></div>
          <div><label className="label">Оплатить до</label><input type="date" className="input" value={f.due_date} onChange={(e) => set("due_date", e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Ваша компания (юрлицо)</label>
            <select className="input" value={f.legal_entity_id} onChange={(e) => set("legal_entity_id", e.target.value)}>
              <option value="">— выберите юрлицо —</option>
              {entities.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            {entities.length === 0 && <p className="mt-1 text-xs text-amber-600">Добавьте юрлицо с реквизитами в «Справочники → Юридические лица».</p>}
          </div>
          <div><label className="label">Клиент</label>
            <select className="input" value={f.counterparty_id} onChange={(e) => set("counterparty_id", e.target.value)}>
              <option value="">— не выбран —</option>
              {parties.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </div>
        </div>

        <div className="rounded-md border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Товары и услуги</span>
            <label className="flex items-center gap-2 text-sm text-slate-500"><input type="checkbox" checked={f.vat_included} onChange={(e) => set("vat_included", e.target.checked)} />Цены с НДС</label>
          </div>
          <div className="space-y-2">
            {items.map((x, i) => (
              <div key={i} className="flex items-end gap-2">
                <span className="pb-2 text-xs text-slate-400">{i + 1}</span>
                <div className="flex-1"><label className="label">Наименование</label>
                  <ProductPicker value={x.name} products={products} companyId={companyId}
                    onSelect={(sel) => setItems(items.map((it, idx) => idx === i ? (sel.product_id
                      ? { ...it, product_id: sel.product_id, name: sel.name, price: sel.price ?? it.price }
                      : { ...it, name: sel.name, product_id: null }) : it))} /></div>
                <div><label className="label">Кол-во</label><input type="number" step="0.001" className="input w-16" value={x.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} /></div>
                <div><label className="label">Ед.</label><input className="input w-14" value={x.unit} onChange={(e) => upd(i, "unit", e.target.value)} /></div>
                <div><label className="label">Цена</label><input type="number" step="0.01" className="input w-24" value={x.price} onChange={(e) => upd(i, "price", e.target.value)} /></div>
                <div><label className="label">Скидка %</label><input type="number" step="1" className="input w-16" value={x.discount} onChange={(e) => upd(i, "discount", e.target.value)} /></div>
                <div><label className="label">НДС %</label>
                  <select className="input w-20" value={x.vat_rate} onChange={(e) => upd(i, "vat_rate", e.target.value)}>
                    {["0", "5", "7", "10", "20"].map((v) => <option key={v} value={v}>{v === "0" ? "Без" : v}</option>)}
                  </select></div>
                <div className="w-24 pb-2 text-right text-sm font-medium">{money(lineOf(x))}</div>
                <button type="button" className="pb-2 text-red-500" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="text-sm text-brand hover:underline" onClick={() => setItems([...items, { name: "", quantity: "1", price: "0", unit: "шт.", discount: "0", vat_rate: items[items.length - 1]?.vat_rate ?? "0" }])}>+ Добавить позицию</button>
          </div>
          <div className="mt-3 space-y-0.5 border-t pt-2 text-right text-sm">
            <div>Итого: <b>{money(total)}</b></div>
            <div className="text-slate-500">{vat > 0 ? <>{f.vat_included ? "В том числе НДС" : "НДС"}: <b>{money(vat)}</b></> : "Без НДС"}</div>
            <div className="text-base">Всего к оплате: <b>{money(f.vat_included ? total : total + vat)}</b></div>
          </div>
        </div>

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Ответственные лица и комментарий</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div><label className="label">ФИО руководителя</label><input className="input" value={f.director_name} onChange={(e) => set("director_name", e.target.value)} placeholder="из реквизитов юрлица, если пусто" /></div>
            <div><label className="label">ФИО бухгалтера</label><input className="input" value={f.accountant_name} onChange={(e) => set("accountant_name", e.target.value)} /></div>
            <div className="col-span-2"><label className="label">Комментарий для получателя</label><input className="input" value={f.comment} onChange={(e) => set("comment", e.target.value)} /></div>
          </div>
        </details>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={() => submit(false)}>Сохранить счёт</button>
          <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => submit(true)}>{save.isPending ? "Сохранение…" : "Сохранить и посмотреть"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Печатная форма «Счёт на оплату» ----
function InvoicePrintView({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["invoice-print", invoiceId], queryFn: async () => (await api.get(`/api/invoices/${invoiceId}/print`)).data as any });
  const fmtDate = (iso?: string) => { if (!iso) return ""; const [y, m, dd] = iso.split("-"); return `${dd}.${m}.${y}`; };
  const s = data?.supplier, b = data?.buyer;
  const dash = (v: any) => v || "—";
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-100 p-4">
      <style>{`@media print{.no-print{display:none!important}.inv-sheet{box-shadow:none!important;margin:0!important;max-width:100%!important}body{background:#fff}}`}</style>
      <div className="no-print mx-auto mb-3 flex max-w-3xl items-center justify-between">
        <button className="btn-ghost" onClick={onClose}>← Закрыть</button>
        <button className="btn-primary" onClick={() => window.print()}>🖨 Печать / PDF</button>
      </div>
      {!data ? <div className="py-10 text-center text-slate-400">Загрузка…</div> : (
        <div className="inv-sheet mx-auto max-w-3xl rounded bg-white p-8 text-sm shadow-lg" style={{ fontFamily: "Times New Roman, serif" }}>
          {/* Банковские реквизиты поставщика */}
          <table className="w-full border-collapse text-xs" style={{ border: "1px solid #000" }}>
            <tbody>
              <tr>
                <td className="p-1" style={{ border: "1px solid #000" }} colSpan={2}>{dash(s.bank_name)}</td>
                <td className="p-1 text-center" style={{ border: "1px solid #000", width: "18%" }}>БИК</td>
                <td className="p-1" style={{ border: "1px solid #000", width: "26%" }}>{dash(s.bik)}</td>
              </tr>
              <tr>
                <td className="p-1" style={{ border: "1px solid #000" }} colSpan={2}>Банк получателя</td>
                <td className="p-1 text-center" style={{ border: "1px solid #000" }}>Сч. №</td>
                <td className="p-1" style={{ border: "1px solid #000" }}>{dash(s.corr_account)}</td>
              </tr>
              <tr>
                <td className="p-1" style={{ border: "1px solid #000", width: "28%" }}>ИНН {dash(s.inn)}</td>
                <td className="p-1" style={{ border: "1px solid #000", width: "28%" }}>КПП {dash(s.kpp)}</td>
                <td className="p-1" style={{ border: "1px solid #000" }} rowSpan={2}>Сч. №</td>
                <td className="p-1" style={{ border: "1px solid #000" }} rowSpan={2}>{dash(s.settlement_account)}</td>
              </tr>
              <tr><td className="p-1" style={{ border: "1px solid #000" }} colSpan={2}>Получатель<br /><b>{dash(s.name)}</b></td></tr>
            </tbody>
          </table>

          <h2 className="my-4 border-b-2 border-black pb-2 text-xl font-bold">Счёт на оплату № {data.number} от {fmtDate(data.date)}</h2>

          <table className="mb-4 w-full text-xs">
            <tbody>
              <tr><td className="w-24 align-top font-semibold">Поставщик<br />(Исполнитель):</td>
                <td><b>{dash(s.name)}</b>{s.inn && `, ИНН ${s.inn}`}{s.kpp && `, КПП ${s.kpp}`}{s.address && `, ${s.address}`}</td></tr>
              <tr><td className="align-top font-semibold pt-2">Покупатель<br />(Заказчик):</td>
                <td className="pt-2"><b>{dash(b.name)}</b>{b.inn && `, ИНН ${b.inn}`}{b.kpp && `, КПП ${b.kpp}`}{b.address && `, ${b.address}`}</td></tr>
            </tbody>
          </table>

          <table className="w-full border-collapse text-xs" style={{ border: "1px solid #000" }}>
            <thead>
              <tr>
                {["№", "Товары (работы, услуги)", "Кол-во", "Ед.", "Цена", "Сумма"].map((h, i) => (
                  <th key={i} className="p-1" style={{ border: "1px solid #000" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it: any) => (
                <tr key={it.n}>
                  <td className="p-1 text-center" style={{ border: "1px solid #000" }}>{it.n}</td>
                  <td className="p-1" style={{ border: "1px solid #000" }}>{it.name}</td>
                  <td className="p-1 text-right" style={{ border: "1px solid #000" }}>{Number(it.quantity)}</td>
                  <td className="p-1 text-center" style={{ border: "1px solid #000" }}>{it.unit}</td>
                  <td className="p-1 text-right" style={{ border: "1px solid #000" }}>{money(it.price)}</td>
                  <td className="p-1 text-right" style={{ border: "1px solid #000" }}>{money(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 text-right text-xs">
            <div>Итого: <b>{money(data.total)}</b></div>
            <div>{data.vat ? <>{data.vat_included ? "В том числе НДС" : "НДС"}: <b>{money(data.vat)}</b></> : "Без налога (НДС)"}</div>
            <div>Всего к оплате: <b>{money(data.total_with_vat)}</b></div>
          </div>

          <p className="mt-3 text-xs">Всего наименований {data.items_count}, на сумму {money(data.total_with_vat)} руб.</p>
          <p className="text-xs font-semibold">{data.amount_in_words}</p>
          {data.comment && <p className="mt-2 text-xs italic text-slate-600">{data.comment}</p>}

          <div className="mt-8 flex justify-between text-xs">
            <div>Руководитель ____________________ <span className="text-slate-500">{dash(data.director_name)}</span></div>
            <div>Бухгалтер ____________________ <span className="text-slate-500">{dash(data.accountant_name)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
