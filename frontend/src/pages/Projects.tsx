import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { Modal } from "../components/Modal";
import { fmtNum } from "../components/ReportControls";

export function Projects() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<"cash" | "accrual">("cash");
  const [showArchived, setShowArchived] = useState(false);

  const list = useQuery({
    queryKey: ["projects-calc", companyId, method, showArchived],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/projects-calc", { params: { company_id: companyId, method, include_archived: showArchived } })).data as any[],
  });
  const create = useMutation({
    mutationFn: (n: string) => api.post("/api/projects", { name: n }, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects-calc"] }); setName(""); setAdding(false); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects-calc"] }),
  });
  const archive = useMutation({
    mutationFn: ({ id, val }: { id: number; val: boolean }) => api.post("/api/projects/bulk-update", { ids: [id], set: { is_archived: val } }, { params: { company_id: companyId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects-calc"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Проекты</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Показать архивные
          </label>
          <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
            {(["accrual", "cash"] as const).map((m) => (
              <button key={m} onClick={() => setMethod(m)}
                className={`rounded px-3 py-1 ${method === m ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
                {m === "accrual" ? "Начисление" : "Кассовый"}
              </button>
            ))}
          </div>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Добавить</button>
        </div>
      </div>
      <div className="card overflow-x-auto">
        <table className="table whitespace-nowrap">
          <thead>
            <tr>
              <th>Название проекта</th><th className="text-right">Доходы, ₽</th><th className="text-right">Расходы, ₽</th>
              <th className="text-right">Прибыль, ₽</th><th className="text-right">Рентабельность</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((r) => (
              <tr key={r.id ?? "none"} className={`hover:bg-slate-50 ${r.is_archived ? "opacity-50" : ""}`}>
                <td className="font-medium">
                  {r.id != null ? <Link className="text-brand hover:underline" to={`/projects/${r.id}`}>{r.name}</Link> : r.name}
                  {r.is_archived ? <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-500">архив</span> : null}
                </td>
                <td className="text-right text-emerald-600">{fmtNum(r.income)}</td>
                <td className="text-right text-red-600">{fmtNum(r.outcome)}</td>
                <td className={`text-right font-medium ${Number(r.profit) < 0 ? "text-red-600" : ""}`}>{fmtNum(r.profit)}</td>
                <td className="text-right">{r.margin == null ? "—" : r.margin + "%"}</td>
                <td className="whitespace-nowrap text-right">
                  {r.id != null && (
                    <>
                      <button className="text-slate-500 hover:underline" onClick={() => archive.mutate({ id: r.id, val: !r.is_archived })}>{r.is_archived ? "из архива" : "в архив"}</button>
                      <button className="ml-3 text-red-500 hover:underline" onClick={() => confirm("Удалить проект?") && remove.mutate(r.id)}>удал.</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">Нет проектов</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Новый проект" onClose={() => setAdding(false)}>
          <form onSubmit={(e) => { e.preventDefault(); if (name) create.mutate(name); }} className="space-y-3">
            <div><label className="label">Название проекта</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>Отмена</button>
              <button className="btn-primary">Создать</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
