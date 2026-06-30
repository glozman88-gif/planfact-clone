import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { Sparkline } from "./Sparkline";
import type { AccountBalance, Dashboard } from "../api/types";

// Иконки разделов (минималистичные line-icon)
const Icon = ({ d }: { d: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICONS = {
  dash: "M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z",
  ops: "M4 6h16M4 12h16M4 18h10",
  deals: "M3 7h18v13H3zM3 7l3-4h12l3 4M9 12h6",
  plan: "M3 4h18v18H3zM3 9h18M8 3v4M16 3v4",
  projects: "M3 7h7l2 2h9v11H3zM3 7V5h5l2 2",
  reports: "M4 4v16h16M8 16V9M12 16V5M16 16v-6",
  refs: "M4 5h16M4 12h16M4 19h16",
  repeat: "M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  import: "M12 3v12M8 11l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  settings: "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2M19 12h2M12 3v2M12 19v2",
};

interface NavGroup {
  to: string;
  label: string;
  icon: keyof typeof ICONS;
  end?: boolean;
  children?: { to: string; label: string }[];
}
const NAV: NavGroup[] = [
  { to: "/", label: "Показатели", icon: "dash", end: true },
  { to: "/operations", label: "Операции", icon: "ops" },
  { to: "/recurring", label: "Повторяющиеся", icon: "repeat" },
  { to: "/deals", label: "Сделки", icon: "deals" },
  {
    to: "/budget/calendar", label: "План", icon: "plan",
    children: [
      { to: "/budget/calendar", label: "Платёжный календарь" },
      { to: "/budget/bdr", label: "Бюджет доходов и расходов" },
      { to: "/budget/bdds", label: "Бюджет движения денег" },
    ],
  },
  { to: "/projects", label: "Проекты", icon: "projects" },
  {
    to: "/reports/cashflow", label: "Отчёты", icon: "reports",
    children: [
      { to: "/reports/cashflow", label: "Движение денег (ДДС)" },
      { to: "/reports/pnl", label: "Прибыли и убытки (ОПиУ)" },
      { to: "/reports/balance", label: "Баланс" },
    ],
  },
  {
    to: "/counterparties", label: "Справочники", icon: "refs",
    children: [
      { to: "/counterparties", label: "Контрагенты" },
      { to: "/categories", label: "Учётные статьи" },
      { to: "/accounts", label: "Мои счета" },
      { to: "/legal-entities", label: "Юридические лица" },
      { to: "/products", label: "Товары и услуги" },
    ],
  },
  { to: "/import", label: "Импорт", icon: "import" },
  { to: "/settings", label: "Настройки", icon: "settings" },
];

export function Layout() {
  const { user, companies, companyId, setCompanyId, logout } = useApp();

  const balances = useQuery({
    queryKey: ["balances", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<AccountBalance[]>("/api/account-balances", { params: { company_id: companyId } })).data,
  });
  const total = (balances.data ?? []).reduce((s, b) => s + Number(b.balance), 0);

  const year = new Date().getFullYear();
  const dash = useQuery({
    queryKey: ["dashboard-mini", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<Dashboard>("/api/reports/dashboard", { params: { company_id: companyId, date_from: `${year}-01-01`, date_to: `${year}-12-31` } })).data,
  });
  const trend = (dash.data?.series ?? []).map((s) => Number(s.closing));

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col bg-sidebar text-slate-300">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand font-bold text-white">ПФ</span>
          <span className="text-sm font-semibold text-white">ПланФакт</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
          {NAV.map((n) => (
            <div key={n.to}>
              <NavLink
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
                    isActive ? "bg-sidebar-hover text-white" : "text-slate-300 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <span className="text-brand"><Icon d={ICONS[n.icon]} /></span>
                {n.label}
              </NavLink>
              {n.children && (
                <div className="ml-9 mt-0.5 space-y-0.5">
                  {n.children.map((c) => (
                    <NavLink
                      key={c.to}
                      to={c.to}
                      className={({ isActive }) =>
                        `block rounded px-2 py-1 text-xs ${isActive ? "text-brand" : "text-slate-400 hover:text-white"}`
                      }
                    >
                      {c.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-sidebar px-6 py-2 text-slate-200">
          <div className="flex items-center gap-3">
            <select
              className="rounded-md border border-slate-600 bg-sidebar-hover px-2 py-1 text-sm text-white outline-none"
              value={companyId ?? ""}
              onChange={(e) => setCompanyId(Number(e.target.value))}
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-xs text-slate-400">На счетах</div>
              <div className="font-semibold text-white">{money(total)}</div>
            </div>
            <Sparkline values={trend} color="#16b1bf" width={80} height={28} />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-300">{user?.email}</span>
            <button onClick={logout} className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-sidebar-hover">
              Выйти
            </button>
          </div>
        </header>
        <div className="flex-1 bg-slate-100 p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
