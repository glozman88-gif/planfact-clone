import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useLegalEntities, useProjects } from "../api/hooks";
import { ExportButton } from "../components/ExportButton";
import { Modal } from "../components/Modal";
import { DatePresets } from "../components/DatePresets";
import { SearchSelect } from "../components/SearchSelect";
import type { Operation, OperationList, OperationType } from "../api/types";

const TYPE_LABEL: Record<OperationType, string> = {
  income: "Поступление", outcome: "Выплата", move: "Перемещение", accrual: "Начисление",
  shipment: "Отгрузка", supply: "Поставка",
};
const TYPE_COLOR: Record<OperationType, string> = {
  income: "text-emerald-600", outcome: "text-red-600", move: "text-slate-500", accrual: "text-violet-600",
  shipment: "text-emerald-700", supply: "text-amber-700",
};
const today = () => new Date().toISOString().slice(0, 10);

export function Operations() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const categories = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();
  const legalEntities = useLegalEntities();

  const [types, setTypes] = useState<Set<OperationType>>(new Set());
  const [filters, setFilters] = useState({ date_from: "", date_to: "", status: "", amount_from: "", amount_to: "", account_id: "", category_id: "", project_id: "", counterparty_id: "", legal_entity_id: "", search: "", no_category: false, excluded: "" });
  const [editing, setEditing] = useState<Partial<Operation> | null>(null);
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const acc = searchParams.get("account_id");
    if (acc) setFilters((f) => ({ ...f, account_id: acc }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [pageSize, setPageSize] = useState(50);

  const list = useInfiniteQuery({
    queryKey: ["operations", companyId, filters, Array.from(types), pageSize],
    enabled: !!companyId,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await api.get<OperationList>("/api/operations", {
        params: {
          company_id: companyId, limit: pageSize, offset: pageParam,
          types: types.size ? Array.from(types).join(",") : undefined,
          date_from: filters.date_from || undefined, date_to: filters.date_to || undefined,
          account_id: filters.account_id || undefined, category_id: filters.category_id || undefined,
          project_id: filters.project_id || undefined, counterparty_id: filters.counterparty_id || undefined,
          legal_entity_id: filters.legal_entity_id || undefined,
          status: filters.status || undefined,
          amount_from: filters.amount_from || undefined, amount_to: filters.amount_to || undefined,
          search: filters.search || undefined, no_category: filters.no_category || undefined,
          excluded: filters.excluded === "" ? undefined : filters.excluded === "1",
        },
      })).data,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const save = useMutation({
    mutationFn: async (op: any) => op.id ? api.put(`/api/operations/${op.id}`, op) : api.post("/api/operations", op, { params: { company_id: companyId } }),
    onSuccess: () => {
      ["operations", "balances", "dashboard", "balance", "cashflow", "pnl"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/operations/${id}`),
    onSuccess: () => ["operations", "balances", "dashboard", "balance"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  const saveMovePair = useMutation({
    mutationFn: async (body: any) => api.post("/api/operations/move-pair", body, { params: { company_id: companyId } }),
    onSuccess: () => {
      ["operations", "balances", "dashboard", "balance", "cashflow", "pnl"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setEditing(null);
    },
  });

  const invalidateAll = () =>
    ["operations", "balances", "dashboard", "balance", "cashflow", "pnl"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const bulkDelete = useMutation({
    mutationFn: async (ids: number[]) => api.post("/api/operations/bulk-delete", { ids }, { params: { company_id: companyId } }),
    onSuccess: () => { invalidateAll(); setSelected(new Set()); },
  });
  const deleteAll = useMutation({
    mutationFn: async () => api.post("/api/operations/delete-all", {}, { params: { company_id: companyId } }),
    onSuccess: () => { invalidateAll(); setSelected(new Set()); },
  });
  const bulkUpdate = useMutation({
    mutationFn: async (set: any) => api.post("/api/operations/bulk-update", { ids: Array.from(selected), set }, { params: { company_id: companyId } }),
    onSuccess: () => { invalidateAll(); setSelected(new Set()); setBulkEditing(false); },
  });

  // Сбрасываем выделение при смене фильтров/типов (список меняется)
  useEffect(() => { setSelected(new Set()); }, [filters, Array.from(types).join(",")]);

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const allSelected = rows.length > 0 && rows.every((o) => selected.has(o.id));
  const toggleOne = (id: number) => {
    const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s);
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((o) => o.id)));
  };

  // Итоги по выделенным операциям (по уже загруженным строкам)
  const selectedOps = rows.filter((o) => selected.has(o.id));
  const selIncome = selectedOps.filter((o) => o.type === "income");
  const selOutcome = selectedOps.filter((o) => o.type === "outcome");
  const sumOf = (arr: Operation[]) => arr.reduce((s, o) => s + Number(o.amount), 0);
  const selIncomeSum = sumOf(selIncome);
  const selOutcomeSum = sumOf(selOutcome);

  const accName = (id?: number | null) => accounts.data?.find((a) => a.id === id)?.name ?? "—";
  const catName = (id?: number | null) => categories.data?.find((c) => c.id === id)?.name ?? "";
  const partyName = (id?: number | null) => parties.data?.find((c) => c.id === id)?.name ?? "";
  const projName = (id?: number | null) => projects.data?.find((c) => c.id === id)?.name ?? "";
  const toggleType = (t: OperationType) => {
    const s = new Set(types); s.has(t) ? s.delete(t) : s.add(t); setTypes(s);
  };

  // Быстрые (сохранённые) фильтры
  const [fname, setFname] = useState("");
  const savedFilters = useQuery({
    queryKey: ["quick-filters", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get("/api/quick-filters", { params: { company_id: companyId, scope: "operations" } })).data as any[],
  });
  const saveFilter = useMutation({
    mutationFn: () => api.post("/api/quick-filters", { name: fname, scope: "operations", params: { filters, types: Array.from(types) } }, { params: { company_id: companyId } }),
    onSuccess: () => { setFname(""); qc.invalidateQueries({ queryKey: ["quick-filters"] }); },
  });
  const delFilter = useMutation({ mutationFn: (id: number) => api.delete(`/api/quick-filters/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["quick-filters"] }) });
  const applyFilter = (f: any) => { if (f.params?.filters) setFilters({ ...filters, ...f.params.filters }); if (f.params?.types) setTypes(new Set(f.params.types)); };

  const sm = list.data?.pages[0]?.summary;

  return (
    <div className="flex gap-4">
      {/* Левая панель фильтров */}
      <aside className="w-60 shrink-0 space-y-4">
        <div className="card space-y-3">
          <h3 className="font-semibold">Фильтры</h3>
          <details className="text-sm">
            <summary className="cursor-pointer text-brand">Быстрые фильтры ({savedFilters.data?.length ?? 0})</summary>
            <div className="mt-2 space-y-1">
              {savedFilters.data?.map((f) => (
                <div key={f.id} className="flex items-center gap-1">
                  <button className="flex-1 truncate text-left text-slate-600 hover:text-brand hover:underline" onClick={() => applyFilter(f)}>{f.name}</button>
                  <button className="text-red-400 hover:text-red-600" onClick={() => delFilter.mutate(f.id)}>×</button>
                </div>
              ))}
              {savedFilters.data?.length === 0 && <div className="text-xs text-slate-400">Нет сохранённых</div>}
              <div className="flex gap-1 pt-1">
                <input className="input" placeholder="Сохранить как…" value={fname} onChange={(e) => setFname(e.target.value)} />
                <button className="btn-ghost" disabled={!fname.trim() || saveFilter.isPending} onClick={() => saveFilter.mutate()}>＋</button>
              </div>
            </div>
          </details>
          <div>
            <div className="label">Тип операции</div>
            {(Object.keys(TYPE_LABEL) as OperationType[]).map((t) => (
              <label key={t} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={types.has(t)} onChange={() => toggleType(t)} />
                {TYPE_LABEL[t]}
              </label>
            ))}
          </div>
          <div>
            <div className="label">Дата оплаты</div>
            <DatePresets className="mb-1" onSelect={(from, to) => setFilters({ ...filters, date_from: from, date_to: to })} />
            <input type="date" className="input mb-1" value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.target.value })} />
            <input type="date" className="input" value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.target.value })} />
          </div>
          <div>
            <div className="label">Статус</div>
            <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Все</option>
              <option value="committed">Проведённые (факт)</option>
              <option value="planned">Плановые</option>
            </select>
          </div>
          <div>
            <div className="label">Сумма</div>
            <div className="flex items-center gap-1">
              <input className="input" placeholder="От" value={filters.amount_from} onChange={(e) => setFilters({ ...filters, amount_from: e.target.value })} />
              <span className="text-slate-400">—</span>
              <input className="input" placeholder="до" value={filters.amount_to} onChange={(e) => setFilters({ ...filters, amount_to: e.target.value })} />
            </div>
          </div>
          {(legalEntities.data?.length ?? 0) > 0 && (
            <Sel label="Юрлицо" value={filters.legal_entity_id} onChange={(v) => setFilters({ ...filters, legal_entity_id: v })} options={legalEntities.data} />
          )}
          <Sel label="Счёт" value={filters.account_id} onChange={(v) => setFilters({ ...filters, account_id: v })} options={accounts.data} />
          <Sel label="Статья" value={filters.category_id} onChange={(v) => setFilters({ ...filters, category_id: v })} options={categories.data} />
          <label className="flex items-center gap-2 text-sm text-slate-600" title="Показать только операции без статьи (не распределённые)">
            <input type="checkbox" checked={filters.no_category} onChange={(e) => setFilters({ ...filters, no_category: e.target.checked, category_id: e.target.checked ? "" : filters.category_id })} />
            Только без статьи
          </label>
          <div>
            <div className="label">Исключённые из отчётов</div>
            <select className="input" value={filters.excluded} onChange={(e) => setFilters({ ...filters, excluded: e.target.value })}>
              <option value="">Все</option>
              <option value="1">Только исключённые</option>
              <option value="0">Без исключённых</option>
            </select>
          </div>
          <Sel label="Проект" value={filters.project_id} onChange={(v) => setFilters({ ...filters, project_id: v })} options={projects.data} />
          <Sel label="Контрагент" value={filters.counterparty_id} onChange={(v) => setFilters({ ...filters, counterparty_id: v })} options={parties.data} />
        </div>
      </aside>

      {/* Основная часть */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Операции</h1>
          <input className="input max-w-xs" placeholder="Поиск по операциям" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          <ExportButton
            url="/api/operations/export"
            params={{
              company_id: companyId,
              types: types.size ? Array.from(types).join(",") : undefined,
              date_from: filters.date_from, date_to: filters.date_to,
              account_id: filters.account_id, category_id: filters.category_id,
              project_id: filters.project_id, counterparty_id: filters.counterparty_id,
              legal_entity_id: filters.legal_entity_id, status: filters.status,
              amount_from: filters.amount_from, amount_to: filters.amount_to,
              search: filters.search,
            }}
            filename="operations.xlsx"
          />
          <button className="btn-ghost text-red-600" disabled={deleteAll.isPending || total === 0}
            onClick={() => { if (confirm(`Удалить ВСЕ операции (${total})? Действие необратимо.`)) deleteAll.mutate(); }}>
            {deleteAll.isPending ? "Удаление…" : "Удалить все"}
          </button>
          <button className="btn-primary" onClick={() => setEditing({ type: "income", status: "committed", op_date: today() })}>+ Добавить операцию</button>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand bg-brand-light px-4 py-2 text-sm">
            <span className="font-medium text-brand-dark">Выбрано: {selected.size}</span>
            <span className="text-emerald-700">{selIncome.length} поступл.: {money(selIncomeSum)}</span>
            <span className="text-red-700">{selOutcome.length} выплат: {money(selOutcomeSum)}</span>
            <span className="font-semibold">Итого: {money(selIncomeSum - selOutcomeSum)}</span>
            <span className="mx-1 h-4 w-px bg-brand/40" />
            <button className="btn-ghost" onClick={() => setBulkEditing(true)}>Изменить выбранные</button>
            <button
              className="btn-ghost text-red-600"
              disabled={bulkDelete.isPending}
              onClick={() => {
                if (confirm(`Удалить выбранные операции (${selected.size})? Парные перемещения удалятся целиком.`))
                  bulkDelete.mutate(Array.from(selected));
              }}
            >
              {bulkDelete.isPending ? "Удаление…" : "Удалить выбранные"}
            </button>
            <button className="btn-ghost ml-auto" onClick={() => setSelected(new Set())}>Снять выделение</button>
            {(bulkDelete.error || bulkUpdate.error) && (
              <span className="text-red-600">
                {(bulkDelete.error as any)?.response?.data?.detail || (bulkUpdate.error as any)?.response?.data?.detail || "Ошибка операции"}
              </span>
            )}
          </div>
        )}

        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Выделить все на странице" /></th>
                <th>Дата</th><th>Счёт</th><th>Тип</th><th>Контрагент</th><th>Статья / назначение</th><th>Проект</th><th className="text-right">Сумма</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((op) => {
                const isExcluded = op.excluded || op.items?.some((i: any) => i.excluded);
                return (
                <tr key={op.id} onClick={() => setEditing(op)}
                    className={`cursor-pointer align-middle hover:bg-slate-50 ${selected.has(op.id) ? "bg-brand-light/40" : isExcluded ? "bg-amber-50" : ""} ${isExcluded ? "border-l-2 border-amber-400" : ""}`}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(op.id)} onChange={() => toggleOne(op.id)} /></td>
                  <td className="whitespace-nowrap">{op.op_date}</td>
                  <td className="whitespace-nowrap">{op.type === "accrual" ? "—" : accName(op.account_id)}{op.type === "move" ? ` → ${accName(op.to_account_id)}` : ""}</td>
                  <td className="whitespace-nowrap">
                    <span className={TYPE_COLOR[op.type]}>{TYPE_LABEL[op.type]}</span>
                    {op.status === "planned" && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-700">план</span>}
                    {isExcluded && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-700" title="Исключена из отчётов («не учитывать»)">не учит.</span>}
                    {op.bound_move_operation_id && <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-700" title={`Парное перемещение: ${op.account_id ? "списание со счёта" : "зачисление на счёт"}`}>{op.account_id ? "↑ в пути" : "↓ в пути"}</span>}
                  </td>
                  <td><div className="max-w-[180px] truncate" title={partyName(op.counterparty_id) || ""}>{partyName(op.counterparty_id)}</div></td>
                  <td>
                    <div className="max-w-[260px] truncate">
                      {op.type === "accrual" ? `${catName(op.debit_category_id)} ← ${catName(op.credit_category_id)}` : (op.items.length ? <span className="italic text-slate-400">разбито ({op.items.length})</span> : catName(op.category_id))}
                    </div>
                    {op.description && <div className="max-w-[260px] truncate text-xs text-slate-400" title={op.description}>{op.description}</div>}
                  </td>
                  <td><div className="max-w-[110px] truncate">{projName(op.project_id)}</div></td>
                  <td className={`whitespace-nowrap text-right font-medium ${TYPE_COLOR[op.type]}`}>{op.type === "outcome" ? "−" : op.type === "income" ? "+" : ""}{money(op.amount, op.currency_code)}</td>
                  <td className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                    <button className="text-slate-500 hover:underline" title="Создать копию операции"
                      onClick={() => setEditing({ ...op, id: undefined, op_date: today(), accrual_date: undefined, bound_move_operation_id: undefined })}>копия</button>
                    <button className="ml-2 text-red-500 hover:underline" onClick={() => confirm("Удалить операцию?") && remove.mutate(op.id)}>×</button>
                  </td>
                </tr>
                );
              })}
              {list.data && rows.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-slate-400">Нет операций</td></tr>}
            </tbody>
            {sm && sm.count > 0 && (
              <tfoot>
                <tr className="border-t-2 bg-slate-50 font-medium">
                  <td colSpan={9} className="px-3 py-2 text-sm">
                    {sm.count} операций · <span className="text-emerald-600">{sm.income_count} поступлений: {money(sm.income_sum)}</span> · <span className="text-red-600">{sm.outcome_count} выплат: {money(sm.outcome_sum)}</span> · {sm.move_count} перемещений · {sm.accrual_count} начислений · <span className="font-bold">Итого: {money(sm.total)}</span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {/* Пагинация: размер страницы + показать ещё */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2 text-sm text-slate-500">
          <div className="flex items-center gap-2">
            <span>Показано {rows.length} из {total}</span>
            <span className="text-slate-300">·</span>
            <label className="flex items-center gap-1">На странице:
              <select className="input !h-8 !w-20 !py-1" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {list.hasNextPage && (
            <button className="btn-ghost" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Загрузка…" : "Показать ещё"}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <OperationModal op={editing} onClose={() => { save.reset(); saveMovePair.reset(); setEditing(null); }}
          onSave={(o) => save.mutate(o)} onSaveMovePair={(o: any) => saveMovePair.mutate(o)}
          error={save.error || saveMovePair.error}
          accounts={accounts.data ?? []} categories={categories.data ?? []} projects={projects.data ?? []} parties={parties.data ?? []} />
      )}

      {bulkEditing && (
        <BulkEditModal count={selected.size} error={bulkUpdate.error} pending={bulkUpdate.isPending}
          onClose={() => { bulkUpdate.reset(); setBulkEditing(false); }}
          onSave={(set: any) => bulkUpdate.mutate(set)}
          accounts={accounts.data ?? []} categories={categories.data ?? []} projects={projects.data ?? []} parties={parties.data ?? []} />
      )}
    </div>
  );
}

function Sel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options?: any[] }) {
  return (
    <div>
      <div className="label">{label}</div>
      <SearchSelect value={value} onChange={onChange} options={options ?? []} emptyLabel="Все" placeholder="Все" />
    </div>
  );
}

export function OperationModal({ op, onClose, onSave, onSaveMovePair, accounts, categories, projects, parties, error }: any) {
  const [f, setF] = useState<any>({
    type: op.type ?? "income", status: op.status ?? "committed",
    is_calculation_committed: op.is_calculation_committed ?? true, is_opu_calculation: op.is_opu_calculation ?? false,
    op_date: op.op_date ?? today(), accrual_date: op.accrual_date ?? op.op_date ?? today(),
    account_id: op.account_id ?? "", to_account_id: op.to_account_id ?? "",
    amount: op.amount ?? "", currency_code: op.currency_code ?? "RUB",
    category_id: op.category_id ?? "", debit_category_id: op.debit_category_id ?? "", credit_category_id: op.credit_category_id ?? "",
    project_id: op.project_id ?? "", counterparty_id: op.counterparty_id ?? "", description: op.description ?? "",
    excluded: op.excluded ?? false,
    id: op.id,
  });
  const [split, setSplit] = useState<boolean>(!!(op.items && op.items.length));
  const [items, setItems] = useState<any[]>(op.items?.length ? op.items.map((i: any) => ({ ...i })) : [{ amount: "", category_id: "", project_id: "", excluded: false }]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  // Дата оплаты: пока дату начисления не меняли вручную (она равна прежней дате оплаты
  // или пуста) — держим её синхронной с датой оплаты, чтобы не оставалась пустой.
  const setOpDate = (v: string) => setF((prev: any) => ({
    ...prev, op_date: v,
    accrual_date: (!prev.accrual_date || prev.accrual_date === prev.op_date) ? v : prev.accrual_date,
  }));

  const [distN, setDistN] = useState(12);
  // «Распределить на период»: разбить сумму на N месяцев, каждая часть признаётся в ОПиУ
  // в свой месяц (accrual_date = последний день месяца), касса остаётся в дате оплаты.
  function distribute() {
    const total = Number(f.amount) || 0;
    const n = Math.max(1, Math.min(60, Number(distN) || 1));
    if (!total) return;
    const start = new Date((f.op_date || today()).slice(0, 7) + "-01");
    const per = Math.round((total / n) * 100) / 100;
    let acc = 0;
    const parts = Array.from({ length: n }, (_, i) => {
      const last = new Date(start.getFullYear(), start.getMonth() + i + 1, 0);
      const amt = i === n - 1 ? Math.round((total - acc) * 100) / 100 : per;
      acc += amt;
      return { amount: String(amt), category_id: f.category_id || "", project_id: f.project_id || "",
               accrual_date: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`, excluded: false };
    });
    setItems(parts);
    setSplit(true);
  }

  const isMove = f.type === "move", isAccrual = f.type === "accrual";
  // Парное перемещение (деньги в пути) доступно только при создании нового move
  const canPair = isMove && !f.id && !!onSaveMovePair;
  const [paired, setPaired] = useState(false);
  const [recvDate, setRecvDate] = useState(op.op_date ?? today());
  const [recvAmount, setRecvAmount] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (canPair && paired) {
      onSaveMovePair({
        source_account_id: f.account_id ? Number(f.account_id) : null,
        to_account_id: f.to_account_id ? Number(f.to_account_id) : null,
        send_date: f.op_date,
        receive_date: recvDate || f.op_date,
        amount: String(f.amount || "0"),
        receive_amount: recvAmount ? String(recvAmount) : null,
        description: f.description || null,
        status: f.status,
      });
      return;
    }
    const payload: any = {
      type: f.type, status: f.status,
      is_calculation_committed: f.is_calculation_committed,
      is_opu_calculation: isAccrual ? f.is_opu_calculation : null,
      op_date: f.op_date, accrual_date: f.accrual_date || null,
      account_id: isAccrual ? null : (f.account_id || null),
      to_account_id: isMove ? (f.to_account_id || null) : null,
      amount: String(f.amount || "0"), currency_code: f.currency_code,
      category_id: (isMove || isAccrual || split) ? null : (f.category_id || null),
      debit_category_id: isAccrual ? (f.debit_category_id || null) : null,
      credit_category_id: isAccrual ? (f.credit_category_id || null) : null,
      project_id: f.project_id || null, counterparty_id: f.counterparty_id || null,
      description: f.description || null,
      excluded: !!f.excluded,
      items: (!isMove && !isAccrual && split) ? items.filter((i) => i.amount).map((i) => ({ amount: String(i.amount), category_id: i.category_id || null, project_id: i.project_id || null, accrual_date: i.accrual_date || null, excluded: !!i.excluded })) : [],
      id: f.id,
    };
    onSave(payload);
  }

  const TYPES: OperationType[] = ["income", "outcome", "move", "accrual"];

  return (
    <Modal title={op.id ? "Операция" : "Новая операция"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        {/* Вкладки типа */}
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {TYPES.map((t) => (
            <button type="button" key={t} onClick={() => set("type", t)}
              className={`flex-1 rounded px-2 py-1.5 text-sm ${f.type === t ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{isAccrual ? "Дата начисления" : (canPair && paired ? "Дата списания" : "Дата оплаты")}</label>
            <input type="date" className="input" value={f.op_date} onChange={(e) => setOpDate(e.target.value)} required />
          </div>
          <div>
            <label className="label">Сумма</label>
            <input type="number" step="0.01" className="input" value={f.amount} onChange={(e) => set("amount", e.target.value)} required />
          </div>

          {!isAccrual && (
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.status === "committed"} onChange={(e) => set("status", e.target.checked ? "committed" : "planned")} />
              Оплата подтверждена (факт). Снимите для плановой операции.
            </label>
          )}

          {isMove && (
            <>
              <div><label className="label">Счёт-источник</label>
                <Opt v={f.account_id} on={(v) => set("account_id", v)} list={accounts} /></div>
              <div><label className="label">Счёт-получатель</label>
                <Opt v={f.to_account_id} on={(v) => set("to_account_id", v)} list={accounts} /></div>
              {canPair && (
                <label className="col-span-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={paired} onChange={(e) => setPaired(e.target.checked)} />
                  Деньги в пути: разные даты/суммы списания и зачисления (создаст две связанные операции)
                </label>
              )}
              {canPair && paired && (
                <>
                  <div><label className="label">Дата зачисления</label>
                    <input type="date" className="input" value={recvDate} onChange={(e) => setRecvDate(e.target.value)} /></div>
                  <div><label className="label">Сумма зачисления (если отличается)</label>
                    <input type="number" step="0.01" className="input" placeholder={String(f.amount || "")}
                      value={recvAmount} onChange={(e) => setRecvAmount(e.target.value)} /></div>
                </>
              )}
            </>
          )}

          {isAccrual && (
            <>
              <div><label className="label">Статья дебета (Дт)</label>
                <Opt v={f.debit_category_id} on={(v) => set("debit_category_id", v)} list={categories} /></div>
              <div><label className="label">Статья кредита (Кт)</label>
                <Opt v={f.credit_category_id} on={(v) => set("credit_category_id", v)} list={categories} /></div>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.is_opu_calculation} onChange={(e) => set("is_opu_calculation", e.target.checked)} />
                Учитывать начисление в кассовом ОПиУ (напр. списание себестоимости, амортизация).
              </label>
            </>
          )}

          {!isMove && !isAccrual && (
            <>
              <div><label className="label">Счёт</label><Opt v={f.account_id} on={(v) => set("account_id", v)} list={accounts} /></div>
              <div>
                <label className="label">Дата начисления</label>
                <input type="date" className="input" value={f.accrual_date} onChange={(e) => set("accrual_date", e.target.value)} required />
              </div>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.is_calculation_committed} onChange={(e) => set("is_calculation_committed", e.target.checked)} />
                Начисление подтверждено (отгрузка/акт состоялись). Снимите → возникнет дебиторка/кредиторка.
              </label>
              {!split && (
                <div><label className="label">Статья</label><Opt v={f.category_id} on={(v) => set("category_id", v)} list={categories} /></div>
              )}
              <div><label className="label">Проект</label><Opt v={f.project_id} on={(v) => set("project_id", v)} list={projects} /></div>
              <div className="col-span-2"><label className="label">Контрагент</label><Opt v={f.counterparty_id} on={(v) => set("counterparty_id", v)} list={parties} /></div>
            </>
          )}

          <div className="col-span-2"><label className="label">Назначение / комментарий</label>
            <input className="input" value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
        </div>

        {/* Разбиение на части */}
        {!isMove && !isAccrual && (
          <div className="rounded-md border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
              Разбить сумму на части (по статьям/проектам)
            </label>
            {split && (
              <div className="mt-2 space-y-2">
                {items.map((it, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input type="number" step="0.01" placeholder="Сумма" className="input w-28" value={it.amount}
                      onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, amount: e.target.value } : x))} />
                    <SearchSelect className="w-full" value={it.category_id} placeholder="Статья…" options={categories}
                      onChange={(val) => setItems(items.map((x, i) => i === idx ? { ...x, category_id: val } : x))} />
                    <SearchSelect className="w-full" value={it.project_id} placeholder="Проект…" options={projects}
                      onChange={(val) => setItems(items.map((x, i) => i === idx ? { ...x, project_id: val } : x))} />
                    <input type="date" className="input !w-36" title="Дата начисления части (в каком месяце признаётся в ОПиУ)"
                      value={it.accrual_date ?? ""} onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, accrual_date: e.target.value } : x))} />
                    <label className="flex items-center gap-1 whitespace-nowrap text-xs text-slate-500" title="Не учитывать эту часть в доходах/расходах (ОПиУ)">
                      <input type="checkbox" checked={!!it.excluded} onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, excluded: e.target.checked } : x))} /> не учит.
                    </label>
                    <button type="button" className="text-red-500" onClick={() => setItems(items.filter((_, i) => i !== idx))}>×</button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-ghost" onClick={() => setItems([...items, { amount: "", category_id: "", project_id: "", accrual_date: "", excluded: false }])}>+ часть</button>
                  <span className="mx-1 text-slate-300">|</span>
                  <span className="text-xs text-slate-500">Распределить на</span>
                  <input type="number" min={1} max={60} className="input !w-16" value={distN} onChange={(e) => setDistN(Number(e.target.value))} />
                  <span className="text-xs text-slate-500">мес.</span>
                  <button type="button" className="btn-ghost text-brand" title="Разбить сумму на месяцы: каждая часть признаётся в ОПиУ в свой месяц"
                    onClick={distribute}>Распределить на период</button>
                </div>
                <div className="text-xs text-slate-500">Сумма частей должна равняться сумме операции ({f.amount || 0}). Дата части = месяц признания в ОПиУ.</div>
              </div>
            )}
          </div>
        )}

        {/* Не учитывать в доходах/расходах (ОПиУ) — для прихода/расхода без разбивки */}
        {!isMove && !isAccrual && !split && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!f.excluded} onChange={(e) => set("excluded", e.target.checked)} />
            Не учитывать в доходах/расходах (отчёт ОПиУ) — например, займы, перемещения, личные операции
          </label>
        )}

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error?.response?.data?.detail || "Не удалось сохранить операцию"}
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

function Opt({ v, on, list }: { v: any; on: (v: string) => void; list: any[] }) {
  return <SearchSelect value={v} onChange={on} options={list} />;
}

function BulkEditModal({ count, onClose, onSave, accounts, categories, projects, parties, error, pending }: any) {
  // Меняются только включённые поля; пустое значение во включённом поле = очистить (null)
  const [en, setEn] = useState<Record<string, boolean>>({});
  const [v, setV] = useState<any>({ account_id: "", category_id: "", project_id: "", counterparty_id: "", status: "committed", description: "" });
  const setVal = (k: string, val: any) => setV({ ...v, [k]: val });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const set: any = {};
    for (const k of ["account_id", "category_id", "project_id", "counterparty_id"]) {
      if (en[k]) set[k] = v[k] ? Number(v[k]) : null;
    }
    if (en.status) set.status = v.status;
    if (en.description) set.description = v.description || null;
    onSave(set);
  }

  // Плоская функция (не вложенный компонент) — иначе input терял бы фокус при вводе
  const field = (k: string, label: string, control: any) => (
    <div className="flex items-center gap-3">
      <label className="flex w-44 shrink-0 items-center gap-2 text-sm">
        <input type="checkbox" checked={!!en[k]} onChange={(e) => setEn({ ...en, [k]: e.target.checked })} />
        {label}
      </label>
      <div className={`flex-1 ${en[k] ? "" : "pointer-events-none opacity-40"}`}>{control}</div>
    </div>
  );

  const anyEnabled = Object.values(en).some(Boolean);

  return (
    <Modal title={`Массовое изменение (${count})`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-slate-500">
          Отметьте поля, которые нужно изменить у всех выбранных операций. Пустое значение во
          включённом поле очищает его. Операции в закрытом периоде менять нельзя.
        </p>
        {field("account_id", "Счёт", <Opt v={v.account_id} on={(val: string) => setVal("account_id", val)} list={accounts} />)}
        {field("category_id", "Статья", <Opt v={v.category_id} on={(val: string) => setVal("category_id", val)} list={categories} />)}
        {field("project_id", "Проект", <Opt v={v.project_id} on={(val: string) => setVal("project_id", val)} list={projects} />)}
        {field("counterparty_id", "Контрагент", <Opt v={v.counterparty_id} on={(val: string) => setVal("counterparty_id", val)} list={parties} />)}
        {field("status", "Статус", (
          <select className="input" value={v.status} onChange={(e) => setVal("status", e.target.value)}>
            <option value="committed">Факт (проведена)</option>
            <option value="planned">План</option>
          </select>
        ))}
        {field("description", "Комментарий",
          <input className="input" value={v.description} onChange={(e) => setVal("description", e.target.value)} placeholder="(пусто — очистить)" />
        )}

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {(error as any)?.response?.data?.detail || "Не удалось применить изменения"}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" disabled={!anyEnabled || pending}>{pending ? "Применение…" : "Применить ко всем"}</button>
        </div>
      </form>
    </Modal>
  );
}
