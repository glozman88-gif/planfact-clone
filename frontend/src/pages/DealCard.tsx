import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useDealStatuses, useProducts, useProjects } from "../api/hooks";
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

  const [tab, setTab] = useState<"items" | "income" | "outcome" | "shipments" | "invoices">("items");
  const [editOp, setEditOp] = useState<Partial<Operation> | null>(null);
  const [attachType, setAttachType] = useState<"income" | "outcome" | null>(null);
  const [invoicing, setInvoicing] = useState(false);
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
            {tab === "items" && <ItemsTab dealId={id} items={itemsQ.data ?? []} products={products.data ?? []} onSaved={invalidate} closed={deal.closed} />}
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
            {tab === "invoices" && <InvoicesTab rows={invQ.data ?? []} partyName={partyName} onIssue={() => setInvoicing(true)} />}
          </div>
        </div>

        {/* Файлы и комментарии */}
        <div className="card flex flex-col">
          <h3 className="text-sm font-semibold text-slate-700">Файлы и комментарии</h3>
          <div className="flex-1 py-6 text-center text-xs text-slate-400">Прикрепляйте файлы и оставляйте комментарии для себя и своих коллег</div>
          <textarea className="input min-h-[70px]" defaultValue={deal.note ?? ""} placeholder="Написать комментарий" key={deal.note}
            onBlur={(e) => { if (e.target.value !== (deal.note ?? "")) updateDeal.mutate({ note: e.target.value || null }); }} />
        </div>
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
          products={products.data ?? []} existingCount={invQ.data?.length ?? 0}
          onClose={() => setInvoicing(false)} onSaved={() => { invalidate(); setInvoicing(false); }} />
      )}
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

// ---- Вкладка «Товары и услуги» ----
function ItemsTab({ dealId, items, products, onSaved, closed }: any) {
  const [rows, setRows] = useState<any[]>(() => items.length ? items.map((i: any) => ({ ...i })) : []);
  const [dirty, setDirty] = useState(false);
  const upd = (idx: number, k: string, v: any) => { setRows(rows.map((r, i) => i === idx ? { ...r, [k]: v } : r)); setDirty(true); };
  const addRow = () => { setRows([...rows, { name: "", quantity: "1", unit: "шт", price: "0", discount: "0" }]); setDirty(true); };
  const delRow = (idx: number) => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true); };
  const pickProduct = (idx: number, pid: string) => {
    const p = products.find((x: any) => x.id === Number(pid));
    if (p) setRows(rows.map((r, i) => i === idx ? { ...r, product_id: p.id, name: p.name, unit: p.unit ?? "шт", price: String(p.price) } : r));
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
                <td>
                  <input className="input" list={`prod-${idx}`} value={r.name} disabled={closed}
                    onChange={(e) => { const p = products.find((x: any) => x.name === e.target.value); if (p) pickProduct(idx, String(p.id)); else upd(idx, "name", e.target.value); }} />
                  <datalist id={`prod-${idx}`}>{products.map((p: any) => <option key={p.id} value={p.name} />)}</datalist>
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
  const [f, setF] = useState({ ship_date: today(), amount: "", cost: "", note: "" });
  const add = useMutation({
    mutationFn: () => api.post(`/api/deals/${dealId}/shipments`, { ...f, amount: String(f.amount || "0"), cost: String(f.cost || "0") }),
    onSuccess: () => { setF({ ship_date: today(), amount: "", cost: "", note: "" }); onSaved(); },
  });
  const del = useMutation({ mutationFn: (id: number) => api.delete(`/api/shipments/${id}`), onSuccess: onSaved });
  const word = isSale ? "отгрузок" : "поставок";
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{isSale ? "Отгруженные клиенту товары/услуги" : "Полученные от поставщика товары/услуги"}</p>
      <table className="table text-sm">
        <thead><tr><th>Дата</th><th className="text-right">Сумма</th><th className="text-right">Себестоимость</th><th>Примечание</th><th></th></tr></thead>
        <tbody>
          {rows.map((sh: any) => (
            <tr key={sh.id}><td>{sh.ship_date}</td><td className="text-right">{money(sh.amount)}</td><td className="text-right">{money(sh.cost)}</td>
              <td className="text-slate-500">{sh.note}</td>
              <td className="text-right">{!closed && <button className="text-red-500" onClick={() => del.mutate(sh.id)}>×</button>}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-slate-400">Нет {word}</td></tr>}
        </tbody>
      </table>
      {!closed && (
        <form onSubmit={(e) => { e.preventDefault(); if (f.amount) add.mutate(); }} className="flex flex-wrap items-end gap-2">
          <div><label className="label">Дата</label><input type="date" className="input" value={f.ship_date} onChange={(e) => setF({ ...f, ship_date: e.target.value })} /></div>
          <div><label className="label">Сумма</label><input type="number" step="0.01" className="input w-32" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div><label className="label">Себестоимость</label><input type="number" step="0.01" className="input w-32" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></div>
          <div className="flex-1"><label className="label">Примечание</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <button className="btn-primary">Добавить</button>
        </form>
      )}
    </div>
  );
}

// ---- Вкладка «Счета» ----
function InvoicesTab({ rows, partyName, onIssue }: any) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Список выставленных счетов вашим клиентам</p>
        <button className="btn-primary" onClick={onIssue}>Выставить счёт</button>
      </div>
      <table className="table text-sm">
        <thead><tr><th>Дата</th><th>№ счёта</th><th>Контрагент</th><th className="text-right">Сумма</th></tr></thead>
        <tbody>
          {rows.map((inv: any) => (
            <tr key={inv.id}><td>{inv.invoice_date}</td><td className="text-brand">{inv.number}</td><td>{partyName(inv.counterparty_id)}</td><td className="text-right">{money(inv.total)}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-slate-400">Нет счетов</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceModal({ dealId, companyId, counterpartyId, products, existingCount, onClose, onSaved }: any) {
  const d = today();
  const [f, setF] = useState({ number: `${d}-${existingCount + 1}`, invoice_date: d, due_date: "" });
  const [items, setItems] = useState<any[]>([{ name: "", quantity: "1", price: "0" }]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const upd = (i: number, k: string, v: any) => setItems(items.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const total = items.reduce((s, x) => s + Number(x.quantity || 0) * Number(x.price || 0), 0);
  const save = useMutation({
    mutationFn: () => api.post("/api/invoices", {
      ...f, due_date: f.due_date || null, counterparty_id: counterpartyId || null, deal_id: dealId,
      items: items.filter((x) => x.name).map((x) => ({ product_id: x.product_id || null, name: x.name, quantity: String(x.quantity || "1"), price: String(x.price || "0") })),
    }, { params: { company_id: companyId } }),
    onSuccess: onSaved,
  });
  return (
    <Modal title="Выставить счёт" onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label">№ счёта</label><input className="input" value={f.number} onChange={(e) => set("number", e.target.value)} required /></div>
          <div><label className="label">Дата</label><input type="date" className="input" value={f.invoice_date} onChange={(e) => set("invoice_date", e.target.value)} /></div>
          <div><label className="label">Оплатить до</label><input type="date" className="input" value={f.due_date} onChange={(e) => set("due_date", e.target.value)} /></div>
        </div>
        <div className="space-y-2">
          {items.map((x, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1"><label className="label">Позиция</label>
                <input className="input" list={`inv-prod-${i}`} value={x.name}
                  onChange={(e) => { const p = products.find((pp: any) => pp.name === e.target.value); if (p) setItems(items.map((it, idx) => idx === i ? { ...it, product_id: p.id, name: p.name, price: String(p.price) } : it)); else upd(i, "name", e.target.value); }} />
                <datalist id={`inv-prod-${i}`}>{products.map((p: any) => <option key={p.id} value={p.name} />)}</datalist>
              </div>
              <div><label className="label">Кол-во</label><input type="number" step="0.001" className="input w-20" value={x.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} /></div>
              <div><label className="label">Цена</label><input type="number" step="0.01" className="input w-28" value={x.price} onChange={(e) => upd(i, "price", e.target.value)} /></div>
              <button type="button" className="pb-2 text-red-500" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setItems([...items, { name: "", quantity: "1", price: "0" }])}>+ позиция</button>
        </div>
        <div className="text-right text-sm">Итого: <b>{money(total)}</b></div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? "Сохранение…" : "Выставить счёт"}</button>
        </div>
      </form>
    </Modal>
  );
}
