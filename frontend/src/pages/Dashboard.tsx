import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import type { AccountBalance, Dashboard as DashboardData } from "../api/types";

const nf = (v: string | number) => Number(v || 0).toLocaleString("ru-RU", { maximumFractionDigits: 0 });

export function Dashboard() {
  const { companyId, companies } = useApp();
  const year = new Date().getFullYear();
  const range = { date_from: `${year}-01-01`, date_to: `${year}-12-31` };
  const company = companies.find((c) => c.id === companyId);

  const dash = useQuery({
    queryKey: ["dashboard", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<DashboardData>("/api/reports/dashboard", { params: { company_id: companyId, ...range } })).data,
  });
  const balances = useQuery({
    queryKey: ["balances", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<AccountBalance[]>("/api/account-balances", { params: { company_id: companyId } })).data,
  });

  const d = dash.data;
  const income = Number(d?.income_total ?? 0);
  const net = Number(d?.net_total ?? 0);
  const margin = income ? ((net / income) * 100).toFixed(1) : "0";
  const chart = (d?.series ?? []).map((s) => ({
    period: s.period.slice(5),
    Доходы: Number(s.income), Расходы: Number(s.outcome), Прибыль: Number(s.net),
  }));
  const ACT = { operating: "Операционный", investing: "Инвестиционный", financing: "Финансовый" } as Record<string, string>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{company?.name ?? "Показатели"}</h1>
        <div className="text-sm text-slate-500">
          {new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>

      {/* Блок Прибыль: числа слева + график справа */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold">Прибыль, ₽</h2>
        <div className="grid gap-6 md:grid-cols-[260px_1fr]">
          <div className="space-y-4">
            <Kpi title="Доходы" value={nf(income)} accent="text-emerald-600" />
            <Kpi title="Расходы" value={nf(d?.outcome_total)} accent="text-red-600" />
            <Kpi title="Чистая прибыль" value={nf(net)} accent="text-slate-900" />
            <Kpi title="Рентабельность" value={`${margin}%`} accent="text-brand" />
          </div>
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <ComposedChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" />
                <YAxis tickFormatter={(v) => (v / 1000).toFixed(0) + "к"} />
                <Tooltip formatter={(v: number) => nf(v)} />
                <Legend />
                <Bar dataKey="Доходы" fill="#29abe2" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Расходы" fill="#f7a35c" radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="Прибыль" stroke="#1aae5a" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Денежный поток по видам деятельности */}
      <div className="grid gap-4 md:grid-cols-4">
        <Kpi title="Денег на счетах" value={money(d?.cash_balance)} accent="text-slate-900" card />
        {(d?.activities ?? []).map((a) => (
          <Kpi key={a.key} title={ACT[a.key] ?? a.title} value={nf(a.net_total)}
               accent={Number(a.net_total) < 0 ? "text-red-600" : "text-emerald-600"} card />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Прибыльность проектов */}
        <div className="card">
          <h2 className="mb-3 font-semibold">Прибыльность проектов</h2>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={(d?.projects ?? []).map((p) => ({ name: p.name, Прибыль: Number(p.profit) }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => (v / 1000).toFixed(0) + "к"} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => nf(v)} />
                <Bar dataKey="Прибыль" fill="#16b1bf" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Самые доходные клиенты — Парето 20/80 */}
        <div className="card">
          <h2 className="mb-3 font-semibold">Самые доходные клиенты (Парето 20/80)</h2>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={(d?.top_clients ?? []).map((c) => ({
                name: c.name, Доход: Number(c.income), "Накоплено, %": c.cumulative_share ?? null, pareto: c.pareto !== false,
              }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
                <YAxis yAxisId="l" tickFormatter={(v) => (v / 1000).toFixed(0) + "к"} />
                <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tickFormatter={(v) => v + "%"} />
                <Tooltip formatter={(v: number) => nf(v)} />
                <Bar yAxisId="l" dataKey="Доход" radius={[3, 3, 0, 0]}>
                  {(d?.top_clients ?? []).map((c, i) => (
                    <Cell key={i} fill={c.pareto !== false ? "#29abe2" : "#cbd5e1"} />
                  ))}
                </Bar>
                <Line yAxisId="r" type="monotone" dataKey="Накоплено, %" stroke="#16b1bf" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Структура платежей */}
      <PaymentStructure data={d?.payment_structure} />

      {/* Остатки по счетам */}
      <div className="card">
        <h2 className="mb-3 font-semibold">Остатки на счетах, ₽</h2>
        <table className="table">
          <thead><tr><th>Счёт</th><th className="text-right">Остаток</th></tr></thead>
          <tbody>
            {balances.data?.map((b) => (
              <tr key={b.account_id}>
                <td>{b.name}</td>
                <td className="text-right font-medium">{money(b.balance, b.currency_code)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PIE_COLORS = ["#16b1bf", "#29abe2", "#f7a35c", "#1aae5a", "#a78bfa", "#f472b6", "#fbbf24", "#94a3b8", "#34d399", "#60a5fa"];

function PaymentStructure({ data }: { data?: Dashboard["payment_structure"] }) {
  const [side, setSide] = useState<"income" | "outcome">("outcome");
  const items = (data?.[side] ?? []).map((x) => ({ name: x.name, value: Number(x.amount) }));
  const total = items.reduce((s, x) => s + x.value, 0);
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Структура платежей, ₽</h2>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {([["income", "Поступления"], ["outcome", "Выплаты"]] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setSide(k)}
              className={`rounded px-3 py-1 text-sm ${side === k ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="py-10 text-center text-slate-400">Нет данных за период</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_280px]">
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={items} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} innerRadius={55}>
                  {items.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => nf(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <table className="table self-center">
            <tbody>
              {items.map((x, i) => (
                <tr key={x.name}>
                  <td><span className="mr-2 inline-block h-3 w-3 rounded-sm align-middle" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />{x.name}</td>
                  <td className="text-right font-medium">{nf(x.value)}</td>
                  <td className="text-right text-slate-400">{total ? ((x.value / total) * 100).toFixed(0) + "%" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Kpi({ title, value, accent, card }: { title: string; value: string; accent: string; card?: boolean }) {
  return (
    <div className={card ? "card" : ""}>
      <div className="text-xs text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-bold ${accent}`}>{value}</div>
    </div>
  );
}
