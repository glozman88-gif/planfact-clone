import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCategories } from "../api/hooks";
import { fmtNum } from "../components/ReportControls";
import { Modal } from "../components/Modal";
import type { Budget, PlanFactReport } from "../api/types";

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

export function Budgets({ mode = "bdr" }: { mode?: "bdr" | "bdds" }) {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const categories = useCategories();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // БДР — только доходы/расходы; БДДС — все статьи (движение денег по всем разделам).
  const budgetCats = (categories.data ?? []).filter((c) =>
    mode === "bdr" ? c.kind === "income" || c.kind === "outcome" : true
  );
  const title = mode === "bdr" ? "Бюджет доходов и расходов (БДР)" : "Бюджет движения денег (БДДС)";

  const budgets = useQuery({
    queryKey: ["budgets", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<Budget[]>("/api/budgets", { params: { company_id: companyId } })).data,
  });

  useEffect(() => {
    if (!selectedId && budgets.data?.length) setSelectedId(budgets.data[0].id);
  }, [budgets.data, selectedId]);

  const budget = budgets.data?.find((b) => b.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Новый бюджет</button>
      </div>

      <div className="flex flex-wrap gap-2">
        {budgets.data?.map((b) => (
          <button
            key={b.id}
            onClick={() => setSelectedId(b.id)}
            className={`btn ${b.id === selectedId ? "bg-brand text-white" : "btn-ghost"}`}
          >
            {b.name}
          </button>
        ))}
      </div>

      {budget && categories.data && (
        <BudgetEditor
          budget={budget}
          categories={budgetCats}
          onSaved={() => qc.invalidateQueries({ queryKey: ["budgets"] })}
        />
      )}

      {budget && <PlanFact companyId={companyId!} budgetId={budget.id} />}

      {creating && (
        <NewBudgetModal
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

function BudgetEditor({ budget, categories, onSaved }: { budget: Budget; categories: any[]; onSaved: () => void }) {
  const periods = useMemo(() => months(budget.date_from, budget.date_to), [budget]);
  // grid[categoryId][period] = amount
  const [grid, setGrid] = useState<Record<number, Record<string, string>>>({});

  useEffect(() => {
    const g: Record<number, Record<string, string>> = {};
    for (const it of budget.items) {
      const per = it.period.slice(0, 7) + "-01";
      g[it.category_id] = g[it.category_id] ?? {};
      g[it.category_id][per] = it.amount;
    }
    setGrid(g);
  }, [budget]);

  const setCell = (catId: number, per: string, v: string) =>
    setGrid((prev) => ({ ...prev, [catId]: { ...(prev[catId] ?? {}), [per]: v } }));

  const save = useMutation({
    mutationFn: async () => {
      const items: any[] = [];
      for (const cat of categories) {
        for (const per of periods) {
          const v = grid[cat.id]?.[per];
          if (v && Number(v) !== 0) items.push({ category_id: cat.id, period: per, amount: String(v) });
        }
      }
      return api.put(`/api/budgets/${budget.id}`, {
        name: budget.name,
        project_id: budget.project_id,
        date_from: budget.date_from,
        date_to: budget.date_to,
        items,
      });
    },
    onSuccess: onSaved,
  });

  return (
    <div className="card overflow-x-auto">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">План по статьям: {budget.name}</h2>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Сохранение…" : "Сохранить план"}
        </button>
      </div>
      <table className="table whitespace-nowrap">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white">Статья</th>
            {periods.map((p) => <th key={p} className="text-right">{p.slice(0, 7)}</th>)}
          </tr>
        </thead>
        <tbody>
          {categories.map((cat) => (
            <tr key={cat.id}>
              <td className="sticky left-0 bg-white">
                <span className={cat.kind === "income" ? "text-emerald-700" : "text-red-700"}>{cat.name}</span>
              </td>
              {periods.map((p) => (
                <td key={p} className="text-right">
                  <input
                    className="input w-24 text-right"
                    type="number"
                    value={grid[cat.id]?.[p] ?? ""}
                    onChange={(e) => setCell(cat.id, p, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanFact({ companyId, budgetId }: { companyId: number; budgetId: number }) {
  const q = useQuery({
    queryKey: ["plan-fact", budgetId],
    queryFn: async () =>
      (await api.get<PlanFactReport>("/api/reports/plan-fact", { params: { company_id: companyId, budget_id: budgetId } })).data,
  });
  const r = q.data;
  if (!r) return null;

  return (
    <div className="card overflow-x-auto">
      <h2 className="mb-2 font-semibold">Сравнение план / факт</h2>
      <table className="table whitespace-nowrap">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white">Статья</th>
            <th className="text-right">План</th>
            <th className="text-right">Факт</th>
            <th className="text-right">Отклонение</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => {
            const dev = Number(row.deviation);
            return (
              <tr key={row.category_id ?? "none"}>
                <td className="sticky left-0 bg-white">{row.name}</td>
                <td className="text-right">{fmtNum(row.plan_total)}</td>
                <td className="text-right">{fmtNum(row.fact_total)}</td>
                <td className={`text-right ${dev < 0 ? "text-red-600" : dev > 0 ? "text-emerald-600" : ""}`}>
                  {fmtNum(row.deviation)}
                </td>
              </tr>
            );
          })}
          {r.rows.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-slate-400">Нет данных</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function NewBudgetModal({ onClose, onCreate }: { onClose: () => void; onCreate: (b: any) => void }) {
  const year = new Date().getFullYear();
  const [form, setForm] = useState({ name: `Бюджет ${year}`, date_from: `${year}-01-01`, date_to: `${year}-12-31` });
  return (
    <Modal title="Новый бюджет" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onCreate({ ...form, items: [] }); }} className="space-y-3">
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
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
