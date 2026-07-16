import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadFile, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCounterparties, useDealStatuses } from "../api/hooks";
import { Modal } from "../components/Modal";
import { DatePresets } from "../components/DatePresets";
import { SearchSelect } from "../components/SearchSelect";

type Kind = "sale" | "purchase";
const EMPTY_FILTERS = { status_id: "", counterparty_id: "", date_from: "", date_to: "", sum_from: "", sum_to: "", profit_from: "", profit_to: "" };

export function Deals() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const statuses = useDealStatuses();
  const parties = useCounterparties();
  const [kind, setKind] = useState<Kind>("sale");
  const [method, setMethod] = useState<"calculation" | "cash">("calculation");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const setF = (k: string, v: string) => setFilters({ ...filters, [k]: v });

  const list = useQuery({
    queryKey: ["deals-calc", companyId, kind, method],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/deals-calc", { params: { company_id: companyId, kind, method } })).data as any[],
  });
  const create = useMutation({
    mutationFn: (body: any) => api.post("/api/deals", body, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["deals-calc"] }); setAdding(false); },
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const invDeals = () => { qc.invalidateQueries({ queryKey: ["deals-calc"] }); setSelected(new Set()); };
  const bulkDelete = useMutation({
    mutationFn: (ids: number[]) => api.post("/api/deals/bulk-delete", { ids }, { params: { company_id: companyId } }),
    onSuccess: invDeals,
  });
  const bulkUpdate = useMutation({
    mutationFn: (set: any) => api.post("/api/deals/bulk-update", { ids: Array.from(selected), set }, { params: { company_id: companyId } }),
    onSuccess: () => { invDeals(); setBulkEdit(false); },
  });
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const partyName = (id?: number | null) => parties.data?.find((s) => s.id === id)?.name ?? "—";
  const statusObj = (id?: number | null) => statuses.data?.find((s) => s.id === id);
  const statusBadge = (id?: number | null) => {
    const st = statusObj(id);
    if (!st) return <span className="text-slate-400">—</span>;
    const cls = st.is_won ? "bg-emerald-100 text-emerald-700" : st.is_lost ? "bg-red-100 text-red-700"
      : st.name === "В работе" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700";
    return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{st.name}</span>;
  };
  const pctCol = (part: any, whole: any) => { const w = Number(whole); return w > 0 ? Math.round((Number(part) / w) * 100) + "%" : "0%"; };

  // Клиентская фильтрация
  const rows = (list.data ?? []).filter((r) => {
    if (filters.status_id && String(r.status_id ?? "") !== filters.status_id) return false;
    if (filters.counterparty_id && String(r.counterparty_id ?? "") !== filters.counterparty_id) return false;
    if (filters.date_from && (!r.start_date || r.start_date < filters.date_from)) return false;
    if (filters.date_to && (!r.start_date || r.start_date > filters.date_to)) return false;
    if (filters.sum_from && Number(r.amount) < Number(filters.sum_from)) return false;
    if (filters.sum_to && Number(r.amount) > Number(filters.sum_to)) return false;
    if (filters.profit_from && Number(r.profit ?? 0) < Number(filters.profit_from)) return false;
    if (filters.profit_to && Number(r.profit ?? 0) > Number(filters.profit_to)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(r.name ?? "").toLowerCase().includes(q) && !partyName(r.counterparty_id).toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const totalSum = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalProfit = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
  const isSale = kind === "sale";

  return (
    <div className="flex gap-4">
      {/* Панель фильтров */}
      <aside className="w-60 shrink-0">
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Фильтры</h3>
            <button className="text-xs text-brand hover:underline" onClick={() => { setFilters({ ...EMPTY_FILTERS }); setSearch(""); }}>Сбросить</button>
          </div>
          <div>
            <div className="label">Статус сделки</div>
            <SearchSelect value={filters.status_id} onChange={(v) => setF("status_id", v)} options={statuses.data ?? []} emptyLabel="Все" placeholder="Все" />
          </div>
          <div>
            <div className="label">{isSale ? "Клиенты" : "Поставщики"}</div>
            <SearchSelect value={filters.counterparty_id} onChange={(v) => setF("counterparty_id", v)} options={parties.data ?? []} emptyLabel="Все" placeholder="Все" />
          </div>
          <div>
            <div className="label">Дата создания</div>
            <DatePresets className="mb-1" onSelect={(from, to) => setFilters({ ...filters, date_from: from, date_to: to })} />
            <input type="date" className="input mb-1" value={filters.date_from} onChange={(e) => setF("date_from", e.target.value)} />
            <input type="date" className="input" value={filters.date_to} onChange={(e) => setF("date_to", e.target.value)} />
          </div>
          <div>
            <div className="label">Сумма сделки</div>
            <div className="flex items-center gap-1">
              <input className="input" placeholder="От" value={filters.sum_from} onChange={(e) => setF("sum_from", e.target.value)} />
              <span className="text-slate-400">—</span>
              <input className="input" placeholder="до" value={filters.sum_to} onChange={(e) => setF("sum_to", e.target.value)} />
            </div>
          </div>
          <div>
            <div className="label">Прибыль сделки</div>
            <div className="flex items-center gap-1">
              <input className="input" placeholder="От" value={filters.profit_from} onChange={(e) => setF("profit_from", e.target.value)} />
              <span className="text-slate-400">—</span>
              <input className="input" placeholder="до" value={filters.profit_to} onChange={(e) => setF("profit_to", e.target.value)} />
            </div>
          </div>
        </div>
      </aside>

      {/* Основная часть */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{isSale ? "Сделки по продажам" : "Сделки по закупкам"}</h1>
          <button className="btn-primary" onClick={() => setAdding(true)}>Создать</button>
          <div className="ml-auto flex items-center gap-2">
            <select className="input !w-48" value={method} onChange={(e) => setMethod(e.target.value as any)} title="Метод учёта">
              <option value="calculation">Метод начисления</option>
              <option value="cash">Кассовый метод</option>
            </select>
            <button className="btn-ghost flex items-center gap-1" onClick={() => downloadFile("/api/deals-export", { company_id: companyId, kind, method }, "deals.xlsx")}>⭳ .xls</button>
            <input className="input max-w-xs" placeholder="Поиск по названию или контрагенту" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="flex gap-1 rounded-md bg-slate-100 p-1 w-fit">
          {([["sale", "Продажи"], ["purchase", "Закупки"]] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`rounded px-4 py-1.5 text-sm ${kind === k ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>{lbl}</button>
          ))}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand bg-brand-light px-4 py-2 text-sm">
            <span className="font-medium">Выбрано сделок: {selected.size}</span>
            <button className="btn-ghost !py-1" onClick={() => setBulkEdit(true)}>Изменить</button>
            <button className="text-red-600 hover:underline" disabled={bulkDelete.isPending} onClick={() => { if (confirm(`Удалить выбранные сделки (${selected.size})? Закрытые пропускаются.`)) bulkDelete.mutate(Array.from(selected)); }}>Удалить</button>
            <button className="ml-auto text-slate-500 hover:underline" onClick={() => setSelected(new Set())}>Снять выделение</button>
          </div>
        )}

        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="w-8"><input type="checkbox" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                <th>Дата</th><th>Название</th><th>{isSale ? "Клиент" : "Поставщик"}</th><th>Статус</th>
                <th className="text-right">Сумма сделки</th>
                <th className="text-right">{isSale ? "Поступило" : "Выплачено"}</th>
                <th className="text-right">{isSale ? "Отгружено" : "Поставлено"}</th>
                <th className="text-right">Прибыль</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`hover:bg-slate-50 ${selected.has(r.id) ? "bg-brand-light" : ""}`}>
                  <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="text-slate-500">{r.start_date ?? "—"}</td>
                  <td className="font-medium"><Link to={`/deals/${r.id}`} className="text-brand hover:underline">{r.name}</Link></td>
                  <td>{partyName(r.counterparty_id)}</td>
                  <td>{statusBadge(r.status_id)}</td>
                  <td className="text-right">{money(r.amount)}</td>
                  <td className="text-right text-emerald-600">{pctCol(r.received, r.amount)}</td>
                  <td className="text-right text-sky-600">{pctCol(r.shipped, r.amount)}</td>
                  <td className={`text-right font-medium ${Number(r.profit) < 0 ? "text-red-600" : ""}`}>{r.profit == null ? "—" : money(r.profit)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-slate-400">{list.isLoading ? "Загрузка…" : "Нет сделок по фильтрам"}</td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 bg-slate-50 font-medium">
                  <td colSpan={9} className="px-3 py-2 text-sm">
                    {rows.length} {isSale ? "продаж" : "закупок"} на сумму: <b>{money(totalSum)}</b>
                    {isSale && <> · Общая прибыль: <b className={totalProfit < 0 ? "text-red-600" : "text-emerald-700"}>{money(totalProfit)}</b></>}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {adding && (
        <AddDeal kind={kind} onClose={() => setAdding(false)} onSave={(b) => create.mutate(b)} parties={parties.data ?? []} />
      )}
      {bulkEdit && (
        <DealsBulkEdit count={selected.size} statuses={statuses.data ?? []} parties={parties.data ?? []} isSale={isSale}
          onClose={() => setBulkEdit(false)} onSave={(set: any) => bulkUpdate.mutate(set)} />
      )}
    </div>
  );
}

function DealsBulkEdit({ count, statuses, parties, isSale, onClose, onSave }: any) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [v, setV] = useState<Record<string, any>>({});
  const submit = (e: any) => {
    e.preventDefault();
    const set: any = {};
    if (on.status_id) set.status_id = v.status_id ? Number(v.status_id) : null;
    if (on.counterparty_id) set.counterparty_id = v.counterparty_id ? Number(v.counterparty_id) : null;
    if (on.closed) set.closed = !!v.closed;
    onSave(set);
  };
  const RowF = ({ k, label, children }: any) => (
    <div className="flex items-center gap-2">
      <input type="checkbox" checked={!!on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} />
      <span className="w-36 text-sm">{label}</span>{children}
    </div>
  );
  return (
    <Modal title={`Массовое изменение сделок (${count})`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-500">Отметьте поля, которые изменить у выбранных сделок.</p>
        <RowF k="status_id" label="Статус">
          <SearchSelect disabled={!on.status_id} value={v.status_id} onChange={(val) => setV({ ...v, status_id: val })} options={statuses} emptyLabel="— без статуса —" placeholder="— без статуса —" />
        </RowF>
        <RowF k="counterparty_id" label={isSale ? "Клиент" : "Поставщик"}>
          <SearchSelect disabled={!on.counterparty_id} value={v.counterparty_id} onChange={(val) => setV({ ...v, counterparty_id: val })} options={parties} emptyLabel="— не выбран —" placeholder="— не выбран —" />
        </RowF>
        <RowF k="closed" label="Статус закрытия">
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={!on.closed} checked={!!v.closed} onChange={(e) => setV({ ...v, closed: e.target.checked })} /> Закрыта</label>
        </RowF>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Применить</button>
        </div>
      </form>
    </Modal>
  );
}

function AddDeal({ kind, onClose, onSave, parties }: any) {
  const isSale = kind === "sale";
  const [f, setF] = useState<any>({
    name: "", start_date: new Date().toISOString().slice(0, 10), counterparty_id: "", vat_mode: "with_vat", note: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  // Плоская функция (не вложенный компонент) — иначе инпуты ремоунтятся и теряют фокус на каждом вводе
  const field = (label: string, control: any, hint?: string) => (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3">
      <label className="pt-2 text-sm font-medium text-slate-600">{label}{hint && <span className="ml-1 cursor-help text-slate-300" title={hint}>?</span>}</label>
      <div>{control}</div>
    </div>
  );
  return (
    <Modal title={isSale ? "Новая продажа" : "Новая закупка"} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name: f.name, kind, start_date: f.start_date || null, counterparty_id: f.counterparty_id || null, vat_mode: f.vat_mode, note: f.note || null }); }} className="space-y-4">
        {field("Название сделки",
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Например, разработка сайта" required />)}
        {field("Дата сделки",
          <input type="date" className="input" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} />)}
        {field(isSale ? "Клиент" : "Поставщик",
          <SearchSelect value={f.counterparty_id} onChange={(val) => set("counterparty_id", val)} options={parties}
            placeholder={isSale ? "Укажите, кому продаёте товар или услугу" : "Укажите, у кого покупаете"} />)}
        {field("НДС",
          <select className="input" value={f.vat_mode} onChange={(e) => set("vat_mode", e.target.value)}>
            <option value="with_vat">С учётом НДС</option>
            <option value="without_vat">Без НДС</option>
          </select>, "Как учитывать НДС в суммах сделки")}
        {field("Комментарий",
          <textarea className="input min-h-[80px]" value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="Ваш комментарий или пояснение к этой сделке" />)}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className="btn-ghost text-brand" onClick={onClose}>Отменить</button>
          <button className="btn-primary">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
