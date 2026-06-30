import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { fmtNum } from "../components/ReportControls";
import { ExportButton } from "../components/ExportButton";
import type { BalanceReport, BalanceSectionData } from "../api/types";

export function Balance() {
  const { companyId } = useApp();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));

  const q = useQuery({
    queryKey: ["balance", companyId, asOf],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<BalanceReport>("/api/reports/balance", { params: { company_id: companyId, as_of: asOf } })).data,
  });
  const r = q.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold">Балансовый отчёт</h1>
        <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">RUB</span>
      </div>
      <div className="card flex items-end gap-3">
        <div>
          <label className="label">На дату</label>
          <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        {r && (
          <div className={`ml-auto text-sm ${r.balanced ? "text-emerald-600" : "text-amber-600"}`}>
            {r.balanced ? "Баланс сходится" : `Расхождение: ${fmtNum(r.difference)} (упрощённый расчёт)`}
          </div>
        )}
        <div className={r ? "" : "ml-auto"}>
          <ExportButton
            url="/api/reports/balance/export"
            params={{ company_id: companyId, as_of: asOf }}
            filename={`balance_${asOf}.xlsx`}
          />
        </div>
      </div>

      {r && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-0">
            <div className="flex justify-between border-b bg-slate-50 px-4 py-2 font-bold">
              <span>АКТИВЫ</span><span>{fmtNum(r.assets.total)}</span>
            </div>
            <SectionList sections={r.assets.sections} />
          </div>
          <div className="card p-0">
            <div className="flex justify-between border-b bg-slate-50 px-4 py-2 font-bold">
              <span>ПАССИВЫ</span><span>{fmtNum(r.passive_total)}</span>
            </div>
            <SectionList sections={r.liabilities.sections} />
            <SectionList sections={r.capital.sections} />
          </div>
        </div>
      )}
    </div>
  );
}

function SectionList({ sections }: { sections: BalanceSectionData[] }) {
  return (
    <table className="table">
      <tbody>
        {sections.map((s) => (
          <tr key={s.key} className="align-top">
            <td className="w-full p-0">
              <div className="flex justify-between bg-slate-50/60 px-4 py-1.5 font-semibold">
                <span>{s.title}</span><span>{fmtNum(s.total)}</span>
              </div>
              {s.items.map((it, i) => (
                <div key={i} className="flex justify-between px-6 py-1.5 text-sm">
                  <span className="text-slate-600">{it.name}</span>
                  <span>{fmtNum(it.amount)}</span>
                </div>
              ))}
              {s.items.length === 0 && <div className="px-6 py-1.5 text-sm text-slate-300">—</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
