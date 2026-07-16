import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCategories, useCounterparties, useProjects } from "../api/hooks";
import { Modal } from "../components/Modal";
import { SearchSelect } from "../components/SearchSelect";

interface Cond { param: string; op: string; value: string }
interface Actions { category_id?: number | null; project_id?: number | null; counterparty_id?: number | null }
interface Rule {
  id: number; name: string; scope: string; op_type: string | null;
  active: boolean; priority: number; conditions: Cond[]; actions: Actions;
}

const PARAMS = [["counterparty", "Контрагент"], ["description", "Назначение"], ["account", "Счёт"], ["amount", "Сумма"]] as const;
const OPS = [["contains", "содержит"], ["not_contains", "не содержит"], ["equals", "равно"], ["starts_with", "начинается с"], ["gt", "больше"], ["lt", "меньше"]] as const;
const OP_TYPES = [["", "любая"], ["income", "поступление"], ["outcome", "выплата"]] as const;
const label = (arr: readonly (readonly [string, string])[], k: string) => arr.find(([v]) => v === k)?.[1] ?? k;

export function ImportRules() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const cats = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();

  const rules = useQuery({
    queryKey: ["dist-rules", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<Rule[]>("/api/distribution-rules", { params: { company_id: companyId } })).data,
  });

  const save = useMutation({
    mutationFn: async (r: Partial<Rule>) => {
      const body = {
        name: r.name ?? "", scope: "bank", op_type: r.op_type || null,
        active: r.active ?? true, priority: r.priority ?? 100,
        conditions: (r.conditions ?? []).filter((c) => c.value !== "" || c.op === "equals"),
        actions: r.actions ?? {},
      };
      if (r.id) return api.put(`/api/distribution-rules/${r.id}`, body);
      return api.post("/api/distribution-rules", body, { params: { company_id: companyId } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dist-rules"] }); setEditing(null); },
  });
  const toggle = useMutation({
    mutationFn: async (r: Rule) => api.put(`/api/distribution-rules/${r.id}`, { ...r, active: !r.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dist-rules"] }),
  });
  const del = useMutation({
    mutationFn: async (id: number) => api.delete(`/api/distribution-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dist-rules"] }),
  });

  const catName = (id?: number | null) => cats.data?.find((c) => c.id === id)?.name;
  const projName = (id?: number | null) => projects.data?.find((p) => p.id === id)?.name;
  const partyName = (id?: number | null) => parties.data?.find((p) => p.id === id)?.name;

  const actionsSummary = (a: Actions) => [
    a.category_id ? `статья: ${catName(a.category_id)}` : null,
    a.project_id ? `проект: ${projName(a.project_id)}` : null,
    a.counterparty_id ? `контрагент: ${partyName(a.counterparty_id)}` : null,
  ].filter(Boolean).join(", ") || "—";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Правила распределения</h1>
          <p className="text-sm text-slate-500">Автоматически проставляют статью, проект и контрагента при загрузке операций (банк и импорт файла) — по условиям на назначение, контрагента, счёт или сумму.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing({ conditions: [{ param: "description", op: "contains", value: "" }], actions: {}, active: true, priority: 100, op_type: "" })}>+ Правило</button>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table whitespace-nowrap">
          <thead>
            <tr>
              <th className="w-16 text-center">Приоритет</th>
              <th>Название</th>
              <th>Условия</th>
              <th>Тип</th>
              <th>Действия (что проставить)</th>
              <th className="text-center">Вкл.</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(rules.data ?? []).map((r) => (
              <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                <td className="text-center tabular-nums">{r.priority}</td>
                <td className="font-medium">{r.name}</td>
                <td className="text-sm text-slate-600">
                  {r.conditions.map((c, i) => <div key={i}>{label(PARAMS, c.param)} {label(OPS, c.op)} «{c.value}»</div>)}
                </td>
                <td className="text-sm text-slate-500">{label(OP_TYPES, r.op_type ?? "")}</td>
                <td className="text-sm text-slate-600">{actionsSummary(r.actions)}</td>
                <td className="text-center">
                  <input type="checkbox" checked={r.active} onChange={() => toggle.mutate(r)} />
                </td>
                <td className="whitespace-nowrap text-right">
                  <button className="text-brand hover:underline" onClick={() => setEditing(r)}>ред.</button>
                  <button className="ml-2 text-red-500 hover:underline" onClick={() => { if (window.confirm("Удалить правило?")) del.mutate(r.id); }}>×</button>
                </td>
              </tr>
            ))}
            {rules.data?.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-slate-400">Правил ещё нет. Создайте первое.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          error={save.error}
          cats={cats.data ?? []} projects={projects.data ?? []} parties={parties.data ?? []}
          onClose={() => { save.reset(); setEditing(null); }}
          onSave={(r) => save.mutate(r)}
        />
      )}
    </div>
  );
}

function RuleEditor({ rule, cats, projects, parties, error, onClose, onSave }: {
  rule: Partial<Rule>; cats: any[]; projects: any[]; parties: any[]; error: any;
  onClose: () => void; onSave: (r: Partial<Rule>) => void;
}) {
  const [f, setF] = useState<Partial<Rule>>({
    ...rule,
    conditions: rule.conditions?.length ? rule.conditions.map((c) => ({ ...c })) : [{ param: "description", op: "contains", value: "" }],
    actions: { ...(rule.actions ?? {}) },
  });
  const set = (k: keyof Rule, v: any) => setF({ ...f, [k]: v });
  const conds = f.conditions ?? [];
  const setCond = (i: number, patch: Partial<Cond>) => set("conditions", conds.map((c, j) => j === i ? { ...c, ...patch } : c));
  const a = f.actions ?? {};
  const setAct = (patch: Partial<Actions>) => set("actions", { ...a, ...patch });

  const canSave = conds.length > 0 && (a.category_id || a.project_id || a.counterparty_id);

  return (
    <Modal title={rule.id ? "Правило распределения" : "Новое правило"} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); onSave(f); }} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">Название (необязательно)</label>
            <input className="input" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Сгенерируется по первому условию" />
          </div>
          <div>
            <label className="label">Приоритет</label>
            <input type="number" className="input" value={f.priority ?? 100} onChange={(e) => set("priority", Number(e.target.value))} />
          </div>
        </div>
        <div>
          <label className="label">Применять к операциям типа</label>
          <select className="input !w-56" value={f.op_type ?? ""} onChange={(e) => set("op_type", e.target.value)}>
            {OP_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-semibold">Условия (все должны выполняться)</div>
          <div className="space-y-2">
            {conds.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <select className="input !w-40" value={c.param} onChange={(e) => setCond(i, { param: e.target.value })}>
                  {PARAMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select className="input !w-44" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                  {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <input className="input flex-1" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="значение" />
                <button type="button" className="text-red-500" onClick={() => set("conditions", conds.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn-ghost mt-2 text-sm" onClick={() => set("conditions", [...conds, { param: "description", op: "contains", value: "" }])}>+ условие</button>
        </div>

        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-semibold">Проставить</div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label">Статья</label>
              <SearchSelect value={a.category_id ?? ""} onChange={(v) => setAct({ category_id: v ? Number(v) : null })} options={cats} /></div>
            <div><label className="label">Проект</label>
              <SearchSelect value={a.project_id ?? ""} onChange={(v) => setAct({ project_id: v ? Number(v) : null })} options={projects.filter((p) => !p.is_archived)} /></div>
            <div><label className="label">Контрагент</label>
              <SearchSelect value={a.counterparty_id ?? ""} onChange={(v) => setAct({ counterparty_id: v ? Number(v) : null })} options={parties} /></div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Правило активно
        </label>

        {error && <p className="text-sm text-red-600">{(error as any)?.response?.data?.detail || "Ошибка сохранения"}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" disabled={!canSave}>Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
