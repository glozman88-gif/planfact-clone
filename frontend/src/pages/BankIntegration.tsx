import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts, useLegalEntities } from "../api/hooks";
import { ImportPreviewModal, SuccessModal } from "../components/ImportPreviewModal";
import type { AccDecision, DetectResult } from "../components/ImportPreviewModal";

interface Bank {
  slug: string; name: string; method: "token" | "oauth"; docs: string; hint: string;
  authorize?: string; scope?: string; color: string;
}
const BANKS: Bank[] = [
  { slug: "zenmoney", name: "Дзен-мани", method: "token", docs: "https://zenmoney.ru/", color: "bg-orange-500",
    hint: "В профиле Дзен-мани создайте API-токен." },
  { slug: "sber", name: "СберБизнес", method: "oauth", docs: "https://developers.sber.ru/docs/ru/sber-api/", color: "bg-emerald-600",
    authorize: "https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize", scope: "GET_STATEMENT_ACCOUNT",
    hint: "Зарегистрируйте приложение (заявка fintech_API@sberbank.ru), получите client_id и client_secret." },
  { slug: "tbank", name: "Т-Банк", method: "token", docs: "https://developer.tbank.ru/", color: "bg-yellow-500",
    hint: "В Т-Бизнесе выпустите токен T-API (Bearer) с доступом к счетам и выпискам." },
  { slug: "tochka", name: "Банк Точка", method: "token", docs: "https://developers.tochka.com/", color: "bg-violet-500",
    hint: "В интернет-банке: «Интеграции и API» → создайте JWT-ключ с доступом к выпискам." },
  { slug: "alfa", name: "Альфа-Банк", method: "oauth", docs: "https://developers.alfabank.ru/", color: "bg-red-600",
    authorize: "https://oauth.alfabank.ru/authorize", scope: "accounts statements",
    hint: "Зарегистрируйте приложение в Альфа-Бизнес, получите client_id и client_secret." },
  { slug: "modulbank", name: "Модульбанк", method: "token", docs: "https://modulbank.ru/api", color: "bg-indigo-500",
    hint: "В личном кабинете → раздел API сгенерируйте токен." },
  { slug: "blank", name: "Бланк", method: "token", docs: "https://blank.ru/", color: "bg-slate-800",
    hint: "В кабинете банка получите API-токен." },
];
const bankBy = (slug: string) => BANKS.find((b) => b.slug === slug)!;

const SYNC_PERIODS = [["year", "За этот год"], ["all", "За всё время"], ["month", "С начала месяца"], ["quarter", "За последний квартал"]];
const SYNC_FREQ = [["daily", "Один раз в день"], ["twice", "Несколько раз в день"], ["manual", "Вручную"]];

// Решения по счетам из результата детекта: сопоставленные → existing, ненайденные → создать новый
export const decisionsFromDetect = (d: DetectResult): AccDecision[] =>
  d.accounts.map((a) => a.matched_app_account_id
    ? { bank_account: a.bank_account, app_account_id: a.matched_app_account_id }
    : { bank_account: a.bank_account, create: true, create_name: a.suggest_name || a.bank_account });

export function BankIntegration() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"direct" | "email">("direct");
  const [wizard, setWizard] = useState<{ bank: Bank; conn?: any } | null>(null);
  const [syncFor, setSyncFor] = useState<any | null>(null);
  const [settingsFor, setSettingsFor] = useState<any | null>(null);

  const conns = useQuery({
    queryKey: ["bank-connections", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<any[]>("/api/bank-connections", { params: { company_id: companyId } })).data,
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api/bank-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-connections"] }),
  });
  const connsOf = (slug: string) => (conns.data ?? []).filter((c) => c.bank === slug);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["bank-connections"] }); qc.invalidateQueries({ queryKey: ["accounts"] }); qc.invalidateQueries({ queryKey: ["operations"] }); };

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-bold">Банки и карты физлиц</h1>

      <div className="flex gap-4 border-b text-sm">
        <button onClick={() => setTab("direct")} className={`-mb-px border-b-2 pb-2 font-medium ${tab === "direct" ? "border-brand text-brand" : "border-transparent text-slate-500"}`}>Прямая интеграция</button>
        <button onClick={() => setTab("email")} className={`-mb-px border-b-2 pb-2 font-medium ${tab === "email" ? "border-brand text-brand" : "border-transparent text-slate-500"}`}>Обработка выписок по E-mail</button>
      </div>

      {tab === "email" ? (
        <div className="card text-sm text-slate-600">
          <p>Пересылайте выписки из банка на адрес обработки — операции будут распознаны и предложены к загрузке.
          Пока доступна загрузка вручную через раздел <a className="text-brand hover:underline" href="/import">Импорт</a>.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            Сократите время на ввод данных с помощью автоматической загрузки платежей — для этого подключите банк.
            Чтобы приложение само назначало операциям статьи и проекты, используйте <a className="text-brand hover:underline" href="/import">правила обработки платежей</a>.
          </p>

          <div className="card p-0">
            <div className="grid grid-cols-[2fr_2fr_2fr_auto] gap-2 border-b bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
              <div>Банк</div><div>Юрлицо / Кабинет</div><div>Статус подключения</div><div>Действия</div>
            </div>
            {BANKS.map((b) => {
              const list = connsOf(b.slug);
              return (
                <div key={b.slug} className="border-b last:border-0">
                  {list.length === 0 ? (
                    <div className="grid grid-cols-[2fr_2fr_2fr_auto] items-center gap-2 px-4 py-3">
                      <BankName b={b} />
                      <div className="text-sm text-slate-400">—</div>
                      <div className="text-sm text-slate-500">Можно подключить</div>
                      <button className="btn-primary !py-1.5" onClick={() => setWizard({ bank: b })}>Подключить</button>
                    </div>
                  ) : (
                    <div className="px-4 py-3">
                      {list.map((c, i) => (
                        <ConnRow key={c.id} bank={b} conn={c} first={i === 0}
                          onSync={() => setSyncFor(c)} onSettings={() => setSettingsFor(c)}
                          onDelete={() => confirm("Отключить банк? Сопоставления счетов будут удалены.") && del.mutate(c.id)} />
                      ))}
                      <button className="mt-2 flex items-center gap-1 text-sm text-brand hover:underline" onClick={() => setWizard({ bank: b })}>
                        <span className="text-base leading-none">⊕</span> Подключить юрлицо
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-400">Вашего банка нет в списке? Загрузите выписку через раздел «Импорт» (Excel/CSV, 1С, Тинькофф, Сбер).</p>
        </>
      )}

      {wizard && (
        <ConnectWizard bank={wizard.bank} conn={wizard.conn} companyId={companyId!}
          onClose={() => setWizard(null)} onDone={() => { refresh(); }} />
      )}
      {syncFor && (
        <SyncUpload conn={syncFor} bank={bankBy(syncFor.bank)} companyId={companyId!}
          onClose={() => setSyncFor(null)} onDone={refresh} />
      )}
      {settingsFor && (
        <SettingsModal conn={settingsFor} bank={bankBy(settingsFor.bank)} companyId={companyId!}
          onClose={() => setSettingsFor(null)} onDone={refresh}
          onLoad={() => { const c = settingsFor; setSettingsFor(null); setSyncFor(c); }} />
      )}
    </div>
  );
}

function BankName({ b }: { b: Bank }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold text-white ${b.color}`}>{b.name[0]}</span>
      <span className="font-medium">{b.name}</span>
    </div>
  );
}

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const freqLabel = (f?: string) => f === "twice" ? "несколько раз в день" : f === "manual" ? "вручную" : "раз в день";
const fmtSync = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}. ${d.getFullYear()} в ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Строка подключённого юрлица: юрлицо, счетов N, статус, действия ⟳ ⚙ ✕
function ConnRow({ bank, conn, first, onSync, onSettings, onDelete }: any) {
  const maps = useQuery({ queryKey: ["bank-maps", conn.id], queryFn: async () => (await api.get(`/api/bank-connections/${conn.id}/accounts`)).data as any[] });
  const n = maps.data?.length ?? 0;
  const last = fmtSync(conn.last_sync_at);
  return (
    <div className="grid grid-cols-[2fr_2fr_2fr_auto] items-center gap-2 py-2">
      <div>{first ? <BankName b={bank} /> : null}</div>
      <div>
        <div className="text-sm font-medium">{conn.title || "(без названия)"}</div>
        <div className="text-xs text-slate-400">Подключено счетов: {n}</div>
      </div>
      <div>
        <div className="text-sm text-emerald-600">Подключён к ПланФакту</div>
        <div className="text-xs text-slate-400">Синхронизация {freqLabel(conn.sync_freq)}{last ? `, последняя: ${last}` : ""}</div>
      </div>
      <div className="flex items-center gap-3 text-slate-400">
        <button title="Получить новые операции" className="hover:text-brand" onClick={onSync}>⟳</button>
        <button title="Настройки синхронизации" className="hover:text-brand" onClick={onSettings}>⚙</button>
        <button title="Отключить" className="hover:text-red-500" onClick={onDelete}>✕</button>
      </div>
    </div>
  );
}

// ---------- Мастер подключения (3 шага) ----------
function ConnectWizard({ bank, conn, companyId, onClose, onDone }: { bank: Bank; conn?: any; companyId: number; onClose: () => void; onDone: () => void }) {
  const entities = useLegalEntities();
  const accounts = useAccounts();
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState(conn?.title ?? "");
  const [legalEntityId, setLegalEntityId] = useState<number | null>(conn?.legal_entity_id ?? null);
  const [inn, setInn] = useState("");
  const [kpp, setKpp] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState(conn?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [period, setPeriod] = useState("year");
  const [freq, setFreq] = useState("daily");
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, { selected: boolean; mode: "existing" | "new"; app_account_id?: number; create_name?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<{ decisions: AccDecision[]; connId: number } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [autoResult, setAutoResult] = useState<any>(null);

  const pickEntity = (id: number | null) => {
    setLegalEntityId(id);
    const e = entities.data?.find((x) => x.id === id);
    if (e) { setTitle(e.name); setInn(e.inn ?? ""); setKpp(e.kpp ?? ""); }
  };

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bank", bank.slug);
      const d = (await api.post<DetectResult>("/api/imports/bank-detect", fd, { params: { company_id: companyId } })).data;
      setDetect(d);
      const init: any = {};
      for (const a of d.accounts) {
        init[a.bank_account] = a.matched_app_account_id
          ? { selected: true, mode: "existing", app_account_id: a.matched_app_account_id }
          : { selected: true, mode: "new", create_name: a.suggest_name || a.bank_account };
      }
      setDecisions(init);
    } finally { setBusy(false); }
  };

  const buildDecisions = (): AccDecision[] =>
    Object.entries(decisions).filter(([, v]) => v.selected).map(([bank_account, v]) =>
      v.mode === "existing" ? { bank_account, app_account_id: v.app_account_id } : { bank_account, create: true, create_name: v.create_name });

  const finish = async () => {
    setBusy(true);
    try {
      // 1) подключение
      const connBody = { bank: bank.slug, title: title || null, token: token || null, client_id: clientId || null, client_secret: clientSecret || null };
      const c = conn
        ? (await api.put(`/api/bank-connections/${conn.id}`, connBody)).data
        : (await api.post("/api/bank-connections", connBody, { params: { company_id: companyId } })).data;
      // 2) счета: создать недостающие + сопоставления. Итоговые решения — уже existing.
      const finalDec: AccDecision[] = [];
      let firstAcc: number | null = null;
      for (const [bank_account, v] of Object.entries(decisions)) {
        if (!v.selected) continue;
        let accId = v.app_account_id ?? null;
        if (v.mode === "new") {
          accId = (await api.post("/api/accounts", { name: v.create_name || bank_account, kind: "bank", legal_entity_id: legalEntityId }, { params: { company_id: companyId } })).data.id;
        }
        if (accId) {
          await api.post(`/api/bank-connections/${c.id}/accounts`, { bank_account, account_id: accId });
          finalDec.push({ bank_account, app_account_id: accId });
          firstAcc ??= accId;
        }
      }
      if (firstAcc) await api.put(`/api/bank-connections/${c.id}`, { ...connBody, account_id: firstAcc });
      onDone();
      setConnected({ decisions: finalDec, connId: c.id });
    } finally { setBusy(false); }
  };

  const continueWork = async () => {
    // «Продолжить работу»: авто-загрузка без ручного распределения
    if (detect && connected) {
      setBusy(true);
      try {
        const res = (await api.post("/api/imports/commit", {
          source: bank.slug, filename: detect.filename, legal_entity_id: legalEntityId,
          connection_id: connected.connId, accounts: connected.decisions, rows: detect.rows,
        }, { params: { company_id: companyId } })).data;
        onDone();
        setAutoResult(res);
      } finally { setBusy(false); }
    } else { onClose(); }
  };

  // Экран распределения (предпросмотр)
  if (showPreview && detect && connected)
    return <ImportPreviewModal companyId={companyId} source={bank.slug} detect={detect}
      accounts={connected.decisions} legalEntityId={legalEntityId} connectionId={connected.connId} onClose={onClose} onDone={onDone} />;
  if (autoResult) return <SuccessModal result={autoResult} onClose={onClose} />;

  // Модалка «Интеграция успешно подключена»
  if (connected) {
    return (
      <Overlay>
        <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
          <div className="mb-3 flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">✓</span>
            <h3 className="text-lg font-semibold">Интеграция успешно подключена</h3></div>
          <p className="text-sm text-slate-600">Операции скоро начнут автоматически загружаться. Нажмите «Продолжить работу», чтобы закрыть это окно.</p>
          <p className="mt-2 text-sm text-slate-600">Если хотите предварительно посмотреть платежи для загрузки или указать им статьи и проекты — нажмите «Распределить операции».</p>
          <div className="mt-5 flex items-center justify-between">
            <button className="text-brand hover:underline disabled:opacity-40" disabled={!detect || busy} onClick={() => setShowPreview(true)}>Распределить операции</button>
            <button className="btn-primary" disabled={busy} onClick={continueWork}>{busy ? "Загрузка…" : "Продолжить работу"}</button>
          </div>
        </div>
      </Overlay>
    );
  }

  const Stepper = (
    <div className="mb-5 flex items-center gap-2 text-sm">
      {[["1", "Начало подключения"], ["2", "Авторизация в банке"], ["3", "Настройка счетов"]].map(([n, label], i) => (
        <div key={n} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${step >= i + 1 ? "bg-brand text-white" : "bg-slate-200 text-slate-500"}`}>{n}</span>
          <span className={step === i + 1 ? "font-medium" : "text-slate-400"}>{label}</span>
          {i < 2 && <span className="mx-1 text-slate-300">···</span>}
        </div>
      ))}
    </div>
  );
  const Header = (
    <div className="mb-4 flex items-center gap-3">
      <span className={`flex h-10 w-10 items-center justify-center rounded-md text-lg font-bold text-white ${bank.color}`}>{bank.name[0]}</span>
      <h3 className="text-xl font-bold">{bank.name}</h3>
    </div>
  );

  return (
    <Overlay>
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div className="text-xs font-semibold uppercase text-slate-400">Подключение банка — шаг {step} из 3</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        {Stepper}
        {Header}

        {step === 1 && (
          <div className="space-y-4">
            <p className="font-medium">Введите ИНН юрлица, счета которого нужно подключить.</p>
            <p className="text-sm text-slate-500">{bank.method === "oauth" ? `На следующем шаге вы будете перенаправлены на сайт ${bank.name}.` : `На следующем шаге вставьте API-токен из кабинета ${bank.name}.`}</p>
            <div className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-700">Приложение не хранит ваши данные для входа в банк, подключение безопасно. Вы всегда сможете отключить банк.</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Ваше юр. лицо</label>
                <select className="input" value={legalEntityId ?? ""} onChange={(e) => pickEntity(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">— выберите или заполните вручную —</option>
                  {entities.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              <div><label className="label">Название подключения</label>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ООО «Ромашка»" /></div>
              <div><label className="label">ИНН</label><input className="input font-mono" value={inn} onChange={(e) => setInn(e.target.value)} placeholder="1841041254" /></div>
              <div><label className="label">КПП</label><input className="input font-mono" value={kpp} onChange={(e) => setKpp(e.target.value)} placeholder="184101001" /></div>
            </div>
            <div className="flex justify-end"><button className="btn-primary" onClick={() => setStep(2)}>Следующий шаг</button></div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="font-medium">Авторизация в банке</p>
            <p className="text-sm text-slate-500">{bank.hint} <a className="text-brand hover:underline" href={bank.docs} target="_blank" rel="noreferrer">Документация API →</a></p>
            {bank.method === "token" ? (
              <div><label className="label">API-токен</label>
                <input className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Вставьте токен из кабинета банка" /></div>
            ) : (
              <div className="space-y-3">
                <div><label className="label">client_id</label><input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
                <div><label className="label">client_secret</label><input className="input font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
                <a className={`btn-ghost inline-block ${clientId ? "" : "pointer-events-none opacity-40"}`} target="_blank" rel="noreferrer"
                  href={clientId ? `${bank.authorize}?response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(bank.scope || "")}&redirect_uri=${encodeURIComponent(location.origin + "/bank-oauth-callback")}` : "#"}>
                  Перейти к авторизации в банке →</a>
                <p className="text-xs text-slate-400">После авторизации вернитесь и нажмите «Следующий шаг».</p>
              </div>
            )}
            <div className="flex justify-between"><button className="btn-ghost" onClick={() => setStep(1)}>Назад</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Следующий шаг</button></div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="font-medium">Выберите счета для синхронизации.</p>
            <p className="text-sm text-slate-500">Приложение добавит платежи по этим счетам за период, который вы укажете в поле «Начало синхронизации». Загрузите выписку банка (CSV/XLSX/1С), чтобы распознать счета и операции.</p>

            {!detect ? (
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed border-slate-200 py-8 text-sm text-slate-500 hover:border-brand">
                <span className="text-2xl">📄</span>
                {busy ? "Распознаём…" : "Нажмите, чтобы выбрать файл выписки"}
                <input type="file" className="hidden" accept=".csv,.xlsx,.xlsm,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>
            ) : (
              <>
                <div className="text-xs text-slate-400">Распознано операций: {detect.totals.count}. Счетов в выписке: {detect.accounts.length}.</div>
                <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-2">
                  <div className="text-xs font-semibold uppercase text-slate-400">Счёт в банке</div>
                  <div className="col-span-2 text-xs font-semibold uppercase text-slate-400">Счёт в приложении</div>
                  {detect.accounts.map((a) => {
                    const d = decisions[a.bank_account] || { selected: true, mode: "new", create_name: a.suggest_name };
                    const set = (patch: any) => setDecisions((s) => ({ ...s, [a.bank_account]: { ...d, ...patch } }));
                    const sel = d.mode === "existing" ? String(d.app_account_id ?? "") : "__new__";
                    return (
                      <div key={a.bank_account} className="contents">
                        <label className="flex items-center gap-2 py-1"><input type="checkbox" checked={d.selected} onChange={(e) => set({ selected: e.target.checked })} />
                          <span className="font-mono text-xs">{a.bank_account}</span></label>
                        <select className="input !py-1.5" value={sel}
                          onChange={(e) => e.target.value === "__new__" ? set({ mode: "new", create_name: d.create_name || a.suggest_name }) : set({ mode: "existing", app_account_id: Number(e.target.value) })}>
                          <option value="__new__">＋ Создать новый счёт</option>
                          {accounts.data?.map((ac) => <option key={ac.id} value={ac.id}>{ac.name}</option>)}
                        </select>
                        {d.mode === "new"
                          ? <input className="input !py-1.5" value={d.create_name ?? ""} onChange={(e) => set({ create_name: e.target.value })} placeholder="Название нового счёта" />
                          : <span className="text-xs text-emerald-600">✓ сопоставлен по реквизитам</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3 border-t pt-3">
                  <div><label className="label">Начало синхронизации</label>
                    <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>{SYNC_PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                  <div><label className="label">Частота синхронизации счетов</label>
                    <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>{SYNC_FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                </div>
              </>
            )}
            <div className="flex justify-between"><button className="btn-ghost" onClick={() => setStep(2)}>Назад</button>
              <button className="btn-primary" disabled={busy} onClick={finish}>{busy ? "Подключаем…" : "Завершить подключение"}</button></div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

// ⟳ Получить новые операции: загрузка выписки → предпросмотр по существующим сопоставлениям
function SyncUpload({ conn, bank, companyId, onClose, onDone }: any) {
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("bank", bank.slug); fd.append("connection_id", String(conn.id));
      setDetect((await api.post<DetectResult>("/api/imports/bank-detect", fd, { params: { company_id: companyId } })).data);
    } finally { setBusy(false); }
  };
  if (detect)
    return <ImportPreviewModal companyId={companyId} source={bank.slug} detect={detect}
      accounts={decisionsFromDetect(detect)} legalEntityId={conn.legal_entity_id ?? null} connectionId={conn.id} onClose={onClose} onDone={onDone} />;
  return (
    <Overlay>
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-lg font-semibold">Получить новые операции — {bank.name}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button></div>
        <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed border-slate-200 py-8 text-sm text-slate-500 hover:border-brand">
          <span className="text-2xl">📄</span>{busy ? "Распознаём…" : "Загрузите свежую выписку банка"}
          <input type="file" className="hidden" accept=".csv,.xlsx,.xlsm,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      </div>
    </Overlay>
  );
}

// ⚙ Настройки синхронизации: маппинг счетов банка → приложения + частота
function SettingsModal({ conn, bank, companyId, onClose, onDone, onLoad }: any) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const maps = useQuery({ queryKey: ["bank-maps", conn.id], queryFn: async () => (await api.get(`/api/bank-connections/${conn.id}/accounts`)).data as any[] });
  const balances = useQuery({
    queryKey: ["balances", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get("/api/account-balances", { params: { company_id: companyId } })).data as any[],
  });
  const [edited, setEdited] = useState<Record<number, { enabled: boolean; account_id: number | null }>>({});
  const [freq, setFreq] = useState(conn.sync_freq ?? "daily");
  const [busy, setBusy] = useState(false);
  const rowOf = (m: any) => edited[m.id] ?? { enabled: true, account_id: m.account_id };
  const set = (id: number, patch: any) => setEdited((s) => ({ ...s, [id]: { ...(s[id] ?? { enabled: true, account_id: maps.data!.find((m) => m.id === id)?.account_id ?? null }), ...patch } }));
  const balOf = (accId?: number | null) => balances.data?.find((x: any) => x.account_id === accId)?.balance;

  const save = async () => {
    setBusy(true);
    try {
      for (const m of maps.data ?? []) {
        const r = rowOf(m);
        if (!r.enabled) await api.delete(`/api/bank-connections/accounts/${m.id}`);
        else if (r.account_id !== m.account_id) await api.put(`/api/bank-connections/accounts/${m.id}`, { bank_account: m.bank_account, account_id: r.account_id });
      }
      await api.put(`/api/bank-connections/${conn.id}`, { bank: conn.bank, title: conn.title, sync_freq: freq });
      qc.invalidateQueries({ queryKey: ["bank-maps", conn.id] });
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <Overlay>
      <div className="w-full max-w-3xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2"><span className={`flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold text-white ${bank.color}`}>{bank.name[0]}</span>
            <h3 className="text-lg font-semibold">{bank.name}, настройки синхронизации</h3></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <p className="mb-4 text-sm text-slate-500">Подключённые счета отмечены галочкой. Снимите её, чтобы отключить счёт.</p>

        <div className="max-h-[52vh] overflow-auto">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
            <div className="text-xs font-semibold uppercase text-slate-400">Счёт в банке</div>
            <div className="text-xs font-semibold uppercase text-slate-400">Счёт в ПланФакте</div>
            {maps.data?.map((m) => {
              const r = rowOf(m);
              return (
                <div key={m.id} className="contents">
                  <label className="flex items-start gap-2 py-1">
                    <input type="checkbox" className="mt-1" checked={r.enabled} onChange={(e) => set(m.id, { enabled: e.target.checked })} />
                    <span><span className="font-mono text-xs">{m.bank_account}</span>
                      <span className="block text-xs text-slate-400">Остаток: {r.account_id ? money(balOf(r.account_id) ?? 0) : "—"}</span></span>
                  </label>
                  <select className="input !py-1.5" disabled={!r.enabled} value={r.account_id ?? ""} onChange={(e) => set(m.id, { account_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— не выбран —</option>
                    {accounts.data?.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              );
            })}
            {maps.data?.length === 0 && <div className="col-span-2 py-3 text-center text-sm text-slate-400">Счета ещё не сопоставлены — загрузите выписку через ⟳.</div>}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-4">
          <div><label className="label">Частота синхронизации счетов</label>
            <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>{SYNC_FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Отменить</button>
          <button className="btn-ghost" disabled={busy} onClick={save}>{busy ? "Сохранение…" : "Сохранить"}</button>
          <button className="btn-primary" disabled={busy} onClick={async () => { await save(); onLoad(); }}>Сохранить и загрузить</button>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"><div className="mt-10 w-full max-w-2xl">{children}</div></div>;
}
