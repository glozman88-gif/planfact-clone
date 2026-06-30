import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCrud } from "../api/hooks";
import { Modal } from "./Modal";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "select" | "checkbox";
  options?: { value: any; label: string }[];
  default?: any;
  required?: boolean;
}

export interface Column {
  name: string;
  label: string;
  render?: (row: any) => any;
  align?: "left" | "right";
}

export function CrudPage({
  title, path, queryKey, fields, columns,
}: { title: string; path: string; queryKey: string; fields: Field[]; columns: Column[] }) {
  const { companyId } = useApp();
  const { create, update, remove } = useCrud(path, queryKey);
  const [editing, setEditing] = useState<any | null>(null);

  const list = useQuery({
    queryKey: [queryKey, companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get(path, { params: { company_id: companyId } })).data as any[],
  });

  function blank() {
    const obj: any = {};
    for (const f of fields) obj[f.name] = f.default ?? (f.type === "checkbox" ? false : "");
    return obj;
  }

  function save(form: any) {
    const body: any = {};
    for (const f of fields) {
      let v = form[f.name];
      if (f.type === "number") v = String(v || "0");
      if ((f.type === "select") && v === "") v = null;
      body[f.name] = v;
    }
    if (form.id) update.mutate({ id: form.id, body }, { onSuccess: () => setEditing(null) });
    else create.mutate(body, { onSuccess: () => setEditing(null) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        <button className="btn-primary" onClick={() => setEditing(blank())}>+ Добавить</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => <th key={c.name} className={c.align === "right" ? "text-right" : ""}>{c.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50">
                {columns.map((c) => (
                  <td key={c.name} className={c.align === "right" ? "text-right" : ""}>
                    {c.render ? c.render(row) : row[c.name]}
                  </td>
                ))}
                <td className="whitespace-nowrap text-right">
                  <button className="text-brand hover:underline" onClick={() => setEditing(row)}>ред.</button>
                  <button className="ml-3 text-red-500 hover:underline" onClick={() => { if (confirm("Удалить запись?")) remove.mutate(row.id); }}>удал.</button>
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <tr><td colSpan={columns.length + 1} className="py-6 text-center text-slate-400">Пусто</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <CrudForm title={title} fields={fields} initial={editing} onClose={() => setEditing(null)} onSave={save} />
      )}
    </div>
  );
}

function CrudForm({ title, fields, initial, onClose, onSave }: any) {
  const [form, setForm] = useState<any>(initial);
  const set = (k: string, v: any) => setForm({ ...form, [k]: v });

  return (
    <Modal title={form.id ? `Редактирование: ${title}` : `Новая запись: ${title}`} onClose={onClose}>
      <form
        onSubmit={(e) => { e.preventDefault(); onSave(form); }}
        className="space-y-3"
      >
        {fields.map((f: Field) => (
          <div key={f.name}>
            {f.type !== "checkbox" && <label className="label">{f.label}</label>}
            {f.type === "select" ? (
              <select className="input" value={form[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">—</option>
                {f.options?.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!form[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}
              </label>
            ) : (
              <input
                className="input"
                type={f.type === "number" ? "number" : "text"}
                step={f.type === "number" ? "0.01" : undefined}
                value={form[f.name] ?? ""}
                required={f.required}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
