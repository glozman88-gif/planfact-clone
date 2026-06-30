import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";

export function Settings() {
  const { user, companies, companyId, reloadCompanies } = useApp();
  const [companyName, setCompanyName] = useState("");
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const currentCompany = companies.find((c) => c.id === companyId);
  const [lockDate, setLockDate] = useState("");
  const setPeriodLock = useMutation({
    mutationFn: (locked_until: string | null) =>
      api.put(`/api/companies/${companyId}/period-lock`, null, { params: { locked_until: locked_until ?? undefined } }),
    onSuccess: async (_d, locked_until) => {
      await reloadCompanies();
      setMsg(locked_until ? `Период закрыт до ${locked_until}` : "Блокировка периода снята");
    },
    onError: () => setMsg("Не удалось изменить блокировку периода"),
  });

  const createCompany = useMutation({
    mutationFn: (name: string) => api.post("/api/companies", { name, base_currency: "RUB" }),
    onSuccess: async () => {
      setCompanyName("");
      await reloadCompanies();
    },
  });

  const [u, setU] = useState({ email: "", full_name: "", password: "" });
  const createUser = useMutation({
    mutationFn: () => api.post("/api/auth/users", u),
    onSuccess: () => { setU({ email: "", full_name: "", password: "" }); setMsg("Пользователь создан"); },
    onError: () => setMsg("Не удалось создать пользователя"),
  });

  const importCsv = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post("/api/imports/operations-csv", fd, { params: { company_id: companyId } });
    },
    onSuccess: (r) => setMsg(`Импортировано операций: ${r.data.rows_imported} из ${r.data.rows_total}`),
    onError: () => setMsg("Ошибка импорта"),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Настройки</h1>

      <div className="card space-y-3">
        <h2 className="font-semibold">Компании</h2>
        <ul className="text-sm text-slate-600">
          {companies.map((c) => <li key={c.id}>• {c.name} ({c.base_currency})</li>)}
        </ul>
        <div className="flex gap-2">
          <input className="input" placeholder="Название новой компании" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          <button className="btn-primary" onClick={() => companyName && createCompany.mutate(companyName)}>Создать</button>
        </div>
        <p className="text-xs text-slate-400">При создании компании автоматически заводятся типовые статьи, счёт и этапы сделок.</p>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Закрытие периода</h2>
        <p className="text-xs text-slate-500">
          После закрытия периода операции с датой по выбранную включительно нельзя создавать,
          изменять и удалять — отчёты прошлых периодов фиксируются.
        </p>
        <div className="text-sm">
          Текущая блокировка:{" "}
          {currentCompany?.period_locked_until
            ? <b>до {currentCompany.period_locked_until} включительно</b>
            : <span className="text-slate-400">не установлена</span>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">Закрыть период до даты</label>
            <input type="date" className="input" value={lockDate} onChange={(e) => setLockDate(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={!lockDate || setPeriodLock.isPending}
            onClick={() => setPeriodLock.mutate(lockDate)}>
            Закрыть период
          </button>
          {currentCompany?.period_locked_until && (
            <button className="btn-ghost text-red-500" disabled={setPeriodLock.isPending}
              onClick={() => setPeriodLock.mutate(null)}>
              Снять блокировку
            </button>
          )}
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="font-semibold">Импорт операций из CSV</h2>
        <p className="text-xs text-slate-500">Колонки: date, type (income/outcome), amount, account, category, counterparty, description. Разделитель ; или ,.</p>
        <input ref={fileRef} type="file" accept=".csv" className="text-sm" />
        <button
          className="btn-primary"
          onClick={() => { const f = fileRef.current?.files?.[0]; if (f) importCsv.mutate(f); }}
          disabled={importCsv.isPending}
        >
          {importCsv.isPending ? "Импорт…" : "Импортировать"}
        </button>
      </div>

      {user?.is_admin && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Создать пользователя</h2>
          <div className="grid grid-cols-3 gap-2">
            <input className="input" placeholder="Email" value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} />
            <input className="input" placeholder="Имя" value={u.full_name} onChange={(e) => setU({ ...u, full_name: e.target.value })} />
            <input className="input" placeholder="Пароль" type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} />
          </div>
          <button className="btn-primary" onClick={() => createUser.mutate()}>Создать пользователя</button>
        </div>
      )}

      {msg && <div className="text-sm text-brand">{msg}</div>}
    </div>
  );
}
