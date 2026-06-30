import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { RangePicker, defaultRange, fmtNum, type Range } from "../components/ReportControls";
import type { PaymentCalendar as PC } from "../api/types";

const vals = (rows: any[], key: string) => rows.map((r) => Number(r[key] || 0));

export function PaymentCalendar() {
  const { companyId } = useApp();
  const [range, setRange] = useState<Range>(defaultRange());

  const q = useQuery({
    queryKey: ["payment-calendar", companyId, range],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<PC>("/api/reports/payment-calendar", { params: { company_id: companyId, ...range } })).data,
  });
  const r = q.data;
  const chart = (r?.rows ?? []).map((x) => ({ period: x.period.slice(5), Остаток: Number(x.closing) }));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Платёжный календарь</h1>
      <RangePicker range={range} onChange={setRange} />

      {r && r.has_gap && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          ⚠️ Обнаружен кассовый разрыв: в некоторых периодах прогнозный остаток уходит в минус.
        </div>
      )}

      {r && (
        <div className="card">
          <h2 className="mb-2 font-semibold">Прогноз остатка на счетах</h2>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <AreaChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" />
                <YAxis tickFormatter={(v) => (v / 1000).toFixed(0) + "к"} />
                <Tooltip formatter={(v: number) => fmtNum(v)} />
                <ReferenceLine y={0} stroke="#ef4444" />
                <Area type="monotone" dataKey="Остаток" stroke="#16b1bf" fill="#cdeef1" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {r && (
        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white">Показатель</th>
                {r.periods.map((p) => <th key={p} className="text-right">{p}</th>)}
              </tr>
            </thead>
            <tbody>
              <CalRow label="Остаток на начало" rows={r.rows} field="opening" />
              <CalRow label="Поступления (план+факт)" rows={r.rows} field="income" cls="text-emerald-700" />
              <CalRow label="Выплаты (план+факт)" rows={r.rows} field="outcome" cls="text-red-700" />
              <CalRow label="Денежный поток" rows={r.rows} field="net" bold />
              <tr className="font-semibold">
                <td className="sticky left-0 bg-white">Остаток на конец</td>
                {r.rows.map((x) => (
                  <td key={x.period} className={`text-right ${x.gap ? "bg-red-50 font-bold text-red-600" : ""}`}>
                    {fmtNum(x.closing)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CalRow({ label, rows, field, cls, bold }: { label: string; rows: any[]; field: string; cls?: string; bold?: boolean }) {
  return (
    <tr className={`${bold ? "font-semibold" : ""} ${cls ?? ""}`}>
      <td className="sticky left-0 bg-white">{label}</td>
      {rows.map((x) => <td key={x.period} className="text-right">{fmtNum(x[field])}</td>)}
    </tr>
  );
}
