import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCategories, useCounterparties, useProjects } from "../api/hooks";
import { fmtNum } from "../components/ReportControls";
import { OperationModal } from "./Operations";
import type { Operation, OperationList } from "../api/types";

const TYPE_RU: Record<string, string> = { income: "Поступление", outcome: "Выплата", move: "Перемещение", accrual: "Начисление" };

export function ProjectCard() {
  const { id } = useParams();
  const projectId = Number(id);
  const { companyId } = useApp();
  const qc = useQueryClient();
  const [method, setMethod] = useState<"cash" | "accrual">("cash");
  const [editId, setEditId] = useState<number | null>(null);

  const accounts = useAccounts();
  const categories = useCategories();
  const projects = useProjects();
  const parties = useCounterparties();

  const calc = useQuery({
    queryKey: ["projects-calc", companyId, method],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/projects-calc", { params: { company_id: companyId, method } })).data as any[],
  });
  const row = calc.data?.find((r) => r.id === projectId);
  const projName = projects.data?.find((p) => p.id === projectId)?.name ?? row?.name ?? "Проект";

  const ops = useQuery({
    queryKey: ["project-ops", companyId, projectId],
    enabled: !!companyId && !!projectId,
    queryFn: async () => (await api.get<OperationList>("/api/operations", { params: { company_id: companyId, project_id: projectId, limit: 500 } })).data,
  });

  const editOp = useQuery({
    queryKey: ["operation", editId],
    enabled: editId != null,
    queryFn: async () => (await api.get<Operation>(`/api/operations/${editId}`)).data,
  });
  const save = useMutation({
    mutationFn: async (op: any) => api.put(`/api/operations/${op.id}`, op),
    onSuccess: () => { ["project-ops", "projects-calc", "operations"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setEditId(null); },
  });

  const partyName = (id?: number | null) => parties.data?.find((p) => p.id === id)?.name;
  const catName = (id?: number | null) => categories.data?.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/projects" className="text-sm text-brand hover:underline">← Проекты</Link>
          <h1 className="text-2xl font-bold">{projName}</h1>
        </div>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
          {(["accrual", "cash"] as const).map((m) => (
            <button key={m} onClick={() => setMethod(m)}
              className={`rounded px-3 py-1 ${method === m ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
              {m === "accrual" ? "Прибыль (начисление)" : "Прибыль (кассовый)"}
            </button>
          ))}
        </div>
      </div>

      {/* Показатели проекта */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Metric label="Доходы" value={row?.income} cls="text-emerald-600" />
        <Metric label="Расходы" value={row?.outcome} cls="text-red-600" />
        <Metric label="Прибыль" value={row?.profit} cls={Number(row?.profit) < 0 ? "text-red-600" : ""} />
        <Metric label="Рентабельность" value={row?.margin == null ? "—" : row?.margin + "%"} raw />
      </div>

      {/* Операции проекта */}
      <div className="card overflow-x-auto p-0">
        <div className="border-b px-4 py-2 font-semibold">Операции проекта {ops.data ? `(${ops.data.total})` : ""}</div>
        <table className="table whitespace-nowrap text-sm">
          <thead>
            <tr><th>Дата</th><th>Тип</th><th>Контрагент</th><th>Статья</th><th className="text-right">Сумма</th><th></th></tr>
          </thead>
          <tbody>
            {(ops.data?.items ?? []).map((o) => (
              <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setEditId(o.id)}>
                <td className="whitespace-nowrap">{o.op_date}</td>
                <td>{TYPE_RU[o.type] ?? o.type}</td>
                <td>{partyName(o.counterparty_id) || "—"}</td>
                <td>{catName(o.category_id) || "—"}</td>
                <td className={`text-right tabular-nums ${o.type === "income" ? "text-emerald-700" : o.type === "outcome" ? "text-red-700" : ""}`}>{fmtNum(o.amount)}</td>
                <td className="text-right text-brand">ред.</td>
              </tr>
            ))}
            {ops.data?.items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">Нет операций по проекту</td></tr>}
          </tbody>
        </table>
      </div>

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

function Metric({ label, value, cls, raw }: { label: string; value: any; cls?: string; raw?: boolean }) {
  return (
    <div className="card">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${cls ?? ""}`}>{raw ? (value ?? "—") : fmtNum(value ?? 0)}</div>
    </div>
  );
}
