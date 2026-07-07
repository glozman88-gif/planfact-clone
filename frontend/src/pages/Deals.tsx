import { useState } from "react";
import { Link } from "react-router-dom";
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

  const statusObj = (id?: number | null) => statuses.data?.find((s) => s.id === id);
  const partyName = (id?: number | null) => parties.data?.find((s) => s.id === id)?.name ?? "—";
  const statusBadge = (id?: number | null) => {
    const st = statusObj(id);
    if (!st) return <span className="text-slate-400">—</span>;
    const cls = st.is_won ? "bg-emerald-100 text-emerald-700"
      : st.is_lost ? "bg-red-100 text-red-700"
      : st.name === "В работе" ? "bg-sky-100 text-sky-700"
      : "bg-amber-100 text-amber-700";
    return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{st.name}</span>;
  };

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
                <td className="font-medium"><Link to={`/deals/${r.id}`} className="text-brand hover:underline">{r.name}</Link></td>
                <td>{partyName(r.counterparty_id)}</td>
                <td>{statusBadge(r.status_id)}</td>
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
          parties={parties.data ?? []} />
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

function AddDeal({ kind, onClose, onSave, parties }: any) {
  const isSale = kind === "sale";
  const [f, setF] = useState<any>({
    name: "", start_date: new Date().toISOString().slice(0, 10), counterparty_id: "", vat_mode: "with_vat", note: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  // Плоская функция (не вложенный компонент) — иначе инпуты ремоунтятся и теряют фокус на каждом вводе
  const field = (label: string, control: any, hint?: string) => (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3">
      <label className="pt-2 text-sm font-medium text-slate-600">{label}{hint && <span className="ml-1 cursor-help text-slate-300" title={hint}>?</span>}</label>
      <div>{control}</div>
    </div>
  );
  return (
    <Modal title={isSale ? "Новая продажа" : "Новая закупка"} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name: f.name, kind, start_date: f.start_date || null, counterparty_id: f.counterparty_id || null, vat_mode: f.vat_mode, note: f.note || null }); }} className="space-y-4">
        {field("Название сделки",
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Например, разработка сайта" required />)}
        {field("Дата сделки",
          <input type="date" className="input" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} />)}
        {field(isSale ? "Клиент" : "Поставщик",
          <select className="input" value={f.counterparty_id} onChange={(e) => set("counterparty_id", e.target.value)}>
            <option value="">{isSale ? "Укажите, кому продаёте товар или услугу" : "Укажите, у кого покупаете"}</option>
            {parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>)}
        {field("НДС",
          <select className="input" value={f.vat_mode} onChange={(e) => set("vat_mode", e.target.value)}>
            <option value="with_vat">С учётом НДС</option>
            <option value="without_vat">Без НДС</option>
          </select>, "Как учитывать НДС в суммах сделки")}
        {field("Комментарий",
          <textarea className="input min-h-[80px]" value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="Ваш комментарий или пояснение к этой сделке" />)}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className="btn-ghost text-brand" onClick={onClose}>Отменить</button>
          <button className="btn-primary">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
