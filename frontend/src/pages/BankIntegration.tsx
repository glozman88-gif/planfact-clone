import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { Modal } from "../components/Modal";

interface Bank {
  slug: string; name: string; method: "token" | "oauth"; docs: string; hint: string;
  authorize?: string; scope?: string; color: string;
}

const BANKS: Bank[] = [
  { slug: "tochka", name: "Точка", method: "token", docs: "https://developers.tochka.com/", color: "bg-violet-500",
    hint: "В интернет-банке: «Интеграции и API» → создайте JWT-ключ с доступом к выпискам и вставьте его сюда." },
  { slug: "tbank", name: "Т-Банк", method: "token", docs: "https://developer.tbank.ru/", color: "bg-yellow-500",
    hint: "В Т-Бизнесе выпустите токен T-API (авторизация Bearer) с доступом к счетам и выпискам." },
  { slug: "modulbank", name: "Модульбанк", method: "token", docs: "https://modulbank.ru/api", color: "bg-indigo-500",
    hint: "В личном кабинете → раздел API сгенерируйте токен и вставьте сюда." },
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
  const [connecting, setConnecting] = useState<Bank | null>(null);
  const conns = useQuery({
    queryKey: ["bank-connections", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<any[]>("/api/bank-connections", { params: { company_id: companyId } })).data,
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api/bank-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-connections"] }),
  });
  const connOf = (slug: string) => conns.data?.find((c) => c.bank === slug);

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-bold">Банки и карты</h1>
      <p className="text-sm text-slate-500">
        Прямая интеграция с банком по API: подключите банк, чтобы автоматически подтягивать счета и
        выписки. Также данные можно загрузить вручную через <a className="text-brand hover:underline" href="/import">Импорт</a>.
      </p>

      <div className="card p-0">
        <table className="table">
          <thead><tr><th>Банк</th><th>Статус</th><th className="text-right">Действия</th></tr></thead>
          <tbody>
            {BANKS.map((b) => {
              const c = connOf(b.slug);
              return (
                <tr key={b.slug} className="hover:bg-slate-50">
                  <td>
                    <div className="flex items-center gap-2">
                      <span className={`flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold text-white ${b.color}`}>{b.name[0]}</span>
                      <div>
                        <div className="font-medium">{b.name}</div>
                        <div className="text-xs text-slate-400">{b.method === "token" ? "Подключение по API-токену" : "Подключение по OAuth 2.0"}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {!c && <span className="text-slate-400">Можно подключить</span>}
                    {c?.status === "connected" && <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">Подключён</span>}
                    {c?.status === "pending" && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Требуется авторизация</span>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button className="text-brand hover:underline" onClick={() => setConnecting(b)}>{c ? "Настроить" : "Подключить"}</button>
                    {c && <button className="ml-3 text-red-500 hover:underline" onClick={() => confirm(`Отключить ${b.name}?`) && del.mutate(c.id)}>Отключить</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">Вашего банка нет в списке? Загрузите выписку через раздел «Импорт» (Excel/CSV, 1С, Тинькофф, Сбер).</p>

      {connecting && (
        <ConnectModal bank={connecting} conn={connOf(connecting.slug)} companyId={companyId}
          onClose={() => setConnecting(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["bank-connections"] }); setConnecting(null); }} />
      )}
    </div>
  );
}

function ConnectModal({ bank, conn, companyId, onClose, onSaved }: any) {
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(conn?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const save = useMutation({
    mutationFn: () => api.post("/api/bank-connections", {
      bank: bank.slug,
      token: token || null,
      client_id: clientId || null,
      client_secret: clientSecret || null,
    }, { params: { company_id: companyId } }),
    onSuccess: onSaved,
  });
  const authorizeUrl = () => {
    const redirect = `${location.origin}/bank-oauth-callback`;
    const p = new URLSearchParams({ response_type: "code", client_id: clientId, scope: bank.scope || "", redirect_uri: redirect, state: bank.slug });
    return `${bank.authorize}?${p.toString()}`;
  };

  return (
    <Modal title={`Подключение — ${bank.name}`} onClose={onClose} wide>
      <div className="space-y-4">
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
            <div>
              <label className="label">client_id</label>
              <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Идентификатор приложения" />
            </div>
            <div>
              <label className="label">client_secret</label>
              <input className="input font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
                placeholder={conn?.has_secret ? "•••• (введите новый, чтобы заменить)" : "Секрет приложения"} />
            </div>
            <a className={`btn-ghost inline-block ${clientId ? "" : "pointer-events-none opacity-40"}`}
              href={clientId ? authorizeUrl() : "#"} target="_blank" rel="noreferrer">Перейти к авторизации в банке →</a>
            <p className="text-xs text-slate-400">После авторизации банк перенаправит с кодом; обмен кода на токен выполняется на стороне сервера (для полной интеграции нужен зарегистрированный redirect_uri).</p>
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
