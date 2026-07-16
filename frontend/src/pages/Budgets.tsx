import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCategories, useProjects } from "../api/hooks";
import { fmtNum } from "../components/ReportControls";
import { ExportButton } from "../components/ExportButton";
import { SearchSelect } from "../components/SearchSelect";
import { Modal } from "../components/Modal";
import type { Budget, Category, PlanFactReport } from "../api/types";

// Перечисление месяцев между двумя датами → ключи "YYYY-MM-01".
function months(from: string, to: string): string[] {
  if (!from || !to) return [];
  const res: string[] = [];
  let d = new Date(from.slice(0, 7) + "-01");
  const end = new Date(to.slice(0, 7) + "-01");
  while (d <= end) {
    res.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return res;
}

const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const monthLabel = (p: string) => `${MONTHS_RU[Number(p.slice(5, 7)) - 1]} ${p.slice(2, 4)}`;
const num = (v: string | number | undefined) => Number(v || 0);

// Статьи одного вида в порядке дерева (родитель → дети), с глубиной вложенности.
function orderTree(cats: Category[]): { cat: Category; depth: number }[] {
  const ids = new Set(cats.map((c) => c.id));
  const byParent = new Map<number, Category[]>();
  const roots: Category[] = [];
  for (const c of cats) {
    if (c.parent_id && ids.has(c.parent_id)) {
      const arr = byParent.get(c.parent_id) ?? [];
      arr.push(c);
      byParent.set(c.parent_id, arr);
    } else roots.push(c);
  }
  const bySort = (a: Category, b: Category) => a.sort - b.sort || a.id - b.id;
  const out: { cat: Category; depth: number }[] = [];
  const walk = (list: Category[], depth: number) => {
    for (const c of [...list].sort(bySort)) {
      out.push({ cat: c, depth });
      const kids = byParent.get(c.id);
      if (kids) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

export function Budgets({ mode = "bdr" }: { mode?: "bdr" | "bdds" }) {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const categories = useCategories();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const title = mode === "bdr" ? "Бюджет доходов и расходов (БДР)" : "Бюджет движения денег (БДДС)";

  const budgets = useQuery({
    queryKey: ["budgets", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<Budget[]>("/api/budgets", { params: { company_id: companyId } })).data,
  });
  // Бюджеты этого типа (БДР или БДДС) — разделяем списки.
  const mine = (budgets.data ?? []).filter((b) => (b.budget_method || "bdr") === mode);

  useEffect(() => {
    if (mine.length && !mine.some((b) => b.id === selectedId)) setSelectedId(mine[0].id);
    if (!mine.length) setSelectedId(null);
  }, [budgets.data, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const budget = mine.find((b) => b.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Новый бюджет</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {mine.map((b) => (
          <button
            key={b.id}
            onClick={() => setSelectedId(b.id)}
            className={`btn ${b.id === selectedId ? "bg-brand text-white" : "btn-ghost"}`}
          >
            {b.name}
          </button>
        ))}
        {!mine.length && !budgets.isLoading && (
          <span className="text-sm text-slate-400">Ещё нет бюджетов. Создайте первый — план по статьям и месяцам.</span>
        )}
      </div>

      {budget && categories.data && (
        <BudgetGrid
          key={budget.id}
          budget={budget}
          allCategories={categories.data}
          companyId={companyId!}
          onChanged={() => { qc.invalidateQueries({ queryKey: ["budgets"] }); qc.invalidateQueries({ queryKey: ["plan-fact"] }); }}
          onDeleted={() => { setSelectedId(null); qc.invalidateQueries({ queryKey: ["budgets"] }); }}
        />
      )}

      {creating && (
        <NewBudgetModal
          mode={mode}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            const { data } = await api.post<Budget>("/api/budgets", body, { params: { company_id: companyId } });
            await qc.invalidateQueries({ queryKey: ["budgets"] });
            setSelectedId(data.id);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

type PlanState = Record<number, Record<string, string>>;

function BudgetGrid({ budget, allCategories, companyId, onChanged, onDeleted }: {
  budget: Budget; allCategories: Category[]; companyId: number; onChanged: () => void; onDeleted: () => void;
}) {
  const isBdr = (budget.budget_method || "bdr") === "bdr";
  const periods = useMemo(() => months(budget.date_from, budget.date_to), [budget.date_from, budget.date_to]);

  // Локальный редактируемый план: plan[catId][period] = сумма (строка).
  const [plan, setPlan] = useState<PlanState>({});
  const [dirty, setDirty] = useState(false);
  const [showFact, setShowFact] = useState(true);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  useEffect(() => {
    const g: PlanState = {};
    for (const it of budget.items) {
      const per = it.period.slice(0, 7) + "-01";
      (g[it.category_id] ??= {})[per] = it.amount;
    }
    setPlan(g);
    setDirty(false);
  }, [budget]);

  // Факт из план-факт отчёта (по статьям × месяцам) + остатки БДДС.
  const pf = useQuery({
    queryKey: ["plan-fact", budget.id],
    queryFn: async () => (await api.get<PlanFactReport>("/api/reports/plan-fact", { params: { company_id: companyId, budget_id: budget.id } })).data,
  });
  const factMap = useMemo(() => {
    const m: Record<number, Record<string, string>> = {};
    for (const row of pf.data?.rows ?? []) if (row.category_id != null) m[row.category_id] = row.fact_by_period;
    return m;
  }, [pf.data]);

  // Секции статей: Доходы/Поступления и Расходы/Выплаты.
  const incomeCats = useMemo(() => orderTree(allCategories.filter((c) => c.kind === "income" && !c.is_archived)), [allCategories]);
  const outcomeCats = useMemo(() => orderTree(allCategories.filter((c) => c.kind === "outcome" && !c.is_archived)), [allCategories]);

  const planOf = (catId: number, p: string) => num(plan[catId]?.[p]);
  const factOf = (catId: number, p: string) => num(factMap[catId]?.[p]);
  const setCell = (catId: number, p: string, v: string) => {
    setPlan((prev) => ({ ...prev, [catId]: { ...(prev[catId] ?? {}), [p]: v } }));
    setDirty(true);
  };

  // Суммы по секции (план/факт) за период.
  const sectionSum = (cats: { cat: Category }[], p: string, kind: "plan" | "fact") =>
    cats.reduce((s, { cat }) => s + (kind === "plan" ? planOf(cat.id, p) : factOf(cat.id, p)), 0);

  const saveBudget = useMutation({
    mutationFn: async (patch: Partial<Budget> = {}) => {
      const items: any[] = [];
      for (const [catId, byPer] of Object.entries(plan))
        for (const [per, v] of Object.entries(byPer))
          if (v && Number(v) !== 0) items.push({ category_id: Number(catId), period: per, amount: String(v) });
      return api.put(`/api/budgets/${budget.id}`, {
        name: budget.name, project_id: budget.project_id ?? null,
        date_from: budget.date_from, date_to: budget.date_to,
        budget_method: budget.budget_method || "bdr", accrual_basis: budget.accrual_basis || "cash",
        ...patch, items,
      });
    },
    onSuccess: () => { setDirty(false); onChanged(); pf.refetch(); },
  });

  const del = useMutation({
    mutationFn: async () => api.delete(`/api/budgets/${budget.id}`),
    onSuccess: onDeleted,
  });

  // Инструменты работы с колонками.
  const copyPlanToNext = (i: number) => {
    const from = periods[i], to = periods[i + 1];
    if (!to) return;
    setPlan((prev) => {
      const next = { ...prev };
      for (const catId of Object.keys(next)) {
        const v = next[Number(catId)]?.[from];
        if (v) next[Number(catId)] = { ...next[Number(catId)], [to]: v };
      }
      return next;
    });
    setDirty(true); setMenuFor(null);
  };
  const clearColumn = (p: string) => {
    setPlan((prev) => {
      const next: PlanState = {};
      for (const [catId, byPer] of Object.entries(prev)) {
        const copy = { ...byPer };
        delete copy[p];
        next[Number(catId)] = copy;
      }
      return next;
    });
    setDirty(true); setMenuFor(null);
  };
  // «Подставить суммы»: заполнить план фактическими значениями (перезаписывает план).
  const fillFromFact = () => {
    if (!window.confirm("Подставить в план фактические суммы по операциям? Текущий план будет перезаписан.")) return;
    const g: PlanState = {};
    for (const [catId, byPer] of Object.entries(factMap)) {
      const dst: Record<string, string> = {};
      for (const p of periods) { const v = num(byPer[p]); if (v) dst[p] = String(v); }
      if (Object.keys(dst).length) g[Number(catId)] = dst;
    }
    setPlan(g); setDirty(true);
  };

  // Плановый остаток БДДС считаем вживую: cash_before + накопленный план-поток.
  const cashBefore = num(pf.data?.balances?.cash_before);
  const planBalances = useMemo(() => {
    const opening: Record<string, number> = {}, closing: Record<string, number> = {};
    let run = cashBefore;
    for (const p of periods) {
      opening[p] = run;
      run += sectionSum(incomeCats, p, "plan") - sectionSum(outcomeCats, p, "plan");
      closing[p] = run;
    }
    return { opening, closing };
  }, [plan, periods, cashBefore, incomeCats, outcomeCats]); // eslint-disable-line react-hooks/exhaustive-deps

  const nSub = showFact ? 3 : 1; // подколонок на месяц

  return (
    <div className="space-y-3">
      {/* Панель инструментов */}
      <div className="card flex flex-wrap items-center gap-3">
        <div className="text-sm text-slate-500">
          {budget.date_from} — {budget.date_to}
          {budget.project_id ? " · по проекту" : ""}
        </div>
        {isBdr && (
          <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
            {(["accrual", "cash"] as const).map((m) => (
              <button key={m} onClick={() => saveBudget.mutate({ accrual_basis: m })}
                className={`rounded px-3 py-1 ${(budget.accrual_basis || "cash") === m ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
                {m === "accrual" ? "Метод начисления" : "Кассовый метод"}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showFact} onChange={(e) => setShowFact(e.target.checked)} />
          Факт и отклонение
        </label>
        <button className="btn-ghost text-sm" onClick={fillFromFact} title="Заполнить план фактическими суммами">Подставить суммы</button>
        <div className="ml-auto flex items-center gap-2">
          <ExportButton url={`/api/budgets/${budget.id}/export`} params={{ company_id: companyId }} filename={`budget_${budget.id}.xlsx`} />
          <button className="btn-ghost text-sm text-red-600" onClick={() => { if (window.confirm("Удалить бюджет?")) del.mutate(); }}>Удалить</button>
          <button className="btn-primary" onClick={() => saveBudget.mutate({})} disabled={saveBudget.isPending || !dirty}>
            {saveBudget.isPending ? "Сохранение…" : dirty ? "Сохранить план" : "Сохранено"}
          </button>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table whitespace-nowrap text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white">Статья</th>
              {periods.map((p, i) => (
                <th key={p} colSpan={nSub} className="relative border-l text-center">
                  {monthLabel(p)}
                  <button className="ml-1 text-slate-300 hover:text-slate-600" onClick={() => setMenuFor(menuFor === p ? null : p)}>⋯</button>
                  {menuFor === p && (
                    <div className="absolute right-0 top-6 z-20 w-52 rounded-md border bg-white py-1 text-left text-xs shadow-lg">
                      {i + 1 < periods.length && (
                        <button className="block w-full px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => copyPlanToNext(i)}>Скопировать план в следующий месяц</button>
                      )}
                      <button className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-slate-50" onClick={() => clearColumn(p)}>Очистить колонку</button>
                    </div>
                  )}
                </th>
              ))}
              <th colSpan={showFact ? 4 : 1} className="border-l text-center">Итого</th>
            </tr>
            {showFact && (
              <tr className="text-xs text-slate-400">
                <th className="sticky left-0 z-10 bg-white"></th>
                {periods.flatMap((p) => [
                  <th key={p + "p"} className="border-l text-right font-normal">план</th>,
                  <th key={p + "f"} className="text-right font-normal">факт</th>,
                  <th key={p + "d"} className="text-right font-normal">откл.</th>,
                ])}
                <th className="border-l text-right font-normal">план</th>
                <th className="text-right font-normal">факт</th>
                <th className="text-right font-normal">откл.</th>
                <th className="text-right font-normal">вып.%</th>
              </tr>
            )}
          </thead>
          <tbody>
            <Section title={isBdr ? "Доходы" : "Поступления"} color="text-emerald-700" cats={incomeCats}
              periods={periods} showFact={showFact} planOf={planOf} factOf={factOf} setCell={setCell} kind="income" />
            <Section title={isBdr ? "Расходы" : "Выплаты"} color="text-red-700" cats={outcomeCats}
              periods={periods} showFact={showFact} planOf={planOf} factOf={factOf} setCell={setCell} kind="outcome" />

            {isBdr ? (
              <TotalRow label="Прибыль" bold periods={periods} showFact={showFact}
                plan={(p) => sectionSum(incomeCats, p, "plan") - sectionSum(outcomeCats, p, "plan")}
                fact={(p) => sectionSum(incomeCats, p, "fact") - sectionSum(outcomeCats, p, "fact")} />
            ) : (
              <>
                <TotalRow label="Денежный поток" bold periods={periods} showFact={showFact}
                  plan={(p) => sectionSum(incomeCats, p, "plan") - sectionSum(outcomeCats, p, "plan")}
                  fact={(p) => sectionSum(incomeCats, p, "fact") - sectionSum(outcomeCats, p, "fact")} />
                <TotalRow label="Остаток на начало" periods={periods} showFact={showFact}
                  plan={(p) => planBalances.opening[p]}
                  fact={(p) => num(pf.data?.balances?.opening_fact_by_period?.[p])} noDev />
                <TotalRow label="Остаток на конец" bold periods={periods} showFact={showFact}
                  plan={(p) => planBalances.closing[p]}
                  fact={(p) => num(pf.data?.balances?.closing_fact_by_period?.[p])} noDev />
              </>
            )}
          </tbody>
        </table>
      </div>
      {!isBdr && (
        <p className="text-xs text-slate-400">
          Остаток на начало первого месяца = деньги на счетах до периода. Плановый остаток пересчитывается на лету при вводе плана.
        </p>
      )}
    </div>
  );
}

// Секция статей (Доходы/Расходы) с редактируемым планом и фактом.
function Section({ title, color, cats, periods, showFact, planOf, factOf, setCell, kind }: {
  title: string; color: string; cats: { cat: Category; depth: number }[]; periods: string[]; showFact: boolean;
  planOf: (c: number, p: string) => number; factOf: (c: number, p: string) => number;
  setCell: (c: number, p: string, v: string) => void; kind: "income" | "outcome";
}) {
  const secPlan = (p: string) => cats.reduce((s, { cat }) => s + planOf(cat.id, p), 0);
  const secFact = (p: string) => cats.reduce((s, { cat }) => s + factOf(cat.id, p), 0);
  const planTot = periods.reduce((s, p) => s + secPlan(p), 0);
  const factTot = periods.reduce((s, p) => s + secFact(p), 0);
  const nSub = showFact ? 3 : 1;
  return (
    <>
      <tr className={`bg-slate-50 font-semibold ${color}`}>
        <td className="sticky left-0 z-10 bg-slate-50">{title}</td>
        {periods.map((p) => (
          <MonoCell key={p} showFact={showFact} plan={secPlan(p)} fact={secFact(p)} kind={kind} bold />
        ))}
        <TotalCells showFact={showFact} plan={planTot} fact={factTot} kind={kind} bold />
      </tr>
      {cats.map(({ cat, depth }) => {
        const pTot = periods.reduce((s, p) => s + planOf(cat.id, p), 0);
        const fTot = periods.reduce((s, p) => s + factOf(cat.id, p), 0);
        return (
          <tr key={cat.id} className="hover:bg-slate-50">
            <td className="sticky left-0 z-10 bg-white" style={{ paddingLeft: depth * 16 + 8 }}>{cat.name}</td>
            {periods.map((p) => (
              <td key={p} colSpan={nSub} className="border-l p-0">
                <div className="flex items-stretch">
                  <input
                    className="w-20 border-0 bg-transparent px-1 py-1 text-right text-sm outline-none focus:bg-brand-light/40"
                    type="number" value={planOf(cat.id, p) || ""} placeholder="0"
                    onChange={(e) => setCell(cat.id, p, e.target.value)}
                  />
                  {showFact && (
                    <>
                      <span className="w-20 px-1 py-1 text-right text-slate-500">{fmtNum(factOf(cat.id, p))}</span>
                      <DevCell plan={planOf(cat.id, p)} fact={factOf(cat.id, p)} kind={kind} />
                    </>
                  )}
                </div>
              </td>
            ))}
            <TotalCells showFact={showFact} plan={pTot} fact={fTot} kind={kind} />
          </tr>
        );
      })}
    </>
  );
}

// Ячейка «план [факт откл]» для итоговых строк (не редактируемая).
function MonoCell({ showFact, plan, fact, kind, bold }: { showFact: boolean; plan: number; fact: number; kind?: "income" | "outcome"; bold?: boolean }) {
  const nSub = showFact ? 3 : 1;
  return (
    <td colSpan={nSub} className="border-l p-0">
      <div className="flex">
        <span className={`w-20 px-1 py-1 text-right ${bold ? "font-semibold" : ""}`}>{fmtNum(plan)}</span>
        {showFact && (
          <>
            <span className="w-20 px-1 py-1 text-right text-slate-500">{fmtNum(fact)}</span>
            <DevCell plan={plan} fact={fact} kind={kind} />
          </>
        )}
      </div>
    </td>
  );
}

// Отклонение факт−план с цветом: для доходов рост = хорошо (зелёный), для расходов = плохо (красный).
function DevCell({ plan, fact, kind }: { plan: number; fact: number; kind?: "income" | "outcome" }) {
  const dev = fact - plan;
  let cls = "text-slate-400";
  if (dev !== 0 && kind) {
    const good = kind === "income" ? dev > 0 : dev < 0;
    cls = good ? "text-emerald-600" : "text-red-600";
  }
  return <span className={`w-20 px-1 py-1 text-right ${cls}`}>{dev === 0 ? "—" : (dev > 0 ? "+" : "") + fmtNum(dev)}</span>;
}

// Итоговый блок (Итого): план [факт откл вып%].
function TotalCells({ showFact, plan, fact, kind, bold }: { showFact: boolean; plan: number; fact: number; kind?: "income" | "outcome"; bold?: boolean }) {
  const exec = plan ? Math.round((fact / plan) * 100) : null;
  return (
    <>
      <td className={`border-l px-2 text-right ${bold ? "font-semibold" : ""}`}>{fmtNum(plan)}</td>
      {showFact && (
        <>
          <td className="px-2 text-right text-slate-500">{fmtNum(fact)}</td>
          <td className="px-2 text-right"><DevInline plan={plan} fact={fact} kind={kind} /></td>
          <td className="px-2 text-right text-slate-500">{exec == null ? "—" : exec + "%"}</td>
        </>
      )}
    </>
  );
}

function DevInline({ plan, fact, kind }: { plan: number; fact: number; kind?: "income" | "outcome" }) {
  const dev = fact - plan;
  let cls = "text-slate-400";
  if (dev !== 0 && kind) cls = (kind === "income" ? dev > 0 : dev < 0) ? "text-emerald-600" : "text-red-600";
  return <span className={cls}>{dev === 0 ? "—" : (dev > 0 ? "+" : "") + fmtNum(dev)}</span>;
}

// Итоговая строка (Прибыль/Поток/Остатки) — вычисляемые план и факт по периодам.
function TotalRow({ label, periods, showFact, plan, fact, bold, noDev }: {
  label: string; periods: string[]; showFact: boolean; plan: (p: string) => number; fact: (p: string) => number; bold?: boolean; noDev?: boolean;
}) {
  const planTot = periods.reduce((s, p) => s + plan(p), 0);
  const factTot = periods.reduce((s, p) => s + fact(p), 0);
  const nSub = showFact ? 3 : 1;
  return (
    <tr className={`border-t bg-brand-light/40 ${bold ? "font-bold" : "font-medium"}`}>
      <td className="sticky left-0 z-10 bg-brand-light/40">{label}</td>
      {periods.map((p) => (
        <td key={p} colSpan={nSub} className="border-l p-0">
          <div className="flex">
            <span className="w-20 px-1 py-1 text-right">{fmtNum(plan(p))}</span>
            {showFact && (
              <>
                <span className="w-20 px-1 py-1 text-right text-slate-500">{fmtNum(fact(p))}</span>
                <span className="w-20 px-1 py-1 text-right text-slate-400">{noDev ? "" : (fact(p) - plan(p) === 0 ? "—" : fmtNum(fact(p) - plan(p)))}</span>
              </>
            )}
          </div>
        </td>
      ))}
      <td className="border-l px-2 text-right">{fmtNum(planTot)}</td>
      {showFact && (
        <>
          <td className="px-2 text-right text-slate-500">{fmtNum(factTot)}</td>
          <td className="px-2 text-right text-slate-400">{noDev ? "" : fmtNum(factTot - planTot)}</td>
          <td className="px-2 text-right text-slate-400">{!noDev && planTot ? Math.round((factTot / planTot) * 100) + "%" : ""}</td>
        </>
      )}
    </tr>
  );
}

function NewBudgetModal({ mode, onClose, onCreate }: { mode: "bdr" | "bdds"; onClose: () => void; onCreate: (b: any) => void }) {
  const year = new Date().getFullYear();
  const projects = useProjects();
  const [form, setForm] = useState({
    name: `${mode === "bdr" ? "БДР" : "БДДС"} ${year}`,
    date_from: `${year}-01-01`, date_to: `${year}-12-31`,
    project_id: "", accrual_basis: "cash" as "cash" | "accrual",
  });
  return (
    <Modal title={`Новый бюджет · ${mode === "bdr" ? "доходы и расходы" : "движение денег"}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({
            name: form.name, date_from: form.date_from, date_to: form.date_to,
            project_id: form.project_id ? Number(form.project_id) : null,
            budget_method: mode, accrual_basis: mode === "bdr" ? form.accrual_basis : "cash",
            items: [],
          });
        }}
        className="space-y-3"
      >
        <div>
          <label className="label">Название</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">С даты</label>
            <input type="date" className="input" value={form.date_from} onChange={(e) => setForm({ ...form, date_from: e.target.value })} required />
          </div>
          <div>
            <label className="label">По дату</label>
            <input type="date" className="input" value={form.date_to} onChange={(e) => setForm({ ...form, date_to: e.target.value })} required />
          </div>
        </div>
        <div>
          <label className="label">Проект (необязательно)</label>
          <SearchSelect value={form.project_id} onChange={(val) => setForm({ ...form, project_id: val })}
            options={(projects.data ?? []).filter((p) => !p.is_archived)} emptyLabel="Весь бизнес" placeholder="Весь бизнес" />
        </div>
        {mode === "bdr" && (
          <div>
            <label className="label">Метод учёта факта</label>
            <select className="input" value={form.accrual_basis} onChange={(e) => setForm({ ...form, accrual_basis: e.target.value as any })}>
              <option value="cash">Кассовый (по дате оплаты)</option>
              <option value="accrual">Начисления (по дате начисления)</option>
            </select>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
