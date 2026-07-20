import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useCrud } from "../api/hooks";
import { Modal } from "../components/Modal";
import { SearchSelect } from "../components/SearchSelect";
import type { Category } from "../api/types";

const KINDS = [
  { value: "income", label: "Доходы" },
  { value: "outcome", label: "Расходы" },
  { value: "asset", label: "Активы" },
  { value: "liability", label: "Обязательства" },
  { value: "capital", label: "Капитал" },
] as const;
const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const ACTIVITIES = [["operating", "Операционная"], ["investing", "Инвестиционная"], ["financing", "Финансовая"]] as const;
const SECTIONS = [
  ["current_asset", "Оборотные активы"], ["noncurrent_asset", "Внеоборотные активы"],
  ["short_liability", "Краткосрочные обязательства"], ["long_liability", "Долгосрочные обязательства"], ["capital", "Капитал"],
] as const;
const COST_TYPES = [["none", "—"], ["direct", "Прямые (себестоимость)"], ["indirect", "Косвенные"]] as const;

// Дерево статей одного вида: [{cat, depth}] в порядке родитель → дети.
function orderTree(cats: Category[]): { cat: Category; depth: number }[] {
  const ids = new Set(cats.map((c) => c.id));
  const byParent = new Map<number, Category[]>();
  const roots: Category[] = [];
  for (const c of cats) {
    const p = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    if (p) { const a = byParent.get(p) ?? []; a.push(c); byParent.set(p, a); }
    else roots.push(c);
  }
  const bySort = (a: Category, b: Category) => a.sort - b.sort || a.id - b.id;
  const out: { cat: Category; depth: number }[] = [];
  const walk = (list: Category[], depth: number) => {
    for (const c of [...list].sort(bySort)) { out.push({ cat: c, depth }); const kids = byParent.get(c.id); if (kids) walk(kids, depth + 1); }
  };
  walk(roots, 0);
  return out;
}

export function Categories() {
  const { companyId } = useApp();
  const { create, update, remove } = useCrud("/api/categories", "categories");
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const list = useQuery({
    queryKey: ["categories", companyId, showArchived],
    enabled: !!companyId,
    queryFn: async () => (await api.get<Category[]>("/api/categories", { params: { company_id: companyId, include_archived: showArchived } })).data,
  });
  const cats = list.data ?? [];

  const archive = (c: Category, val: boolean) =>
    api.post("/api/categories/bulk-update", { ids: [c.id], set: { is_archived: val } }, { params: { company_id: companyId } })
      .then(() => list.refetch());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Статьи доходов и расходов</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показать архивные
          </label>
          <button className="btn-primary" onClick={() => setEditing({ kind: "outcome", activity: "operating", in_cashflow: true, in_pnl: true, sort: 0 } as any)}>+ Статья</button>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table whitespace-nowrap">
          <thead>
            <tr><th>Название (по группам)</th><th>Вид деятельности</th><th className="text-center">ДДС</th><th className="text-center">ОПиУ</th><th></th></tr>
          </thead>
          <tbody>
            {KINDS.map(({ value, label }) => {
              const kindCats = orderTree(cats.filter((c) => c.kind === value));
              if (!kindCats.length) return null;
              return (
                <SectionRows key={value} label={label} rows={kindCats}
                  onEdit={setEditing} onDelete={(c) => { if (confirm("Удалить статью?")) remove.mutate(c.id); }}
                  onArchive={archive} />
              );
            })}
            {cats.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">Пусто</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <CategoryEditor
          cat={editing} allCats={cats}
          onClose={() => setEditing(null)}
          onSave={(body) => {
            if (editing.id) update.mutate({ id: editing.id, body }, { onSuccess: () => setEditing(null) });
            else create.mutate(body, { onSuccess: () => setEditing(null) });
          }}
        />
      )}
    </div>
  );
}

function SectionRows({ label, rows, onEdit, onDelete, onArchive }: {
  label: string; rows: { cat: Category; depth: number }[];
  onEdit: (c: Category) => void; onDelete: (c: Category) => void; onArchive: (c: Category, val: boolean) => void;
}) {
  return (
    <>
      <tr className="bg-slate-50 font-semibold text-slate-700"><td colSpan={5}>{label}</td></tr>
      {rows.map(({ cat, depth }) => (
        <tr key={cat.id} className={`hover:bg-slate-50 ${cat.is_archived ? "opacity-50" : ""}`}>
          <td style={{ paddingLeft: depth * 22 + 12 }}>
            {depth > 0 && <span className="text-slate-300">└ </span>}
            {cat.name}
            {(cat as any).is_system && <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-500">системная</span>}
            {cat.is_archived && <span className="ml-2 rounded bg-slate-200 px-1 text-xs text-slate-500">архив</span>}
          </td>
          <td className="text-slate-500">{({ operating: "Операционная", investing: "Инвестиционная", financing: "Финансовая" } as any)[cat.activity] ?? cat.activity}</td>
          <td className="text-center">{cat.in_cashflow ? "✓" : "—"}</td>
          <td className="text-center">{cat.in_pnl ? "✓" : "—"}</td>
          <td className="whitespace-nowrap text-right">
            {!(cat as any).is_system && (
              <>
                <button className="text-brand hover:underline" onClick={() => onEdit(cat)}>ред.</button>
                <button className="ml-3 text-slate-500 hover:underline" onClick={() => onArchive(cat, !cat.is_archived)}>{cat.is_archived ? "из архива" : "в архив"}</button>
                <button className="ml-3 text-red-500 hover:underline" onClick={() => onDelete(cat)}>удал.</button>
              </>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

// Потомки статьи (чтобы не выбрать их родителем — иначе цикл).
function descendantIds(all: Category[], id?: number): Set<number> {
  const res = new Set<number>();
  if (id == null) return res;
  const byParent = new Map<number, Category[]>();
  for (const c of all) if (c.parent_id) { const a = byParent.get(c.parent_id) ?? []; a.push(c); byParent.set(c.parent_id, a); }
  const stack = [id];
  while (stack.length) { const cur = stack.pop()!; for (const ch of byParent.get(cur) ?? []) { if (!res.has(ch.id)) { res.add(ch.id); stack.push(ch.id); } } }
  return res;
}

function CategoryEditor({ cat, allCats, onClose, onSave }: {
  cat: Partial<Category>; allCats: Category[]; onClose: () => void; onSave: (body: any) => void;
}) {
  const [f, setF] = useState<any>({
    name: cat.name ?? "", kind: cat.kind ?? "outcome", parent_id: cat.parent_id ?? "",
    activity: cat.activity ?? "operating", balance_section: (cat as any).balance_section ?? "",
    is_dividend: (cat as any).is_dividend ?? false, in_cashflow: cat.in_cashflow ?? true, in_pnl: cat.in_pnl ?? true,
    cost_type: (cat as any).cost_type ?? "none", is_depreciation: (cat as any).is_depreciation ?? false,
    is_loan_interest: (cat as any).is_loan_interest ?? false, sort: cat.sort ?? 0,
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  // Родитель — только статья того же вида, не сама себя и не свой потомок
  const excluded = useMemo(() => descendantIds(allCats, cat.id), [allCats, cat.id]);
  const parentOptions = allCats.filter((c) => c.kind === f.kind && c.id !== cat.id && !excluded.has(c.id));
  const isBalance = ["asset", "liability", "capital"].includes(f.kind);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: f.name, kind: f.kind, parent_id: f.parent_id ? Number(f.parent_id) : null,
      activity: f.activity, balance_section: f.balance_section || null,
      is_dividend: !!f.is_dividend, in_cashflow: !!f.in_cashflow, in_pnl: !!f.in_pnl,
      cost_type: f.cost_type, is_depreciation: !!f.is_depreciation, is_loan_interest: !!f.is_loan_interest,
      sort: Number(f.sort) || 0,
    });
  }

  return (
    <Modal title={cat.id ? "Статья учёта" : "Новая статья"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">Название</label><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} required /></div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Тип статьи</label>
            <select className="input" value={f.kind} onChange={(e) => setF((p: any) => ({ ...p, kind: e.target.value, parent_id: "" }))}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Родительская статья (категория)</label>
            <SearchSelect value={f.parent_id} onChange={(v) => set("parent_id", v)} options={parentOptions}
              emptyLabel="— без родителя (верхний уровень) —" placeholder="Верхний уровень" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Вид деятельности (ДДС)</label>
            <select className="input" value={f.activity} onChange={(e) => set("activity", e.target.value)}>
              {ACTIVITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {isBalance && (
            <div>
              <label className="label">Раздел баланса</label>
              <select className="input" value={f.balance_section} onChange={(e) => set("balance_section", e.target.value)}>
                <option value="">— не указан —</option>
                {SECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          )}
        </div>
        {f.kind === "outcome" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Тип затрат (для показателей прибыли)</label>
              <select className="input" value={f.cost_type} onChange={(e) => set("cost_type", e.target.value)}>
                {COST_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_depreciation} onChange={(e) => set("is_depreciation", e.target.checked)} /> Амортизация</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_loan_interest} onChange={(e) => set("is_loan_interest", e.target.checked)} /> Проценты по кредитам</label>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.in_cashflow} onChange={(e) => set("in_cashflow", e.target.checked)} /> Учитывать в ДДС</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.in_pnl} onChange={(e) => set("in_pnl", e.target.checked)} /> Учитывать в ОПиУ</label>
          {f.kind === "capital" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_dividend} onChange={(e) => set("is_dividend", e.target.checked)} /> Статья «Дивиденды»</label>}
        </div>
        <div className="w-32"><label className="label">Сортировка</label><input type="number" className="input" value={f.sort} onChange={(e) => set("sort", e.target.value)} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
