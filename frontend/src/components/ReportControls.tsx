import { useState } from "react";
import { DatePresets } from "./DatePresets";

export interface Range {
  date_from: string;
  date_to: string;
}

export function defaultRange(): Range {
  const now = new Date();
  const from = new Date(now.getFullYear(), 0, 1);
  const to = new Date(now.getFullYear(), 11, 31);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { date_from: fmt(from), date_to: fmt(to) };
}

export function RangePicker({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [local, setLocal] = useState(range);
  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div>
        <label className="label">Быстрый период</label>
        <DatePresets className="!w-44" onSelect={(from, to) => { const r = { date_from: from, date_to: to }; setLocal(r); onChange(r); }} />
      </div>
      <div>
        <label className="label">С даты</label>
        <input type="date" className="input" value={local.date_from} onChange={(e) => setLocal({ ...local, date_from: e.target.value })} />
      </div>
      <div>
        <label className="label">По дату</label>
        <input type="date" className="input" value={local.date_to} onChange={(e) => setLocal({ ...local, date_to: e.target.value })} />
      </div>
      <button className="btn-primary" onClick={() => onChange(local)}>Применить</button>
    </div>
  );
}

export const REPORT_INTERVALS = [
  ["day", "День"], ["week", "Неделя"], ["month", "Месяц"], ["quarter", "Квартал"], ["year", "Год"],
] as const;

// Переключатель гранулярности колонок отчёта (день/неделя/месяц/квартал/год).
export function IntervalPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="card flex gap-1 p-1">
      {REPORT_INTERVALS.map(([k, lbl]) => (
        <button key={k} onClick={() => onChange(k)}
          className={`rounded-md px-2.5 py-1.5 text-sm ${value === k ? "bg-brand-light font-medium text-brand-dark ring-1 ring-brand" : "text-slate-600"}`}>
          {lbl}
        </button>
      ))}
    </div>
  );
}

export function fmtNum(v: string | number): string {
  const n = Number(v || 0);
  if (n === 0) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}
