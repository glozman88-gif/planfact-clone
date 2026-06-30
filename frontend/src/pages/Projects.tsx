import { useState } from "react";
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

  const list = useQuery({
    queryKey: ["projects-calc", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/projects-calc", { params: { company_id: companyId } })).data as any[],
  });
  const create = useMutation({
    mutationFn: (n: string) => api.post("/api/projects", { name: n }, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects-calc"] }); setName(""); setAdding(false); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects-calc"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Проекты</h1>
        <button className="btn-primary" onClick={() => setAdding(true)}>+ Добавить</button>
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
              <tr key={r.id ?? "none"} className="hover:bg-slate-50">
                <td className="font-medium">{r.name}</td>
                <td className="text-right text-emerald-600">{fmtNum(r.income)}</td>
                <td className="text-right text-red-600">{fmtNum(r.outcome)}</td>
                <td className={`text-right font-medium ${Number(r.profit) < 0 ? "text-red-600" : ""}`}>{fmtNum(r.profit)}</td>
                <td className="text-right">{r.margin == null ? "—" : r.margin + "%"}</td>
                <td className="text-right">
                  {r.id != null && (
                    <button className="text-red-500 hover:underline" onClick={() => confirm("Удалить проект?") && remove.mutate(r.id)}>удал.</button>
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
