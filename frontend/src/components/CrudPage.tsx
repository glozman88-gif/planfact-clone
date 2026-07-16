import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCrud } from "../api/hooks";
import { Modal } from "./Modal";
import { SearchSelect } from "./SearchSelect";

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
  const qc = useQueryClient();
  const { create, update, remove } = useCrud(path, queryKey);
  const [editing, setEditing] = useState<any | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);

  const list = useQuery({
    queryKey: [queryKey, companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get(path, { params: { company_id: companyId } })).data as any[],
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: [queryKey] });
  const bulkDelete = useMutation({
    mutationFn: (ids: number[]) => api.post(`${path}/bulk-delete`, { ids }, { params: { company_id: companyId } }),
    onSuccess: () => { invalidate(); setSelected(new Set()); },
  });
  const bulkUpdate = useMutation({
    mutationFn: (set: any) => api.post(`${path}/bulk-update`, { ids: Array.from(selected), set }, { params: { company_id: companyId } }),
    onSuccess: () => { invalidate(); setSelected(new Set()); setBulkEdit(false); },
  });
  const rows = list.data ?? [];
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand bg-brand-light px-4 py-2 text-sm">
          <span className="font-medium">Выбрано: {selected.size}</span>
          <button className="btn-ghost !py-1" onClick={() => setBulkEdit(true)}>Изменить</button>
          <button className="text-red-600 hover:underline" onClick={() => { if (confirm(`Удалить выбранные (${selected.size})?`)) bulkDelete.mutate(Array.from(selected)); }}>Удалить</button>
          <button className="ml-auto text-slate-500 hover:underline" onClick={() => setSelected(new Set())}>Снять выделение</button>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8"><input type="checkbox" checked={allSel} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
              {columns.map((c) => <th key={c.name} className={c.align === "right" ? "text-right" : ""}>{c.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`hover:bg-slate-50 ${selected.has(row.id) ? "bg-brand-light" : ""}`}>
                <td><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
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
            {rows.length === 0 && <tr><td colSpan={columns.length + 2} className="py-6 text-center text-slate-400">Пусто</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <CrudForm title={title} fields={fields} initial={editing} onClose={() => setEditing(null)} onSave={save} />
      )}
      {bulkEdit && (
        <BulkEditForm title={title} fields={fields} count={selected.size} onClose={() => setBulkEdit(false)} onSave={(set: any) => bulkUpdate.mutate(set)} />
      )}
    </div>
  );
}

function BulkEditForm({ title, fields, count, onClose, onSave }: any) {
  const editable = (fields as Field[]).filter((f) => !f.required || f.type === "select" || f.type === "checkbox");
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [val, setVal] = useState<Record<string, any>>({});
  const submit = (e: any) => {
    e.preventDefault();
    const set: any = {};
    for (const f of editable) {
      if (!on[f.name]) continue;
      let v = val[f.name];
      if (f.type === "number") v = String(v || "0");
      if (f.type === "checkbox") v = !!v;
      if (f.type === "select" && (v === "" || v === undefined)) v = null;
      set[f.name] = v ?? null;
    }
    onSave(set);
  };
  return (
    <Modal title={`Массовое изменение (${count}): ${title}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-500">Отметьте поля, которые изменить у всех выбранных записей.</p>
        {editable.map((f) => (
          <div key={f.name} className="flex items-center gap-2">
            <input type="checkbox" checked={!!on[f.name]} onChange={(e) => setOn({ ...on, [f.name]: e.target.checked })} />
            <span className="w-40 text-sm">{f.label}</span>
            {f.type === "select" ? (
              <SearchSelect disabled={!on[f.name]} value={val[f.name]} onChange={(v) => setVal({ ...val, [f.name]: v })}
                options={(f.options ?? []).map((o) => ({ id: o.value as any, name: o.label }))} />
            ) : f.type === "checkbox" ? (
              <input type="checkbox" disabled={!on[f.name]} checked={!!val[f.name]} onChange={(e) => setVal({ ...val, [f.name]: e.target.checked })} />
            ) : (
              <input className="input" type={f.type === "number" ? "number" : "text"} disabled={!on[f.name]} value={val[f.name] ?? ""} onChange={(e) => setVal({ ...val, [f.name]: e.target.value })} />
            )}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Применить</button>
        </div>
      </form>
    </Modal>
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
              <SearchSelect value={form[f.name]} onChange={(v) => set(f.name, v)}
                options={(f.options ?? []).map((o) => ({ id: o.value as any, name: o.label }))} />
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
