import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { fmtNum } from "../components/ReportControls";
import { DatePresets } from "../components/DatePresets";
import { ExportButton } from "../components/ExportButton";
import { Modal } from "../components/Modal";
import { useAccounts, useCounterparties, useLegalEntities, useProjects } from "../api/hooks";
import type { PaymentCalendar as PC, Operation, OperationList } from "../api/types";

const INTERVALS = [
  ["day", "День"], ["week", "Неделя"], ["month", "Месяц"], ["quarter", "Квартал"], ["year", "Год"],
] as const;
const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function periodLabel(row: PC["rows"][number], interval: string): string {
  const s = row.start;
  if (interval === "day") return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  if (interval === "week") return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  if (interval === "quarter" || interval === "year") return row.period;
  return `${MONTHS_RU[Number(s.slice(5, 7)) - 1]} ${s.slice(2, 4)}`;
}

const yearNow = new Date().getFullYear();

export function PaymentCalendar() {
  const { companyId } = useApp();
  const [interval, setInterval_] = useState<string>("month");
  const [range, setRange] = useState({ date_from: `${yearNow}-01-01`, date_to: `${yearNow}-12-31` });
  const [accountId, setAccountId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [legalEntityId, setLegalEntityId] = useState("");
  const [method, setMethod] = useState<"cash" | "accrual">("cash");
  const [drill, setDrill] = useState<{ start: string; end: string; type: "income" | "outcome"; label: string } | null>(null);

  const accounts = useAccounts();
  const projects = useProjects();
  const legalEntities = useLegalEntities();

  const params = {
    company_id: companyId, interval, ...range,
    account_id: accountId || undefined, project_id: projectId || undefined,
    legal_entity_id: legalEntityId || undefined, method,
  };
  const q = useQuery({
    queryKey: ["payment-calendar", params],
    enabled: !!companyId,
    queryFn: async () => (await api.get<PC>("/api/reports/payment-calendar", { params })).data,
  });
  const r = q.data;
  const chart = (r?.rows ?? []).map((x) => ({ period: periodLabel(x, interval), Остаток: Number(x.closing) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Платёжный календарь</h1>
        {r && <ExportButton url="/api/reports/payment-calendar-export" params={params} filename={`payment_calendar_${range.date_from}.xlsx`} />}
      </div>

      {/* Фильтры */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Интервал</label>
          <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm">
            {INTERVALS.map(([k, lbl]) => (
              <button key={k} onClick={() => setInterval_(k)}
                className={`rounded px-2.5 py-1 ${interval === k ? "bg-white font-medium text-brand-dark shadow-sm" : "text-slate-600"}`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Быстрый период</label>
          <DatePresets className="!w-40" onSelect={(from, to) => setRange({ date_from: from, date_to: to })} />
        </div>
        <div>
          <label className="label">С даты</label>
          <input type="date" className="input !w-40" value={range.date_from} onChange={(e) => setRange({ ...range, date_from: e.target.value })} />
        </div>
        <div>
          <label className="label">По дату</label>
          <input type="date" className="input !w-40" value={range.date_to} onChange={(e) => setRange({ ...range, date_to: e.target.value })} />
        </div>
        <div>
          <label className="label">Счёт</label>
          <select className="input !w-44" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Все счета</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Проект</label>
          <select className="input !w-40" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Все проекты</option>
            {projects.data?.filter((p) => !p.is_archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {(legalEntities.data?.length ?? 0) > 0 && (
          <div>
            <label className="label">Юрлицо</label>
            <select className="input !w-40" value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
              <option value="">Все юрлица</option>
              {legalEntities.data?.map((le) => <option key={le.id} value={le.id}>{le.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label">Метод</label>
          <select className="input !w-40" value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="cash">По оплате</option>
            <option value="accrual">По начислению</option>
          </select>
        </div>
      </div>

      {r && r.overdue_count > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          ⚠️ Просроченные плановые операции: {r.overdue_count} на сумму {fmtNum(r.overdue_amount)} — их дата уже прошла, а оплата не подтверждена.
        </div>
      )}
      {r && r.has_gap && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          ⚠️ Кассовый разрыв: в выделенных красным периодах прогнозный остаток уходит в минус.
        </div>
      )}

      {r && (
        <div className="card">
          <h2 className="mb-2 font-semibold">Прогноз остатка на счетах</h2>
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <AreaChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
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
          <table className="table whitespace-nowrap text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-white">Показатель</th>
                {r.rows.map((x) => (
                  <th key={x.period} className={`text-right ${x.past ? "text-slate-400" : ""}`}>{periodLabel(x, interval)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <CalRow label="Остаток на начало" rows={r.rows} field="opening" />
              <ClickRow label="Поступления" rows={r.rows} field="income" cls="text-emerald-700"
                onCell={(x) => setDrill({ start: x.start, end: x.end, type: "income", label: periodLabel(x, interval) })} />
              <ClickRow label="Выплаты" rows={r.rows} field="outcome" cls="text-red-700"
                onCell={(x) => setDrill({ start: x.start, end: x.end, type: "outcome", label: periodLabel(x, interval) })} />
              <CalRow label="Денежный поток" rows={r.rows} field="net" bold />
              <tr className="font-semibold">
                <td className="sticky left-0 z-10 bg-white">Остаток на конец</td>
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

      {drill && (
        <DrillModal companyId={companyId!} drill={drill}
          params={{ account_id: accountId, project_id: projectId, legal_entity_id: legalEntityId }}
          onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

function CalRow({ label, rows, field, cls, bold }: { label: string; rows: any[]; field: string; cls?: string; bold?: boolean }) {
  return (
    <tr className={`${bold ? "font-semibold" : ""} ${cls ?? ""}`}>
      <td className="sticky left-0 z-10 bg-white">{label}</td>
      {rows.map((x) => <td key={x.period} className="text-right">{fmtNum(x[field])}</td>)}
    </tr>
  );
}

// Строка с кликабельными ячейками (drill-down к операциям периода).
function ClickRow({ label, rows, field, cls, onCell }: { label: string; rows: any[]; field: string; cls?: string; onCell: (x: any) => void }) {
  return (
    <tr className={cls ?? ""}>
      <td className="sticky left-0 z-10 bg-white">{label}</td>
      {rows.map((x) => (
        <td key={x.period} className="text-right">
          {Number(x[field]) ? (
            <button className="rounded px-1 hover:bg-brand-light/50 hover:underline" title="Показать операции" onClick={() => onCell(x)}>
              {fmtNum(x[field])}
            </button>
          ) : "—"}
        </td>
      ))}
    </tr>
  );
}

// Модалка с операциями выбранной ячейки.
function DrillModal({ companyId, drill, params, onClose }: {
  companyId: number; drill: { start: string; end: string; type: "income" | "outcome"; label: string };
  params: { account_id: string; project_id: string; legal_entity_id: string }; onClose: () => void;
}) {
  const parties = useCounterparties();
  const partyName = (id?: number | null) => parties.data?.find((p) => p.id === id)?.name;
  const q = useQuery({
    queryKey: ["pc-drill", companyId, drill, params],
    queryFn: async () => (await api.get<OperationList>("/api/operations", {
      params: {
        company_id: companyId, date_from: drill.start, date_to: drill.end, types: drill.type,
        account_id: params.account_id || undefined, project_id: params.project_id || undefined,
        legal_entity_id: params.legal_entity_id || undefined, limit: 500,
      },
    })).data,
  });
  const items = q.data?.items ?? [];
  const title = `${drill.type === "income" ? "Поступления" : "Выплаты"} · ${drill.label}`;
  return (
    <Modal title={title} onClose={onClose} wide>
      {q.isLoading ? (
        <p className="py-6 text-center text-slate-400">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-slate-400">Нет операций в этом периоде.</p>
      ) : (
        <table className="table text-sm">
          <thead>
            <tr><th>Дата</th><th>Контрагент / описание</th><th className="text-right">Сумма</th><th>Статус</th></tr>
          </thead>
          <tbody>
            {items.map((o: Operation) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{o.op_date}</td>
                <td>{partyName(o.counterparty_id) || o.description || "—"}</td>
                <td className="text-right tabular-nums">{fmtNum(o.amount)}</td>
                <td>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${o.status === "committed" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                    {o.status === "committed" ? "факт" : "план"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
