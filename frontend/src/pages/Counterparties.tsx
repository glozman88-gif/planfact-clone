import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { Modal } from "../components/Modal";
import { fmtNum } from "../components/ReportControls";

const KIND = { company: "Юрлицо", person: "Физлицо", entrepreneur: "ИП" } as Record<string, string>;

export function Counterparties() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: ["contractors-calc", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/contractors-calc", { params: { company_id: companyId } })).data as any[],
  });

  const create = useMutation({
    mutationFn: (body: any) => api.post("/api/counterparties", body, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contractors-calc"] }); setAdding(false); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/counterparties/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contractors-calc"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Контрагенты</h1>
        <button className="btn-primary" onClick={() => setAdding(true)}>+ Добавить</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="table whitespace-nowrap">
          <thead>
            <tr>
              <th>Контрагент</th><th>Тип</th><th>ИНН</th><th className="text-right">Операций</th>
              <th className="text-right">Дебиторка</th><th className="text-right">Кредиторка</th>
              <th className="text-right">Поступления</th><th className="text-right">Выплаты</th><th className="text-right">Разница</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="font-medium">{r.name}</td>
                <td>{KIND[r.kind] ?? r.kind}</td>
                <td>{r.inn || "—"}</td>
                <td className="text-right">{r.operations}</td>
                <td className="text-right">{fmtNum(r.receivable)}</td>
                <td className="text-right">{fmtNum(r.payable)}</td>
                <td className="text-right text-emerald-600">{fmtNum(r.income)}</td>
                <td className="text-right text-red-600">{fmtNum(r.outcome)}</td>
                <td className={`text-right font-medium ${Number(r.diff) < 0 ? "text-red-600" : ""}`}>{fmtNum(r.diff)}</td>
                <td className="text-right">
                  <button className="text-red-500 hover:underline" onClick={() => confirm("Удалить контрагента?") && remove.mutate(r.id)}>удал.</button>
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-slate-400">Нет контрагентов</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && <AddModal onClose={() => setAdding(false)} onSave={(b) => create.mutate(b)} />}
    </div>
  );
}

function AddModal({ onClose, onSave }: { onClose: () => void; onSave: (b: any) => void }) {
  const [f, setF] = useState({ name: "", kind: "company", inn: "", phone: "", email: "", note: "" });
  return (
    <Modal title="Новый контрагент" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(f); }} className="space-y-3">
        <div><label className="label">Название</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
        <div><label className="label">Тип</label>
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="company">Юрлицо</option><option value="person">Физлицо</option><option value="entrepreneur">ИП</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">ИНН</label><input className="input" value={f.inn} onChange={(e) => setF({ ...f, inn: e.target.value })} /></div>
          <div><label className="label">Телефон</label><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        </div>
        <div><label className="label">Email</label><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
