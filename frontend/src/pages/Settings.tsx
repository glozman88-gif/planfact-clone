import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import type { User } from "../api/types";

type Page = "general" | "users" | "period" | "currencies" | "data";

const NAV: { key: Page; label: string }[] = [
  { key: "general", label: "Общие настройки" },
  { key: "users", label: "Пользователи" },
  { key: "period", label: "Закрытие периода" },
  { key: "currencies", label: "Курсы валют" },
  { key: "data", label: "Удаление данных" },
];

export function Settings() {
  const [page, setPage] = useState<Page>("general");
  return (
    <div className="flex gap-4">
      <aside className="w-56 shrink-0">
        <div className="card p-2">
          <div className="mb-1 px-2 py-1 text-xs font-semibold uppercase text-slate-400">Настройки</div>
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setPage(n.key)}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm ${page === n.key ? "bg-brand-light font-medium text-brand-dark" : "text-slate-600 hover:bg-slate-50"}`}>
              {n.label}
            </button>
          ))}
          <div className="my-1 border-t" />
          <div className="px-2 py-1 text-xs font-semibold uppercase text-slate-400">Интеграции</div>
          <Link to="/bank-integration" className="block rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50">Банки и карты</Link>
          <Link to="/import" className="block rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50">Импорт и правила</Link>
        </div>
      </aside>
      <div className="min-w-0 max-w-3xl flex-1">
        {page === "general" && <GeneralSettings />}
        {page === "users" && <UsersSettings />}
        {page === "period" && <PeriodSettings />}
        {page === "currencies" && <CurrenciesSettings />}
        {page === "data" && <DataSettings />}
      </div>
    </div>
  );
}

const TOGGLES: { key: string; label: string; group: string }[] = [
  { group: "Создание и редактирование операций", key: "show_accrual_date_field", label: "Показывать поле «Дата начисления» при добавлении операции" },
  { group: "Создание и редактирование операций", key: "optional_payment_purpose", label: "Сделать поле «Назначение платежа» необязательным" },
  { group: "Список операций", key: "show_income_categories_in_ops", label: "Отображать категорию статей (доходы, расходы и др.) в списке операций" },
  { group: "Настройки отображения", key: "show_kopecks", label: "Отображать копейки" },
  { group: "Настройки отображения", key: "show_past_gaps", label: "Показывать прошлые кассовые разрывы в верхней панели" },
  { group: "Настройки отображения", key: "hide_hints", label: "Скрыть подсказки-вопросы" },
];
const DEFAULT_ON = new Set(["show_kopecks"]);

function GeneralSettings() {
  const { companies, companyId, reloadCompanies } = useApp();
  const company = companies.find((c) => c.id === companyId);
  const [name, setName] = useState(company?.name ?? "");
  const [currency, setCurrency] = useState(company?.base_currency ?? "RUB");
  const [settings, setSettings] = useState<Record<string, boolean>>({ ...(company?.settings ?? {}) });
  const [msg, setMsg] = useState("");
  const [newCompany, setNewCompany] = useState("");

  const val = (k: string) => (settings[k] === undefined ? DEFAULT_ON.has(k) : settings[k]);
  const toggle = (k: string) => setSettings({ ...settings, [k]: !val(k) });

  const saveCompany = useMutation({
    mutationFn: () => api.put(`/api/companies/${companyId}`, { name, inn: company?.inn ?? null, base_currency: currency }),
    onSuccess: async () => { await reloadCompanies(); setMsg("Настройки компании сохранены"); },
  });
  const saveSettings = useMutation({
    mutationFn: () => api.put(`/api/companies/${companyId}/settings`, TOGGLES.reduce((o, t) => ({ ...o, [t.key]: val(t.key) }), {})),
    onSuccess: async () => { await reloadCompanies(); setMsg("Настройки сохранены"); },
  });
  const createCompany = useMutation({
    mutationFn: () => api.post("/api/companies", { name: newCompany, base_currency: "RUB" }),
    onSuccess: async () => { setNewCompany(""); await reloadCompanies(); setMsg("Компания создана"); },
  });

  const groups = [...new Set(TOGGLES.map((t) => t.group))];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Общие настройки</h1>

      <div className="card space-y-3">
        <h2 className="font-semibold">Компания</h2>
        <div className="grid grid-cols-[150px_1fr] items-center gap-3 text-sm">
          <label className="text-slate-600">Название</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="text-slate-600">Основная валюта</label>
          <select className="input !w-40" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["RUB", "USD", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button className="btn-primary w-fit" disabled={saveCompany.isPending} onClick={() => saveCompany.mutate()}>Сохранить</button>
      </div>

      <div className="card space-y-4">
        {groups.map((g) => (
          <div key={g} className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">{g}</h3>
            {TOGGLES.filter((t) => t.group === g).map((t) => (
              <label key={t.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={val(t.key)} onChange={() => toggle(t.key)} />
                {t.label}
              </label>
            ))}
          </div>
        ))}
        <button className="btn-primary w-fit" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>Сохранить изменения</button>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Компании</h2>
        <ul className="text-sm text-slate-600">{companies.map((c) => <li key={c.id}>• {c.name} ({c.base_currency})</li>)}</ul>
        <div className="flex gap-2">
          <input className="input" placeholder="Название новой компании" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} />
          <button className="btn-primary" onClick={() => newCompany && createCompany.mutate()}>Создать</button>
        </div>
      </div>

      {msg && <div className="text-sm text-brand">{msg}</div>}
    </div>
  );
}

function UsersSettings() {
  const { user } = useApp();
  const [u, setU] = useState({ email: "", full_name: "", password: "" });
  const [msg, setMsg] = useState("");
  const users = useQuery({ queryKey: ["users"], enabled: !!user?.is_admin, queryFn: async () => (await api.get<User[]>("/api/auth/users")).data });
  const create = useMutation({
    mutationFn: () => api.post("/api/auth/users", u),
    onSuccess: () => { setU({ email: "", full_name: "", password: "" }); setMsg("Пользователь создан"); users.refetch(); },
    onError: () => setMsg("Не удалось создать пользователя (email занят?)"),
  });
  if (!user?.is_admin) return <div className="card text-sm text-slate-500">Раздел доступен только администратору.</div>;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Пользователи</h1>
      <div className="card p-0">
        <table className="table text-sm">
          <thead><tr><th>Email</th><th>Имя</th><th>Роль</th><th>Статус</th></tr></thead>
          <tbody>
            {users.data?.map((x) => (
              <tr key={x.id}><td>{x.email}</td><td>{x.full_name ?? "—"}</td>
                <td>{x.is_admin ? "Администратор" : "Пользователь"}</td>
                <td>{x.is_active ? <span className="text-emerald-600">активен</span> : <span className="text-slate-400">отключён</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card space-y-3">
        <h2 className="font-semibold">Создать пользователя</h2>
        <div className="grid grid-cols-3 gap-2">
          <input className="input" placeholder="Email" value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} />
          <input className="input" placeholder="Имя" value={u.full_name} onChange={(e) => setU({ ...u, full_name: e.target.value })} />
          <input className="input" placeholder="Пароль" type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} />
        </div>
        <button className="btn-primary w-fit" onClick={() => create.mutate()}>Создать пользователя</button>
      </div>
      {msg && <div className="text-sm text-brand">{msg}</div>}
    </div>
  );
}

function PeriodSettings() {
  const { companies, companyId, reloadCompanies } = useApp();
  const company = companies.find((c) => c.id === companyId);
  const [lockDate, setLockDate] = useState("");
  const [msg, setMsg] = useState("");
  const setLock = useMutation({
    mutationFn: (locked_until: string | null) => api.put(`/api/companies/${companyId}/period-lock`, null, { params: { locked_until: locked_until ?? undefined } }),
    onSuccess: async (_d, locked_until) => { await reloadCompanies(); setMsg(locked_until ? `Период закрыт до ${locked_until}` : "Блокировка снята"); },
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Закрытие периода</h1>
      <div className="card space-y-3">
        <p className="text-sm text-slate-500">После закрытия периода операции с датой по выбранную включительно нельзя создавать, изменять и удалять.</p>
        <div className="text-sm">Текущая блокировка: {company?.period_locked_until ? <b>до {company.period_locked_until} включительно</b> : <span className="text-slate-400">не установлена</span>}</div>
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label">Закрыть период до даты</label><input type="date" className="input" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></div>
          <button className="btn-primary" disabled={!lockDate} onClick={() => setLock.mutate(lockDate)}>Закрыть период</button>
          {company?.period_locked_until && <button className="btn-ghost text-red-500" onClick={() => setLock.mutate(null)}>Снять блокировку</button>}
        </div>
        {msg && <div className="text-sm text-brand">{msg}</div>}
      </div>
    </div>
  );
}

function CurrenciesSettings() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Курсы валют</h1>
      <div className="card space-y-2 text-sm text-slate-600">
        <p>Основная валюта задаётся в разделе «Общие настройки». Поддерживаются RUB, USD, EUR.</p>
        <p className="text-slate-400">Курсы для мультивалютных операций подставляются на дату операции; ручное ведение курсов будет добавлено.</p>
      </div>
    </div>
  );
}

function DataSettings() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Удаление данных</h1>
      <div className="card space-y-2 border border-red-200 text-sm">
        <p className="text-slate-600">Полное удаление данных компании — необратимая операция. Рекомендуем сначала выгрузить отчёты и операции в Excel (кнопки «.xls» и «Экспорт в Excel» в отчётах и операциях).</p>
        <p className="text-red-500">Массовое удаление операций доступно в разделе «Операции» (выделение чекбоксами → «Удалить выбранные»).</p>
      </div>
    </div>
  );
}
