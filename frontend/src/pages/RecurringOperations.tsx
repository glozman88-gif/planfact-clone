import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useProjects } from "../api/hooks";
import { Modal } from "../components/Modal";
import { SearchSelect } from "../components/SearchSelect";

interface Recurring {
  id: number; company_id: number; name: string; active: boolean;
  type: "income" | "outcome" | "move" | "accrual";
  amount: string; currency_code: string;
  account_id?: number | null; to_account_id?: number | null;
  category_id?: number | null; debit_category_id?: number | null; credit_category_id?: number | null;
  project_id?: number | null; counterparty_id?: number | null; is_opu_calculation?: boolean | null;
  description?: string | null;
  frequency: string; interval: number;
  start_date: string; next_date: string; end_date?: string | null; last_generated_date?: string | null;
}

const TYPE_LABEL: Record<string, string> = { income: "Поступление", outcome: "Выплата", move: "Перемещение", accrual: "Начисление" };
const FREQ_LABEL: Record<string, string> = { daily: "Ежедневно", weekly: "Еженедельно", monthly: "Ежемесячно", yearly: "Ежегодно" };
const today = () => new Date().toISOString().slice(0, 10);

export function RecurringOperations() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const categories = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();
  const [editing, setEditing] = useState<Partial<Recurring> | null>(null);
  const [msg, setMsg] = useState("");

  const list = useQuery({
    queryKey: ["recurring", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<Recurring[]>("/api/recurring", { params: { company_id: companyId } })).data,
  });

  const save = useMutation({
    mutationFn: async (t: any) => t.id
      ? api.put(`/api/recurring/${t.id}`, t)
      : api.post("/api/recurring", t, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["recurring"] }); setEditing(null); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/recurring/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring"] }),
  });
  const run = useMutation({
    mutationFn: async () => (await api.post("/api/recurring/run", null, { params: { company_id: companyId } })).data,
    onSuccess: (r: any) => {
      setMsg(`Создано операций: ${r.created}` + (r.skipped_locked ? `, пропущено в закрытом периоде: ${r.skipped_locked}` : ""));
      ["operations", "balances", "dashboard", "balance", "cashflow", "pnl", "recurring"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });

  const accName = (id?: number | null) => accounts.data?.find((a) => a.id === id)?.name ?? "—";
  const catName = (id?: number | null) => categories.data?.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Повторяющиеся операции</h1>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Генерация…" : "Сгенерировать операции"}
          </button>
          <button className="btn-primary" onClick={() => setEditing({ type: "outcome", active: true, frequency: "monthly", interval: 1, start_date: today() })}>
            + Добавить шаблон
          </button>
        </div>
      </div>
      {msg && <div className="text-sm text-brand">{msg}</div>}

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Название</th><th>Тип</th><th className="text-right">Сумма</th><th>Расписание</th>
              <th>Счёт / Статья</th><th>След. дата</th><th>Активен</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td>{t.name}</td>
                <td>{TYPE_LABEL[t.type]}</td>
                <td className="text-right font-medium">{money(t.amount, t.currency_code)}</td>
                <td className="whitespace-nowrap">{FREQ_LABEL[t.frequency]}{t.interval > 1 ? ` ×${t.interval}` : ""}</td>
                <td className="text-sm text-slate-500">
                  {t.type === "accrual" ? `${catName(t.debit_category_id)} ← ${catName(t.credit_category_id)}` : `${accName(t.account_id)} · ${catName(t.category_id)}`}
                </td>
                <td className="whitespace-nowrap">{t.next_date}</td>
                <td>{t.active ? <span className="text-emerald-600">да</span> : <span className="text-slate-400">нет</span>}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="text-brand hover:underline" onClick={() => setEditing(t)}>ред.</button>
                  <button className="ml-2 text-red-500 hover:underline" onClick={() => confirm("Удалить шаблон?") && remove.mutate(t.id)}>×</button>
                </td>
              </tr>
            ))}
            {list.data && list.data.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-slate-400">Нет шаблонов</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <RecurringModal
          tpl={editing} error={save.error}
          accounts={accounts.data ?? []} categories={categories.data ?? []} projects={projects.data ?? []} parties={parties.data ?? []}
          onClose={() => { save.reset(); setEditing(null); }}
          onSave={(t: any) => save.mutate(t)}
        />
      )}
    </div>
  );
}

function RecurringModal({ tpl, onClose, onSave, accounts, categories, projects, parties, error }: any) {
  const [f, setF] = useState<any>({
    name: tpl.name ?? "", active: tpl.active ?? true, type: tpl.type ?? "outcome",
    amount: tpl.amount ?? "", currency_code: tpl.currency_code ?? "RUB",
    account_id: tpl.account_id ?? "", to_account_id: tpl.to_account_id ?? "",
    category_id: tpl.category_id ?? "", debit_category_id: tpl.debit_category_id ?? "", credit_category_id: tpl.credit_category_id ?? "",
    project_id: tpl.project_id ?? "", counterparty_id: tpl.counterparty_id ?? "", is_opu_calculation: tpl.is_opu_calculation ?? false,
    description: tpl.description ?? "",
    frequency: tpl.frequency ?? "monthly", interval: tpl.interval ?? 1,
    start_date: tpl.start_date ?? today(), end_date: tpl.end_date ?? "",
    id: tpl.id,
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const isMove = f.type === "move", isAccrual = f.type === "accrual";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: f.name, active: f.active, type: f.type,
      amount: String(f.amount || "0"), currency_code: f.currency_code,
      account_id: isAccrual ? null : (f.account_id || null),
      to_account_id: isMove ? (f.to_account_id || null) : null,
      category_id: (isMove || isAccrual) ? null : (f.category_id || null),
      debit_category_id: isAccrual ? (f.debit_category_id || null) : null,
      credit_category_id: isAccrual ? (f.credit_category_id || null) : null,
      project_id: f.project_id || null, counterparty_id: f.counterparty_id || null,
      is_opu_calculation: isAccrual ? f.is_opu_calculation : null,
      description: f.description || null,
      frequency: f.frequency, interval: Number(f.interval) || 1,
      start_date: f.start_date, end_date: f.end_date || null,
      id: f.id,
    });
  }

  const Opt = ({ v, on, list }: any) => (
    <SearchSelect value={v} onChange={on} options={list ?? []} />
  );

  return (
    <Modal title={tpl.id ? "Шаблон операции" : "Новый шаблон"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {(["income", "outcome", "move", "accrual"] as const).map((t) => (
            <button type="button" key={t} onClick={() => set("type", t)}
              className={`flex-1 rounded px-2 py-1.5 text-sm ${f.type === t ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className="label">Название шаблона</label>
            <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} required /></div>
          <div><label className="label">Сумма</label>
            <input type="number" step="0.01" className="input" value={f.amount} onChange={(e) => set("amount", e.target.value)} required /></div>
          <div><label className="label">Частота</label>
            <select className="input" value={f.frequency} onChange={(e) => set("frequency", e.target.value)}>
              {Object.entries(FREQ_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div><label className="label">Интервал (каждые N)</label>
            <input type="number" min="1" className="input" value={f.interval} onChange={(e) => set("interval", e.target.value)} /></div>
          <div><label className="label">Дата начала</label>
            <input type="date" className="input" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} required /></div>
          <div><label className="label">Дата окончания (необяз.)</label>
            <input type="date" className="input" value={f.end_date} onChange={(e) => set("end_date", e.target.value)} /></div>

          {isMove && (<>
            <div><label className="label">Счёт-источник</label><Opt v={f.account_id} on={(v: string) => set("account_id", v)} list={accounts} /></div>
            <div><label className="label">Счёт-получатель</label><Opt v={f.to_account_id} on={(v: string) => set("to_account_id", v)} list={accounts} /></div>
          </>)}
          {isAccrual && (<>
            <div><label className="label">Статья дебета (Дт)</label><Opt v={f.debit_category_id} on={(v: string) => set("debit_category_id", v)} list={categories} /></div>
            <div><label className="label">Статья кредита (Кт)</label><Opt v={f.credit_category_id} on={(v: string) => set("credit_category_id", v)} list={categories} /></div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.is_opu_calculation} onChange={(e) => set("is_opu_calculation", e.target.checked)} />
              Учитывать начисление в кассовом ОПиУ
            </label>
          </>)}
          {!isMove && !isAccrual && (<>
            <div><label className="label">Счёт</label><Opt v={f.account_id} on={(v: string) => set("account_id", v)} list={accounts} /></div>
            <div><label className="label">Статья</label><Opt v={f.category_id} on={(v: string) => set("category_id", v)} list={categories} /></div>
            <div><label className="label">Проект</label><Opt v={f.project_id} on={(v: string) => set("project_id", v)} list={projects} /></div>
            <div><label className="label">Контрагент</label><Opt v={f.counterparty_id} on={(v: string) => set("counterparty_id", v)} list={parties} /></div>
          </>)}

          <div className="col-span-2"><label className="label">Комментарий</label>
            <input className="input" value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
            Шаблон активен (участвует в генерации)
          </label>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error?.response?.data?.detail || "Не удалось сохранить шаблон"}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
