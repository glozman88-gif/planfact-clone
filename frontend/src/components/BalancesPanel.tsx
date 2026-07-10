import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useLegalEntities } from "../api/hooks";
import type { AccountBalance } from "../api/types";

const KIND_LABEL: Record<string, string> = {
  cash: "Наличные", bank: "Расчётные счета", card: "Карты", ewallet: "Электронные кошельки", other: "Прочие счета",
};
const KIND_ORDER = ["cash", "bank", "card", "ewallet", "other"];

export function BalancesPanel() {
  const { companyId } = useApp();
  const accounts = useAccounts();
  const legalEntities = useLegalEntities();
  const balances = useQuery({
    queryKey: ["balances", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<AccountBalance[]>("/api/account-balances", { params: { company_id: companyId } })).data,
  });
  const [mode, setMode] = useState<"groups" | "entities">("groups");
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const expanded = (key: string) => (open[key] !== undefined ? open[key] : !compact);
  const toggle = (key: string) => setOpen({ ...open, [key]: !expanded(key) });

  const balMap = useMemo(() => new Map((balances.data ?? []).map((b) => [b.account_id, Number(b.balance)])), [balances.data]);
  const active = useMemo(() => (accounts.data ?? []).filter((a) => !a.is_archived), [accounts.data]);
  const leName = (id?: number | null) => (id == null ? "Без юрлица" : legalEntities.data?.find((l) => l.id === id)?.name ?? "Без юрлица");
  const total = active.reduce((s, a) => s + (balMap.get(a.id) ?? 0), 0);

  const groups = useMemo(() => {
    const g: { key: string; title: string; accounts: any[]; sum: number }[] = [];
    const sumOf = (accs: any[]) => accs.reduce((s, a) => s + (balMap.get(a.id) ?? 0), 0);
    if (mode === "groups") {
      for (const k of KIND_ORDER) {
        const accs = active.filter((a) => !a.is_undistributed && a.kind === k);
        if (accs.length) g.push({ key: k, title: KIND_LABEL[k], accounts: accs, sum: sumOf(accs) });
      }
      const undist = active.filter((a) => a.is_undistributed);
      if (undist.length) g.push({ key: "undist", title: "Нераспределённые", accounts: undist, sum: sumOf(undist) });
    } else {
      const byLe = new Map<number | null, any[]>();
      for (const a of active) {
        const key = a.legal_entity_id ?? null;
        if (!byLe.has(key)) byLe.set(key, []);
        byLe.get(key)!.push(a);
      }
      for (const [key, accs] of byLe) g.push({ key: "le" + key, title: leName(key), accounts: accs, sum: sumOf(accs) });
    }
    return g;
  }, [active, mode, balMap, legalEntities.data]);

  const archived = (accounts.data ?? []).filter((a) => a.is_archived);
  const today = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="w-[380px] max-w-[92vw] rounded-lg border bg-white text-slate-700 shadow-2xl">
      <div className="flex items-start justify-between gap-2 border-b p-3">
        <div>
          <div className="text-xl font-bold">{money(total)}</div>
          <div className="text-xs text-slate-400">{today}</div>
        </div>
        <div className="card flex gap-1 p-0.5 text-xs">
          {([["groups", "По группам"], ["entities", "По юрлицам"]] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`rounded px-2 py-1 ${mode === k ? "bg-brand-light font-medium text-brand-dark" : "text-slate-500"}`}>{lbl}</button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end px-3 py-1.5">
        <button className="text-xs text-brand hover:underline" onClick={() => { setCompact(!compact); setOpen({}); }}>
          {compact ? "Развернуть группы" : "Свернуть группы"}
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.key} className="mb-1 rounded-md">
            <button className="flex w-full items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm font-medium hover:bg-slate-100"
              onClick={() => toggle(g.key)}>
              <span className="flex items-center gap-1">
                <span className="w-3 text-slate-400">{expanded(g.key) ? "▾" : "▸"}</span>
                {g.title} <span className="text-slate-400">({g.accounts.length})</span>
              </span>
              <span className={g.sum < 0 ? "text-red-600" : ""}>{money(g.sum)}</span>
            </button>
            {expanded(g.key) && g.accounts.map((a) => {
              const bal = balMap.get(a.id) ?? 0;
              return (
                <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="flex items-center gap-1.5 truncate">
                    <span className={`h-1.5 w-1.5 rounded-full ${bal < 0 ? "bg-red-500" : "bg-emerald-400"}`} />
                    <span className="truncate" title={a.name}>{a.name}</span>
                    {bal < 0 && <span className="whitespace-nowrap text-xs text-red-500">разрыв</span>}
                  </span>
                  <span className={`whitespace-nowrap ${bal < 0 ? "text-red-600" : ""}`}>{money(bal)}</span>
                </div>
              );
            })}
          </div>
        ))}
        {archived.length > 0 && (
          <div className="px-3 py-2 text-sm text-slate-400">Архивные счета ({archived.length})</div>
        )}
        {active.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">Нет счетов</div>}
      </div>
    </div>
  );
}
