import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useLegalEntities, useProjects } from "../api/hooks";
import { RangePicker, defaultRange, fmtNum, type Range } from "../components/ReportControls";
import { ExportButton } from "../components/ExportButton";
import { Sparkline } from "../components/Sparkline";
import { OperationModal } from "./Operations";
import type { PnlReport, ReportSection, ReportCategory, PnlOperation, Operation } from "../api/types";

const vals = (m: Record<string, string>, periods: string[]) => periods.map((p) => Number(m[p] || 0));

export function Pnl() {
  const { companyId } = useApp();
  const [range, setRange] = useState<Range>(defaultRange());
  const [method, setMethod] = useState<"accrual" | "cash">("accrual");
  const [groupBy, setGroupBy] = useState<"category" | "project" | "deal">("category");
  const [withPlan, setWithPlan] = useState(false);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [legalEntityId, setLegalEntityId] = useState("");

  const qc = useQueryClient();
  const accounts = useAccounts();
  const categories = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();
  const legalEntities = useLegalEntities();
  const [editId, setEditId] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["pnl", companyId, range, method, groupBy, withPlan, legalEntityId, includeExcluded],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<PnlReport>("/api/reports/pnl", { params: { company_id: companyId, method, group_by: groupBy, with_plan: withPlan, legal_entity_id: legalEntityId || undefined, include_excluded: includeExcluded, ...range } })).data,
  });
  const r = q.data;

  // Загрузка операции для редактирования (из детализации статьи)
  const editOp = useQuery({
    queryKey: ["operation", editId],
    enabled: editId != null,
    queryFn: async () => (await api.get<Operation>(`/api/operations/${editId}`)).data,
  });
  const save = useMutation({
    mutationFn: async (op: any) => api.put(`/api/operations/${op.id}`, op),
    onSuccess: () => {
      ["pnl", "pnl-ops", "operations", "balance", "cashflow", "dashboard", "balances"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setEditId(null);
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Отчёт о прибылях и убытках</h1>
      <div className="flex flex-wrap items-center gap-3">
        <RangePicker range={range} onChange={setRange} />
        <div className="card flex gap-1 p-1">
          {([["accrual", "Метод начисления"], ["cash", "Кассовый метод"]] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setMethod(k)}
              className={`rounded-md px-3 py-1.5 text-sm ${method === k ? "bg-brand-light font-medium text-brand-dark ring-1 ring-brand" : "text-slate-600"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="card flex gap-1 p-1">
          {([["category", "По статьям"], ["project", "По проектам"], ["deal", "По сделкам"]] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setGroupBy(k)}
              className={`rounded-md px-3 py-1.5 text-sm ${groupBy === k ? "bg-brand-light font-medium text-brand-dark ring-1 ring-brand" : "text-slate-600"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <label className="card flex items-center gap-2 px-3 py-2 text-sm">
          <input type="checkbox" checked={withPlan} onChange={(e) => setWithPlan(e.target.checked)} />
          План + Факт
        </label>
        <label className="card flex items-center gap-2 px-3 py-2 text-sm" title="Показать отчёт с учётом операций, помеченных «не учитывать в отчёте»">
          <input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />
          С исключёнными
        </label>
        {(legalEntities.data?.length ?? 0) > 0 && (
          <select className="input !w-48" value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
            <option value="">Все юрлица</option>
            {legalEntities.data?.map((le) => <option key={le.id} value={le.id}>{le.name}</option>)}
          </select>
        )}
        <div className="ml-auto">
          <ExportButton
            url="/api/reports/pnl/export"
            params={{ company_id: companyId, method, legal_entity_id: legalEntityId || undefined, include_excluded: includeExcluded, ...range }}
            filename={`pnl_${range.date_from}_${range.date_to}.xlsx`}
          />
        </div>
      </div>

      {r && r.groups && (
        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white">{groupBy === "project" ? "Проект" : "Сделка"}</th>
                <th className="text-right">Доходы</th>
                <th className="text-right">Расходы</th>
                <th className="text-right">Прибыль</th>
                <th className="text-right">Рентаб., %</th>
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g) => (
                <tr key={g.key ?? "none"}>
                  <td className="sticky left-0 bg-white">{g.name}</td>
                  <td className="text-right text-emerald-700">{fmtNum(g.income)}</td>
                  <td className="text-right text-red-700">{fmtNum(g.outcome)}</td>
                  <td className={`text-right font-medium ${Number(g.profit) < 0 ? "text-red-600" : ""}`}>{fmtNum(g.profit)}</td>
                  <td className="text-right">{g.margin == null ? "—" : g.margin + "%"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r && !r.groups && (
        <>
        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white">По статьям учёта</th>
                <th className="text-center">Тренд</th>
                {r.periods.map((p) => <th key={p} className="text-right">{p}</th>)}
                <th className="text-right">Итого</th>
              </tr>
            </thead>
            <tbody>
              <Section title="Доходы" section={r.income} periods={r.periods} color="text-emerald-700" ctx={{ companyId, range, method, includeExcluded, onEditOp: setEditId }} />
              <Section title="Расходы" section={r.outcome} periods={r.periods} color="text-red-700" ctx={{ companyId, range, method, includeExcluded, onEditOp: setEditId }} />
              <tr className="bg-brand-light font-bold">
                <td className="sticky left-0 bg-brand-light">Чистая прибыль</td>
                <td className="text-center"><Sparkline values={vals(r.profit_by_period, r.periods)} /></td>
                {r.periods.map((p) => <td key={p} className="text-right">{fmtNum(r.profit_by_period[p])}</td>)}
                <td className="text-right">{fmtNum(r.profit_total)}</td>
              </tr>
              <tr className="font-medium text-slate-600">
                <td className="sticky left-0 bg-white">Рентабельность, %</td>
                <td></td>
                {r.periods.map((p) => <td key={p}></td>)}
                <td className="text-right">{r.margin == null ? "—" : r.margin + "%"}</td>
              </tr>
              {r.plan && (
                <>
                  <tr className="text-slate-500">
                    <td className="sticky left-0 bg-white">Прибыль (план)</td>
                    <td className="text-center"><Sparkline values={vals(r.plan.profit_by_period, r.periods)} /></td>
                    {r.periods.map((p) => <td key={p} className="text-right">{fmtNum(r.plan!.profit_by_period[p])}</td>)}
                    <td className="text-right">{fmtNum(r.plan.profit_total)}</td>
                  </tr>
                  <tr className="text-slate-500">
                    <td className="sticky left-0 bg-white">Выполнение плана, %</td>
                    <td></td>
                    {r.periods.map((p) => <td key={p}></td>)}
                    <td className="text-right">
                      {Number(r.plan.profit_total) ? ((Number(r.profit_total) / Number(r.plan.profit_total)) * 100).toFixed(0) + "%" : "—"}
                    </td>
                  </tr>
                </>
              )}
              <tr className="text-slate-600">
                <td className="sticky left-0 bg-white">Дивиденды</td>
                <td className="text-center"><Sparkline values={vals(r.dividends_by_period, r.periods)} /></td>
                {r.periods.map((p) => <td key={p} className="text-right">{fmtNum(r.dividends_by_period[p])}</td>)}
                <td className="text-right">{fmtNum(r.dividends_total)}</td>
              </tr>
              <tr className="font-semibold">
                <td className="sticky left-0 bg-white">Нераспределённая прибыль</td>
                <td className="text-center"><Sparkline values={vals(r.retained_by_period, r.periods)} /></td>
                {r.periods.map((p) => <td key={p} className="text-right">{fmtNum(r.retained_by_period[p])}</td>)}
                <td className="text-right">{fmtNum(r.retained_total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {r.metrics && <MetricsPanel m={r.metrics} />}
        </>
      )}

      {editId != null && editOp.data && (
        <OperationModal
          op={editOp.data}
          accounts={accounts.data} categories={categories.data}
          projects={projects.data} parties={parties.data}
          error={save.error}
          onClose={() => { save.reset(); setEditId(null); }}
          onSave={(op: any) => save.mutate(op)}
        />
      )}
    </div>
  );
}

function MetricsPanel({ m }: { m: Record<string, string> }) {
  const rows: [string, string, boolean][] = [
    ["Выручка", m.revenue, false],
    ["Прямые расходы", m.direct_costs, false],
    ["Валовая прибыль", m.gross_profit, true],
    ["Косвенные расходы", m.indirect_costs, false],
    ["Операционная прибыль", m.operating_profit, true],
    ["EBITDA", m.ebitda, true],
    ["Амортизация", m.depreciation, false],
    ["EBIT", m.ebit, true],
    ["Проценты по кредитам", m.interest, false],
    ["EBT (прибыль до налога)", m.ebt, true],
  ];
  return (
    <div className="card">
      <h2 className="mb-2 text-sm font-bold text-slate-700">Показатели прибыли</h2>
      <table className="table">
        <tbody>
          {rows.map(([label, val, bold]) => (
            <tr key={label} className={bold ? "font-semibold" : "text-slate-500"}>
              <td>{label}</td>
              <td className="text-right">{fmtNum(val)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Ctx = { companyId: number | null; range: Range; method: string; includeExcluded: boolean; onEditOp: (id: number) => void };

function Section({ title, section, periods, color, ctx }:
  { title: string; section: ReportSection; periods: string[]; color: string; ctx: Ctx }) {
  return (
    <>
      <tr className={`font-semibold ${color}`}>
        <td className="sticky left-0 bg-white">{title}</td>
        <td className="text-center"><Sparkline values={vals(section.by_period, periods)} /></td>
        {periods.map((p) => <td key={p} className="text-right">{fmtNum(section.by_period[p])}</td>)}
        <td className="text-right">{fmtNum(section.total)}</td>
      </tr>
      {section.categories.map((c) => (
        <CategoryRow key={c.category_id ?? "none"} cat={c} depth={1} periods={periods} ctx={ctx} />
      ))}
    </>
  );
}

function CategoryRow({ cat, depth, periods, ctx }:
  { cat: ReportCategory; depth: number; periods: string[]; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const hasChildren = (cat.children?.length ?? 0) > 0;
  const expandable = hasChildren || !!cat.has_operations;

  const ops = useQuery({
    queryKey: ["pnl-ops", ctx.companyId, cat.category_id, ctx.method, ctx.range, ctx.includeExcluded],
    enabled: open && !hasChildren && !!cat.has_operations,
    queryFn: async () => (await api.get<PnlOperation[]>("/api/reports/pnl-operations", {
      params: {
        company_id: ctx.companyId, method: ctx.method, include_excluded: ctx.includeExcluded, ...ctx.range,
        ...(cat.category_id != null ? { category_id: cat.category_id } : {}),
      },
    })).data,
  });

  return (
    <>
      <tr className="text-slate-600 hover:bg-slate-50">
        <td className="sticky left-0 bg-white" style={{ paddingLeft: depth * 18 + 8 }}>
          {expandable ? (
            <button className="mr-1 inline-block w-4 text-slate-400" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</button>
          ) : <span className="mr-1 inline-block w-4" />}
          {cat.name}
        </td>
        <td></td>
        {periods.map((p) => <td key={p} className="text-right">{fmtNum(cat.by_period[p])}</td>)}
        <td className="text-right font-medium">{fmtNum(cat.total)}</td>
      </tr>
      {open && hasChildren && cat.children!.map((ch) => (
        <CategoryRow key={ch.category_id ?? "none"} cat={ch} depth={depth + 1} periods={periods} ctx={ctx} />
      ))}
      {open && !hasChildren && (ops.data ?? []).map((o) => (
        <tr key={o.operation_id} className="cursor-pointer text-xs text-slate-500 hover:bg-brand-light/40"
            title="Открыть операцию для редактирования" onClick={() => ctx.onEditOp(o.operation_id)}>
          <td className="sticky left-0 bg-white" style={{ paddingLeft: (depth + 1) * 18 + 8 }}>
            <span className="text-slate-400">✎ {o.date}</span>
            {" · "}{o.description || o.counterparty || o.project || "операция"}
            {o.project ? <span className="ml-1 rounded bg-slate-100 px-1">{o.project}</span> : null}
            {o.excluded ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-700" title="Помечена «не учитывать в отчёте»">не учитывать</span> : null}
          </td>
          <td></td>
          {periods.map((p) => (
            <td key={p} className="text-right tabular-nums">{p === o.date.slice(0, 7) ? fmtNum(o.amount) : ""}</td>
          ))}
          <td className="text-right tabular-nums font-medium text-slate-600">{fmtNum(o.amount)}</td>
        </tr>
      ))}
      {open && !hasChildren && ops.isLoading && (
        <tr className="text-xs text-slate-400"><td className="sticky left-0 bg-white" style={{ paddingLeft: (depth + 1) * 18 + 8 }}>загрузка операций…</td></tr>
      )}
    </>
  );
}
