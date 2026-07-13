import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts } from "../api/hooks";
import { Modal } from "../components/Modal";
import type { AccountBalance } from "../api/types";

interface Bank {
  slug: string; name: string; method: "token" | "oauth"; docs: string; hint: string;
  authorize?: string; scope?: string; color: string;
}

const BANKS: Bank[] = [
  { slug: "tochka", name: "Точка", method: "token", docs: "https://developers.tochka.com/", color: "bg-violet-500",
    hint: "В интернет-банке: «Интеграции и API» → создайте JWT-ключ с доступом к выпискам." },
  { slug: "tbank", name: "Т-Банк", method: "token", docs: "https://developer.tbank.ru/", color: "bg-yellow-500",
    hint: "В Т-Бизнесе выпустите токен T-API (Bearer) с доступом к счетам и выпискам." },
  { slug: "modulbank", name: "Модульбанк", method: "token", docs: "https://modulbank.ru/api", color: "bg-indigo-500",
    hint: "В личном кабинете → раздел API сгенерируйте токен." },
  { slug: "blank", name: "Бланк", method: "token", docs: "https://blank.ru/", color: "bg-slate-800",
    hint: "В кабинете банка получите API-токен." },
  { slug: "zenmoney", name: "Дзен-мани", method: "token", docs: "https://zenmoney.ru/", color: "bg-orange-500",
    hint: "В профиле Дзен-мани создайте API-токен." },
  { slug: "sber", name: "СберБизнес", method: "oauth", docs: "https://developers.sber.ru/docs/ru/sber-api/", color: "bg-emerald-600",
    authorize: "https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize", scope: "GET_STATEMENT_ACCOUNT",
    hint: "Зарегистрируйте приложение (заявка на fintech_API@sberbank.ru), получите client_id и client_secret." },
  { slug: "alfa", name: "Альфа-Банк", method: "oauth", docs: "https://developers.alfabank.ru/", color: "bg-red-600",
    authorize: "https://oauth.alfabank.ru/authorize", scope: "accounts statements",
    hint: "Зарегистрируйте приложение в Альфа-Бизнес, получите client_id и client_secret." },
];

export function BankIntegration() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [editing, setEditing] = useState<{ bank: Bank; conn?: any } | null>(null);
  const balances = useQuery({
    queryKey: ["balances", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<AccountBalance[]>("/api/account-balances", { params: { company_id: companyId } })).data,
  });
  const conns = useQuery({
    queryKey: ["bank-connections", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<any[]>("/api/bank-connections", { params: { company_id: companyId } })).data,
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api/bank-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-connections"] }),
  });
  const connsOf = (slug: string) => (conns.data ?? []).filter((c) => c.bank === slug);
  const statusBadge = (s: string) =>
    s === "connected" ? <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">Подключён</span>
      : <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Требуется авторизация</span>;

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-bold">Банки и карты</h1>
      <p className="text-sm text-slate-500">
        Подключите банк по API и сопоставьте счета банка со счетами в приложении — движения
        (приход, расход, перемещения) будут поступать на нужный счёт. Для одного банка можно создать
        несколько подключений (например, разные юрлица). Также данные можно загрузить вручную через
        <a className="ml-1 text-brand hover:underline" href="/import">Импорт</a>.
      </p>

      <div className="space-y-3">
        {BANKS.map((b) => {
          const list = connsOf(b.slug);
          return (
            <div key={b.slug} className="card p-0">
              <div className="flex items-center gap-3 border-b p-3">
                <span className={`flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold text-white ${b.color}`}>{b.name[0]}</span>
                <div className="flex-1">
                  <div className="font-medium">{b.name}</div>
                  <div className="text-xs text-slate-400">{b.method === "token" ? "Подключение по API-токену" : "Подключение по OAuth 2.0"}</div>
                </div>
                <button className="btn-ghost" onClick={() => setEditing({ bank: b })}>+ Добавить подключение</button>
              </div>
              {list.length === 0 ? (
                <div className="px-4 py-3 text-sm text-slate-400">Нет подключений — нажмите «Добавить подключение».</div>
              ) : (
                <div className="divide-y">
                  {list.map((c) => (
                    <div key={c.id} className="p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="font-medium">{c.title || "(без названия)"}</span>
                        {statusBadge(c.status)}
                        <div className="ml-auto flex gap-3 text-sm">
                          <button className="text-brand hover:underline" onClick={() => setEditing({ bank: b, conn: c })}>Настроить</button>
                          <button className="text-red-500 hover:underline" onClick={() => confirm("Удалить подключение?") && del.mutate(c.id)}>Отключить</button>
                        </div>
                      </div>
                      <MappingsSection connId={c.id} accounts={accounts.data ?? []} balances={balances.data ?? []} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-400">Вашего банка нет в списке? Загрузите выписку через раздел «Импорт» (Excel/CSV, 1С, Тинькофф, Сбер).</p>

      {editing && (
        <ConnectModal bank={editing.bank} conn={editing.conn} companyId={companyId}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["bank-connections"] }); setEditing(null); }} />
      )}
    </div>
  );
}

// Сопоставление счетов банка со счетами приложения (несколько на подключение)
function MappingsSection({ connId, accounts, balances }: any) {
  const qc = useQueryClient();
  const maps = useQuery({ queryKey: ["bank-maps", connId], queryFn: async () => (await api.get(`/api/bank-connections/${connId}/accounts`)).data as any[] });
  const [ba, setBa] = useState("");
  const [acc, setAcc] = useState("");
  const inv = () => qc.invalidateQueries({ queryKey: ["bank-maps", connId] });
  const add = useMutation({ mutationFn: () => api.post(`/api/bank-connections/${connId}/accounts`, { bank_account: ba, account_id: acc ? Number(acc) : null }), onSuccess: () => { setBa(""); setAcc(""); inv(); } });
  const upd = useMutation({ mutationFn: (v: any) => api.put(`/api/bank-connections/accounts/${v.id}`, { bank_account: v.bank_account, account_id: v.account_id }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: number) => api.delete(`/api/bank-connections/accounts/${id}`), onSuccess: inv });
  const balOf = (accId?: number | null) => balances.find((x: any) => x.account_id === accId)?.balance;

  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Счета банка → счёт в приложении</div>
      <table className="table text-sm">
        <thead><tr><th>Счёт в банке</th><th>Счёт в приложении</th><th className="text-right">Остаток</th><th>Движения</th><th></th></tr></thead>
        <tbody>
          {maps.data?.map((m) => (
            <tr key={m.id}>
              <td className="font-mono">{m.bank_account}</td>
              <td>
                <select className="input !w-52" value={m.account_id ?? ""} onChange={(e) => upd.mutate({ id: m.id, bank_account: m.bank_account, account_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— не выбран —</option>
                  {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </td>
              <td className="text-right">{m.account_id ? money(balOf(m.account_id) ?? 0) : "—"}</td>
              <td>{m.account_id ? <Link className="text-brand hover:underline" to={`/operations?account_id=${m.account_id}`}>Приход/расход →</Link> : <span className="text-slate-300">—</span>}</td>
              <td className="text-right"><button className="text-red-400 hover:text-red-600" onClick={() => del.mutate(m.id)}>×</button></td>
            </tr>
          ))}
          {maps.data?.length === 0 && <tr><td colSpan={5} className="py-2 text-center text-slate-400">Счета банка ещё не сопоставлены</td></tr>}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div><div className="label">Счёт в банке (номер/название)</div>
          <input className="input font-mono" value={ba} onChange={(e) => setBa(e.target.value)} placeholder="40702810…" /></div>
        <div><div className="label">Счёт в приложении</div>
          <select className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>
            <option value="">— выберите —</option>
            {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></div>
        <button className="btn-ghost" disabled={!ba.trim() || add.isPending} onClick={() => add.mutate()}>+ Добавить счёт банка</button>
      </div>
    </div>
  );
}

function ConnectModal({ bank, conn, companyId, onClose, onSaved }: any) {
  const [title, setTitle] = useState(conn?.title ?? "");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(conn?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const body = () => ({ bank: bank.slug, title: title || null, token: token || null, client_id: clientId || null, client_secret: clientSecret || null });
  const save = useMutation({
    mutationFn: () => conn ? api.put(`/api/bank-connections/${conn.id}`, body()) : api.post("/api/bank-connections", body(), { params: { company_id: companyId } }),
    onSuccess: onSaved,
  });
  const authorizeUrl = () => {
    const redirect = `${location.origin}/bank-oauth-callback`;
    const p = new URLSearchParams({ response_type: "code", client_id: clientId, scope: bank.scope || "", redirect_uri: redirect, state: `${bank.slug}:${conn?.id ?? "new"}` });
    return `${bank.authorize}?${p.toString()}`;
  };
  return (
    <Modal title={`${conn ? "Настройка" : "Новое подключение"} — ${bank.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div>
          <label className="label">Название подключения</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: ООО «Ромашка»" />
          <p className="mt-1 text-xs text-slate-400">Счета этого банка сопоставляются со счетами приложения после сохранения — в карточке подключения.</p>
        </div>
        <p className="text-sm text-slate-500">{bank.hint} <a className="text-brand hover:underline" href={bank.docs} target="_blank" rel="noreferrer">Документация API →</a></p>

        {bank.method === "token" ? (
          <div>
            <label className="label">API-токен</label>
            <input className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={conn?.token_mask ?? "Вставьте токен из кабинета банка"} />
            {conn?.has_token && <p className="mt-1 text-xs text-slate-400">Текущий токен: {conn.token_mask} (введите новый, чтобы заменить)</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div><label className="label">client_id</label>
              <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Идентификатор приложения" /></div>
            <div><label className="label">client_secret</label>
              <input className="input font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
                placeholder={conn?.has_secret ? "•••• (введите новый, чтобы заменить)" : "Секрет приложения"} /></div>
            <a className={`btn-ghost inline-block ${clientId ? "" : "pointer-events-none opacity-40"}`}
              href={clientId ? authorizeUrl() : "#"} target="_blank" rel="noreferrer">Перейти к авторизации в банке →</a>
          </div>
        )}

        {save.error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{(save.error as any)?.response?.data?.detail || "Не удалось сохранить"}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Сохранение…" : "Сохранить"}</button>
        </div>
      </div>
    </Modal>
  );
}
