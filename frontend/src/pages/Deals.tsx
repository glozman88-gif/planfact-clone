import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCounterparties, useDealStatuses, useProjects } from "../api/hooks";
import { Modal } from "../components/Modal";
import { fmtNum } from "../components/ReportControls";

export function Deals() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const statuses = useDealStatuses();
  const parties = useCounterparties();
  const projects = useProjects();
  const [kind, setKind] = useState<"sale" | "purchase">("sale");
  const [adding, setAdding] = useState(false);
  const [shipDeal, setShipDeal] = useState<any | null>(null);

  const list = useQuery({
    queryKey: ["deals-calc", companyId, kind],
    enabled: !!companyId,
    queryFn: async () => (await api.get("/api/deals-calc", { params: { company_id: companyId, kind } })).data as any[],
  });
  const create = useMutation({
    mutationFn: (body: any) => api.post("/api/deals", body, { params: { company_id: companyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["deals-calc"] }); setAdding(false); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/deals/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deals-calc"] }),
  });

  const statusName = (id?: number | null) => statuses.data?.find((s) => s.id === id)?.name ?? "—";
  const partyName = (id?: number | null) => parties.data?.find((s) => s.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Сделки</h1>
        <button className="btn-primary" onClick={() => setAdding(true)}>+ Добавить сделку</button>
      </div>

      <div className="flex gap-1 rounded-md bg-slate-100 p-1 w-fit">
        {([["sale", "Продажи"], ["purchase", "Закупки"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded px-4 py-1.5 text-sm ${kind === k ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
            {lbl}
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="table whitespace-nowrap">
          <thead>
            <tr>
              <th>Название</th><th>{kind === "sale" ? "Клиент" : "Поставщик"}</th><th>Статус</th>
              <th className="text-right">Сумма сделки</th>
              <th className="text-right">{kind === "sale" ? "Поступило" : "Выплачено"}</th>
              <th className="text-right">{kind === "sale" ? "Отгружено" : "Поставлено"}</th>
              <th className="text-right">Остаток долга</th>
              <th className="text-right">Прибыль</th><th className="text-right">Рентаб.</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="font-medium">{r.name}</td>
                <td>{partyName(r.counterparty_id)}</td>
                <td>{statusName(r.status_id)}</td>
                <td className="text-right">{fmtNum(r.amount)}</td>
                <td className="text-right text-emerald-600">{fmtNum(r.received)}</td>
                <td className="text-right text-sky-600">{fmtNum(r.shipped)}</td>
                <td className={`text-right ${Number(r.debt) > 0 ? "text-amber-600" : ""}`}>{fmtNum(r.debt)}</td>
                <td className={`text-right font-medium ${Number(r.profit) < 0 ? "text-red-600" : ""}`}>{fmtNum(r.profit)}</td>
                <td className="text-right">{r.margin == null ? "—" : r.margin + "%"}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="text-brand hover:underline" onClick={() => setShipDeal(r)}>{kind === "sale" ? "отгрузки" : "поставки"}</button>
                  <button className="ml-2 text-red-500 hover:underline" onClick={() => confirm("Удалить сделку?") && remove.mutate(r.id)}>×</button>
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <tr><td colSpan={10} className="py-8 text-center text-slate-400">{kind === "sale" ? "Создайте первую сделку продажи" : "Создайте первую сделку закупки"}</td></tr>}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddDeal kind={kind} onClose={() => setAdding(false)} onSave={(b) => create.mutate(b)}
          statuses={statuses.data ?? []} parties={parties.data ?? []} projects={projects.data ?? []} />
      )}

      {shipDeal && (
        <ShipmentsModal deal={shipDeal} kind={kind} onClose={() => { setShipDeal(null); qc.invalidateQueries({ queryKey: ["deals-calc"] }); }} />
      )}
    </div>
  );
}

function ShipmentsModal({ deal, kind, onClose }: { deal: any; kind: "sale" | "purchase"; onClose: () => void }) {
  const qc = useQueryClient();
  const title = kind === "sale" ? "Отгрузки" : "Поставки";
  const [f, setF] = useState({ ship_date: new Date().toISOString().slice(0, 10), amount: "", cost: "", note: "" });

  const list = useQuery({
    queryKey: ["shipments", deal.id],
    queryFn: async () => (await api.get(`/api/deals/${deal.id}/shipments`)).data as any[],
  });
  const add = useMutation({
    mutationFn: () => api.post(`/api/deals/${deal.id}/shipments`, { ...f, amount: String(f.amount || "0"), cost: String(f.cost || "0") }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["shipments", deal.id] }); setF({ ...f, amount: "", cost: "", note: "" }); },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api/shipments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shipments", deal.id] }),
  });

  return (
    <Modal title={`${title} — ${deal.name}`} onClose={onClose} wide>
      <table className="table mb-3">
        <thead><tr><th>Дата</th><th className="text-right">Сумма</th><th className="text-right">Себестоимость</th><th>Примечание</th><th></th></tr></thead>
        <tbody>
          {list.data?.map((s) => (
            <tr key={s.id}>
              <td>{s.ship_date}</td><td className="text-right">{fmtNum(s.amount)}</td><td className="text-right">{fmtNum(s.cost)}</td>
              <td className="text-slate-500">{s.note}</td>
              <td className="text-right"><button className="text-red-500" onClick={() => del.mutate(s.id)}>×</button></td>
            </tr>
          ))}
          {list.data?.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-slate-400">Нет {title.toLowerCase()}</td></tr>}
        </tbody>
      </table>
      <form onSubmit={(e) => { e.preventDefault(); if (f.amount) add.mutate(); }} className="flex items-end gap-2">
        <div><label className="label">Дата</label><input type="date" className="input" value={f.ship_date} onChange={(e) => setF({ ...f, ship_date: e.target.value })} /></div>
        <div><label className="label">Сумма</label><input type="number" step="0.01" className="input w-32" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
        <div><label className="label">Себестоимость</label><input type="number" step="0.01" className="input w-32" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></div>
        <div className="flex-1"><label className="label">Примечание</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        <button className="btn-primary">Добавить</button>
      </form>
    </Modal>
  );
}

function AddDeal({ kind, onClose, onSave, statuses, parties, projects }: any) {
  const [f, setF] = useState<any>({ name: "", kind, status_id: "", counterparty_id: "", project_id: "", amount: "", cost: "", start_date: "", note: "" });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  return (
    <Modal title={kind === "sale" ? "Новая сделка продажи" : "Новая сделка закупки"} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ ...f, status_id: f.status_id || null, counterparty_id: f.counterparty_id || null, project_id: f.project_id || null, amount: String(f.amount || "0"), cost: String(f.cost || "0"), start_date: f.start_date || null }); }} className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Название</label><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} required /></div>
        <div><label className="label">{kind === "sale" ? "Клиент" : "Поставщик"}</label>
          <select className="input" value={f.counterparty_id} onChange={(e) => set("counterparty_id", e.target.value)}>
            <option value="">—</option>{parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label className="label">Статус</label>
          <select className="input" value={f.status_id} onChange={(e) => set("status_id", e.target.value)}>
            <option value="">—</option>{statuses.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
        <div><label className="label">Сумма сделки</label><input type="number" step="0.01" className="input" value={f.amount} onChange={(e) => set("amount", e.target.value)} /></div>
        <div><label className="label">Себестоимость</label><input type="number" step="0.01" className="input" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></div>
        <div><label className="label">Проект</label>
          <select className="input" value={f.project_id} onChange={(e) => set("project_id", e.target.value)}>
            <option value="">—</option>{projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label className="label">Дата начала</label><input type="date" className="input" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} /></div>
        <div className="col-span-2 flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
