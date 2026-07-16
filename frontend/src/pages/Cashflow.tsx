import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useCounterparties, useLegalEntities } from "../api/hooks";
import { RangePicker, IntervalPicker, defaultRange, fmtNum, type Range } from "../components/ReportControls";
import { ExportButton } from "../components/ExportButton";
import { SearchSelect } from "../components/SearchSelect";
import { Sparkline } from "../components/Sparkline";
import type { CashflowReport } from "../api/types";

const vals = (m: Record<string, string>, periods: string[]) => periods.map((p) => Number(m[p] || 0));

export function Cashflow() {
  const { companyId } = useApp();
  const [range, setRange] = useState<Range>(defaultRange());
  const [groupBy, setGroupBy] = useState<"category" | "project" | "deal">("category");
  const [legalEntityId, setLegalEntityId] = useState("");
  const [interval, setInterval_] = useState("month");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [accountId, setAccountId] = useState("");
  const legalEntities = useLegalEntities();
  const accounts = useAccounts();
  const parties = useCounterparties();

  const q = useQuery({
    queryKey: ["cashflow", companyId, range, groupBy, legalEntityId, interval, counterpartyId, accountId],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<CashflowReport>("/api/reports/cashflow", { params: { company_id: companyId, group_by: groupBy, legal_entity_id: legalEntityId || undefined, interval, counterparty_id: counterpartyId || undefined, account_id: accountId || undefined, ...range } })).data,
  });
  const r = q.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold">Отчёт о движении денежных средств</h1>
        <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">RUB</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <RangePicker range={range} onChange={setRange} />
        <IntervalPicker value={interval} onChange={setInterval_} />
        <div className="card flex gap-1 p-1">
          {([["category", "По статьям"], ["project", "По проектам"], ["deal", "По сделкам"]] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setGroupBy(k)}
              className={`rounded-md px-3 py-1.5 text-sm ${groupBy === k ? "bg-brand-light font-medium text-brand-dark ring-1 ring-brand" : "text-slate-600"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
        {(legalEntities.data?.length ?? 0) > 0 && (
          <SearchSelect className="!w-48" value={legalEntityId} onChange={setLegalEntityId}
            options={legalEntities.data ?? []} emptyLabel="Все юрлица" placeholder="Все юрлица" />
        )}
        <SearchSelect className="!w-48" value={counterpartyId} onChange={setCounterpartyId}
          options={parties.data ?? []} emptyLabel="Все контрагенты" placeholder="Все контрагенты" />
        <SearchSelect className="!w-44" value={accountId} onChange={setAccountId}
          options={accounts.data ?? []} emptyLabel="Все счета" placeholder="Все счета" />
        <div className="ml-auto">
          <ExportButton
            url="/api/reports/cashflow/export"
            params={{ company_id: companyId, legal_entity_id: legalEntityId || undefined, ...range }}
            filename={`cashflow_${range.date_from}_${range.date_to}.xlsx`}
          />
        </div>
      </div>

      {r && r.groups && (
        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white">{groupBy === "project" ? "Проект" : "Сделка"}</th>
                <th className="text-center">Тренд</th>
                {r.periods.map((p) => <th key={p} className="text-right">{p}</th>)}
                <th className="text-right">Поток</th>
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g) => (
                <Row key={g.key ?? "none"} label={g.name} periods={r.periods} values={g.net_by_period} total={g.net_total} />
              ))}
              <Row label="Общий денежный поток" periods={r.periods} values={r.net_by_period} total={r.net_total} bold bg="bg-brand-light" />
            </tbody>
          </table>
        </div>
      )}

      {r && !r.groups && (
        <div className="card overflow-x-auto p-0">
          <table className="table whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white">По статьям учёта</th>
                <th className="text-center">Тренд</th>
                {r.periods.map((p) => <th key={p} className="text-right">{p}</th>)}
                <th className="text-right">Итого</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Остаток на начало" periods={r.periods} values={r.opening_by_period} bg="bg-slate-50" bold />
              {r.activities.map((a) => (
                <ActivityBlock key={a.key} a={a} periods={r.periods} />
              ))}
              <Section title="Перемещения" color="text-slate-700">
                <Row label="Списания" periods={r.periods} values={r.moves.writeoff_by_period} indent />
                <Row label="Зачисления" periods={r.periods} values={r.moves.deposit_by_period} indent />
              </Section>
              <Row label="Общий денежный поток" periods={r.periods} values={r.net_by_period} total={r.net_total} bold bg="bg-brand-light" />
              <Row label="Остаток на конец периода" periods={r.periods} values={r.closing_by_period} bold bg="bg-slate-50" />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityBlock({ a, periods }: { a: CashflowReport["activities"][0]; periods: string[] }) {
  return (
    <>
      <Row label={a.title} periods={periods} values={a.net_by_period} total={a.net_total} bold bg="bg-slate-50" />
      <Row label="Поступления" periods={periods} values={a.income.by_period} total={a.income.total} indent className="font-medium text-emerald-700" />
      {a.income.categories.map((c) => (
        <Row key={"i" + c.category_id} label={c.name} periods={periods} values={c.by_period} total={c.total} indent2 muted />
      ))}
      <Row label="Выплаты" periods={periods} values={a.outcome.by_period} total={a.outcome.total} indent className="font-medium text-red-700" />
      {a.outcome.categories.map((c) => (
        <Row key={"o" + c.category_id} label={c.name} periods={periods} values={c.by_period} total={c.total} indent2 muted />
      ))}
    </>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: any }) {
  return (
    <>
      <tr className={`font-semibold ${color}`}>
        <td className="sticky left-0 bg-white" colSpan={99}>{title}</td>
      </tr>
      {children}
    </>
  );
}

function Row({
  label, periods, values, total, bold, indent, indent2, muted, bg, className,
}: {
  label: string; periods: string[]; values: Record<string, string>; total?: string;
  bold?: boolean; indent?: boolean; indent2?: boolean; muted?: boolean; bg?: string; className?: string;
}) {
  const series = vals(values, periods);
  const sum = total !== undefined ? Number(total) : series.reduce((s, v) => s + v, 0);
  return (
    <tr className={`${bold ? "font-semibold" : ""} ${bg ?? ""} ${className ?? ""}`}>
      <td className={`sticky left-0 ${bg ?? "bg-white"} ${indent ? "pl-6" : ""} ${indent2 ? "pl-10" : ""} ${muted ? "text-slate-500" : ""}`}>
        {label}
      </td>
      <td className="py-0 text-center"><Sparkline values={series} /></td>
      {periods.map((p) => <td key={p} className={`text-right ${muted ? "text-slate-500" : ""}`}>{fmtNum(values[p])}</td>)}
      <td className="text-right">{fmtNum(String(sum))}</td>
    </tr>
  );
}
