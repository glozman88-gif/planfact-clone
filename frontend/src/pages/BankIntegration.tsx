import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
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
// Банки с подключением по API-токену (инструкция + авто-выгрузка). Остальные — OAuth-флоу.
const TOKEN_BANKS = new Set(["tbank", "tochka"]);

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
  const [wizard, setWizard] = useState<{ bank: Bank; conn?: any; startStep?: number } | null>(null);
  const [syncFor, setSyncFor] = useState<any | null>(null);
  const [settingsFor, setSettingsFor] = useState<any | null>(null);
  const [params, setParams] = useSearchParams();

  const conns = useQuery({
    queryKey: ["bank-connections", companyId], enabled: !!companyId,
    queryFn: async () => (await api.get<any[]>("/api/bank-connections", { params: { company_id: companyId } })).data,
  });

  // Возврат из авторизации банка (?resume=connId) — продолжить мастер с шага «Настройка счетов»
  useEffect(() => {
    const rid = params.get("resume");
    if (rid && conns.data && !wizard) {
      const c = conns.data.find((x) => String(x.id) === rid);
      if (c) setWizard({ bank: bankBy(c.bank), conn: c, startStep: 3 });
      setParams({}, { replace: true });
    }
  }, [conns.data]);
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
        <ConnectWizard bank={wizard.bank} conn={wizard.conn} startStep={wizard.startStep} companyId={companyId!}
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
function ConnectWizard({ bank, conn, startStep, companyId, onClose, onDone }: { bank: Bank; conn?: any; startStep?: number; companyId: number; onClose: () => void; onDone: () => void }) {
  const entities = useLegalEntities();
  const accounts = useAccounts();
  const isTokenBank = TOKEN_BANKS.has(bank.slug);
  // Токен-банки: сразу ввод токена (шаг 2), ИНН/КПП/юрлицо не спрашиваем — определяем из банка
  const [step, setStep] = useState(startStep ?? (isTokenBank ? 2 : 1));
  const [title, setTitle] = useState(conn?.title ?? "");
  const [legalEntityId, setLegalEntityId] = useState<number | null>(conn?.legal_entity_id ?? null);
  const [companyInfo, setCompanyInfo] = useState<any>(null);   // реквизиты организации из банка
  const [inn, setInn] = useState("");
  const [kpp, setKpp] = useState("");
  const [period, setPeriod] = useState("year");
  const [freq, setFreq] = useState("daily");
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [stepAccounts, setStepAccounts] = useState<DetectResult["accounts"]>([]);   // счета для шага 3 (файл или API)
  const [decisions, setDecisions] = useState<Record<string, { selected: boolean; mode: "existing" | "new"; app_account_id?: number; create_name?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [token, setToken] = useState("");
  const bankInfo = useQuery({ queryKey: ["bank-info", bank.slug], enabled: isTokenBank, queryFn: async () => (await api.get(`/api/banks/${bank.slug}/info`)).data as any });

  const periodFrom = () => {
    const now = new Date();
    if (period === "all") return "2023-06-01";
    if (period === "month") return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    if (period === "quarter") { const d = new Date(now.getTime() - 92 * 864e5); return d.toISOString().slice(0, 10); }
    return `${now.getFullYear()}-01-01`;
  };
  const initDecisions = (accs: DetectResult["accounts"]) => {
    const init: any = {};
    for (const a of accs) init[a.bank_account] = a.matched_app_account_id
      ? { selected: true, mode: "existing", app_account_id: a.matched_app_account_id }
      : { selected: true, mode: "new", create_name: a.suggest_name || a.bank_account };
    setDecisions(init);
  };
  // Токен-банк: по токену выгрузить счета → шаг 3
  const connectToken = async () => {
    setBusy(true); setErr("");
    try {
      const res = (await api.post(`/api/banks/${bank.slug}/accounts`, { token: token.trim() }, { params: { company_id: companyId } })).data;
      setStepAccounts(res.accounts); initDecisions(res.accounts);
      if (res.legal_entity_id) { setLegalEntityId(res.legal_entity_id); entities.refetch(); }
      if (res.company) { setCompanyInfo(res.company); if (res.company.name) setTitle(res.company.name); }
      setStep(3);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || "Не удалось выгрузить счета по токену");
    } finally { setBusy(false); }
  };
  const [createdConn, setCreatedConn] = useState<any | null>(conn ?? null);   // подключение после авторизации
  const [authScreen, setAuthScreen] = useState(false);                        // демо-экран авторизации банка
  const [connected, setConnected] = useState<{ decisions: AccDecision[]; connId: number } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [autoResult, setAutoResult] = useState<any>(null);

  // «Продолжить» на шаге 2 → авторизация в банке (реальный OAuth-редирект или демо-экран)
  const startAuth = async () => {
    setBusy(true); setErr("");
    try {
      const r = (await api.post("/api/bank-oauth/start", { bank: bank.slug, title: title || null }, { params: { company_id: companyId } })).data;
      setCreatedConn({ id: r.connection_id, bank: bank.slug, title });
      if (r.mode === "oauth" && r.url) { window.location.href = r.url; return; }
      setAuthScreen(true);
    } catch {
      setErr("Не удалось начать авторизацию в банке");
    } finally { setBusy(false); }
  };
  // Возврат после успешной авторизации (демо) → перейти к настройке счетов
  const afterAuth = async () => {
    if (createdConn) await api.post("/api/bank-oauth/demo-confirm", { connection_id: createdConn.id }).catch(() => {});
    onDone();
    setAuthScreen(false);
    setStep(3);
  };

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
      setDetect(d); setStepAccounts(d.accounts); initDecisions(d.accounts);
    } finally { setBusy(false); }
  };

  const buildDecisions = (): AccDecision[] =>
    Object.entries(decisions).filter(([, v]) => v.selected).map(([bank_account, v]) =>
      v.mode === "existing" ? { bank_account, app_account_id: v.app_account_id } : { bank_account, create: true, create_name: v.create_name });

  const finish = async () => {
    const willCreate = Object.values(decisions).some((v) => v.selected && v.mode === "new");
    if (willCreate && !legalEntityId) { setErr("Выберите юрлицо для новых счетов"); return; }
    setBusy(true); setErr("");
    try {
      // 1) подключение: для T-Bank сохраняем токен; иначе уже создано на авторизации
      const connBody: any = { bank: bank.slug, title: title || null, sync_freq: freq };
      if (isTokenBank && token.trim()) connBody.token = token.trim();
      const active = createdConn ?? conn;
      const c = active
        ? (await api.put(`/api/bank-connections/${active.id}`, connBody)).data
        : (await api.post("/api/bank-connections", connBody, { params: { company_id: companyId } })).data;
      // 2) счета: создать недостающие + сопоставления. Итоговые решения — уже existing.
      const finalDec: AccDecision[] = [];
      const selectedNums: string[] = [];
      let firstAcc: number | null = null;
      for (const [bank_account, v] of Object.entries(decisions)) {
        if (!v.selected) continue;
        selectedNums.push(bank_account);
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
      // 3) Токен-банк: пере-синхронизация (выгрузка операций + сверка остатков с банком)
      if (isTokenBank) {
        const res = (await api.post(`/api/banks/${bank.slug}/resync`, {}, { params: { company_id: companyId, connection_id: c.id, date_from: periodFrom() } })).data;
        onDone();
        const newAccts = finalDec.length;
        setAutoResult({ operations: { loaded: res.operations, total: res.operations }, counterparties: { new: 0, existing: 0 }, accounts: { new: newAccts, existing: 0 }, entities: { new: 0, existing: legalEntityId ? 1 : 0 } });
        return;
      }
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

  const STEPS: [string, string, number][] = isTokenBank
    ? [["1", "Подключение по токену", 2], ["2", "Настройка счетов", 3]]
    : [["1", "Начало подключения", 1], ["2", "Авторизация в банке", 2], ["3", "Настройка счетов", 3]];
  const Stepper = (
    <div className="mb-5 flex items-center gap-2 text-sm">
      {STEPS.map(([n, label, sv], i) => (
        <div key={n} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${step >= sv ? "bg-brand text-white" : "bg-slate-200 text-slate-500"}`}>{n}</span>
          <span className={step === sv ? "font-medium" : "text-slate-400"}>{label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 text-slate-300">···</span>}
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
          <div className="text-xs font-semibold uppercase text-slate-400">Подключение банка — шаг {isTokenBank ? (step === 2 ? 1 : 2) : step} из {isTokenBank ? 2 : 3}</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        {Stepper}
        {Header}

        {step === 1 && (
          <div className="space-y-4">
            <p className="font-medium">Введите ИНН юрлица, счета которого нужно подключить.</p>
            <p className="text-sm text-slate-500">{isTokenBank ? `На следующем шаге вставьте API-токен ${bank.name} — приложение само выгрузит счета и операции.` : `На следующем шаге вы будете перенаправлены на авторизацию в ${bank.name}.`}</p>
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

        {step === 2 && isTokenBank && (
          <BankTokenStep bankName={bank.name} info={bankInfo.data}
            token={token} setToken={setToken} busy={busy} err={err}
            onBack={onClose} onConnect={connectToken} />
        )}
        {step === 2 && !isTokenBank && !authScreen && (
          <div className="space-y-4">
            <p className="font-medium">Авторизация в банке</p>
            <p className="text-sm text-slate-500">
              Нажмите «Продолжить» — откроется авторизация в {bank.name}. Войдите по номеру телефона и
              подтвердите доступ к счетам. После этого вы автоматически вернётесь сюда — <b>API-ключ вводить не нужно</b>.
            </p>
            <div className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-700">
              Приложение не хранит логин и пароль от банка. Доступ выдаётся банком по защищённому протоколу
              (OAuth 2.0) и может быть отозван в любой момент.
            </div>
            {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
            <div className="flex justify-between">
              <button className="btn-ghost" onClick={() => setStep(1)}>Назад</button>
              <button className="btn-primary" disabled={busy} onClick={startAuth}>{busy ? "Открываем банк…" : "Продолжить"}</button>
            </div>
          </div>
        )}
        {step === 2 && !isTokenBank && authScreen && (
          <BankAuthScreen bank={bank} busy={busy} onCancel={() => setAuthScreen(false)} onConfirm={afterAuth} />
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="font-medium">Выберите счета для синхронизации.</p>
            <p className="text-sm text-slate-500">{isTokenBank
              ? "Приложение выгрузило счета из Т-Банка. Сопоставьте их со счетами приложения (найденные подставлены автоматически), укажите период — операции подтянутся сами."
              : "Приложение добавит платежи по этим счетам за период, который вы укажете. Загрузите выписку банка (CSV/XLSX/1С), чтобы распознать счета и операции."}</p>

            {stepAccounts.length === 0 ? (
              isTokenBank ? (
                <div className="py-8 text-center text-sm text-slate-400">Загружаем счета из банка…</div>
              ) : (
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed border-slate-200 py-8 text-sm text-slate-500 hover:border-brand">
                <span className="text-2xl">📄</span>
                {busy ? "Распознаём…" : "Нажмите, чтобы выбрать файл выписки"}
                <input type="file" className="hidden" accept=".csv,.xlsx,.xlsm,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>
              )
            ) : (
              <>
                {detect && <div className="text-xs text-slate-400">Распознано операций: {detect.totals.count}. Счетов: {stepAccounts.length}.</div>}
                <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-2">
                  <div className="text-xs font-semibold uppercase text-slate-400">Счёт в банке</div>
                  <div className="col-span-2 text-xs font-semibold uppercase text-slate-400">Счёт в приложении</div>
                  {stepAccounts.map((a) => {
                    const d = decisions[a.bank_account] || { selected: true, mode: "new", create_name: a.suggest_name };
                    const set = (patch: any) => setDecisions((s) => ({ ...s, [a.bank_account]: { ...d, ...patch } }));
                    const sel = d.mode === "existing" ? String(d.app_account_id ?? "") : "__new__";
                    return (
                      <div key={a.bank_account} className="contents">
                        <label className="flex items-start gap-2 py-1"><input type="checkbox" className="mt-1" checked={d.selected} onChange={(e) => set({ selected: e.target.checked })} />
                          <span><span className="font-mono text-xs">{a.bank_account}</span>
                            {a.balance != null && <span className="block text-xs text-slate-400">Остаток: {money(a.balance)} {a.currency || ""}</span>}</span></label>
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
                <div className="border-t pt-3">
                  {isTokenBank && legalEntityId ? (
                    <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm">
                      <div className="font-medium text-emerald-700">Юрлицо определено из банка: {companyInfo?.name || entities.data?.find((x) => x.id === legalEntityId)?.name}</div>
                      {companyInfo?.inn && <div className="text-xs text-emerald-600">ИНН {companyInfo.inn}{companyInfo.kpp ? ` · КПП ${companyInfo.kpp}` : ""} — реквизиты подставлены автоматически. Счета привяжутся к нему.</div>}
                    </div>
                  ) : (
                    <>
                      <label className="label">Юрлицо для новых счетов <span className="text-red-500">*</span></label>
                      <select className="input" value={legalEntityId ?? ""} onChange={(e) => setLegalEntityId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">— выберите юрлицо —</option>
                        {entities.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                      <p className="mt-1 text-xs text-slate-400">Создаваемые счёта будут привязаны к этому юрлицу (обязательно).</p>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Начало синхронизации</label>
                    <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>{SYNC_PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                  <div><label className="label">Частота синхронизации счетов</label>
                    <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>{SYNC_FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                </div>
              </>
            )}
            {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
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
  const [err, setErr] = useState("");
  const isTokenBank = TOKEN_BANKS.has(bank.slug);
  const [syncRes, setSyncRes] = useState<any>(null);
  // Токен-банк: пере-синхронизация по API (замена + сверка остатков, без дублей)
  useEffect(() => {
    if (!isTokenBank) return;
    setBusy(true);
    api.post(`/api/banks/${bank.slug}/resync`, {}, { params: { company_id: companyId, connection_id: conn.id } })
      .then((r) => setSyncRes(r.data)).catch((e) => setErr(e?.response?.data?.detail || "Не удалось синхронизировать")).finally(() => setBusy(false));
  }, []);
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
        {isTokenBank ? (
          <div className="py-6 text-center text-sm">
            {err ? <span className="text-red-600">{err}</span>
              : syncRes ? (
                <div className="space-y-3 text-left">
                  <div className="text-center text-emerald-600">✓ Синхронизировано с {bank.name}</div>
                  <div className="rounded-md border p-3 text-slate-600">
                    <div>Новых операций: <b>{syncRes.new}</b></div>
                    <div>Уже были загружены (пропущено): <b>{syncRes.skipped}</b></div>
                    <div>Остатки сверены с банком по <b>{syncRes.accounts_reconciled}</b> счетам</div>
                    {syncRes.conflicts?.length > 0 && <div className="mt-1 text-amber-600">Конфликтов (изменены): <b>{syncRes.conflicts.length}</b></div>}
                  </div>
                  {syncRes.conflicts?.length > 0 && (
                    <details className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
                      <summary className="cursor-pointer font-medium text-amber-700">Конфликты — операции, изменённые после загрузки</summary>
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                        {syncRes.conflicts.slice(0, 50).map((cf: any, i: number) => (
                          <div key={i} className="border-b pb-1">
                            <span className="text-slate-500">{cf.reason}:</span> в приложении {money(cf.app.amount)} от {cf.app.date}, в банке {money(cf.bank.amount)} от {cf.bank.date}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  <div className="text-center"><button className="btn-primary" onClick={() => { onDone(); onClose(); }}>Готово</button></div>
                </div>
              ) : "Синхронизируем операции и сверяем остатки…"}
          </div>
        ) : (
        <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed border-slate-200 py-8 text-sm text-slate-500 hover:border-brand">
          <span className="text-2xl">📄</span>{busy ? "Распознаём…" : "Загрузите свежую выписку банка"}
          <input type="file" className="hidden" accept=".csv,.xlsx,.xlsm,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        )}
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

// Шаг 2 для банков с токеном: инструкция по выпуску (шаги + IP сервера) + ввод токена
function BankTokenStep({ bankName, info, token, setToken, busy, err, onBack, onConnect }: any) {
  const steps: string[] = info?.steps ?? [];
  const serverIp: string | null = info?.server_ip ?? null;
  return (
    <div className="space-y-4">
      <p className="font-medium">Подключение {bankName} по API-токену</p>
      <div className="rounded-md border bg-slate-50 p-3 text-sm">
        <div className="mb-2 font-semibold">Как выпустить токен (1 раз):</div>
        <ol className="ml-4 list-decimal space-y-1 text-slate-600">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
        {info?.needs_ip && (
          <div className="mt-2 flex items-center gap-2 rounded bg-white px-2 py-1 ring-1 ring-slate-200">
            <span className="text-xs text-slate-500">IP этого сервера:</span>
            <code className="font-mono text-brand">{serverIp || "определяется…"}</code>
            {serverIp && <button type="button" className="text-xs text-brand hover:underline" onClick={() => navigator.clipboard?.writeText(serverIp)}>копировать</button>}
          </div>
        )}
        {info?.docs_url && <a className="mt-2 inline-block text-xs text-brand hover:underline" href={info.docs_url} target="_blank" rel="noreferrer">Документация банка →</a>}
      </div>
      <div>
        <label className="label">API-токен {bankName}</label>
        <input className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Вставьте токен из кабинета банка" />
        {info?.sandbox_token && <button type="button" className="mt-1 text-xs text-slate-400 hover:text-brand" onClick={() => setToken(info.sandbox_token)}>Подставить демо-токен (песочница) для проверки</button>}
      </div>
      {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      <div className="flex justify-between">
        <button className="btn-ghost" onClick={onBack}>Назад</button>
        <button className="btn-primary" disabled={busy || token.trim().length < 4} onClick={onConnect}>{busy ? "Выгружаем счета…" : "Подключить"}</button>
      </div>
    </div>
  );
}

// Экран авторизации в банке (мимикрия входа по телефону, как при OAuth-редиректе).
// При настроенном OAuth-приложении оператора используется реальный редирект на сайт банка;
// это — демо-экран для развёртывания без партнёрской регистрации.
function BankAuthScreen({ bank, busy, onCancel, onConfirm }: { bank: Bank; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [phase, setPhase] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-500">
        <span className={`flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-white ${bank.color}`}>{bank.name[0]}</span>
        <span>Защищённая авторизация · {bank.name}</span>
        <span className="ml-auto text-xs">🔒 OAuth 2.0</span>
      </div>
      <div className="rounded-lg border p-5">
        <h4 className="mb-1 text-center text-lg font-semibold">Вход в {bank.name}</h4>
        <p className="mb-4 text-center text-sm text-slate-500">Приложение запрашивает доступ к вашим счетам и выпискам</p>
        {phase === "phone" ? (
          <div className="space-y-3">
            <div><label className="label">Номер телефона</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 ___ ___-__-__" autoFocus /></div>
            <button className="btn-primary w-full" disabled={phone.replace(/\D/g, "").length < 10} onClick={() => setPhase("code")}>Получить код</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div><label className="label">Код из СМS</label>
              <input className="input tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value)} placeholder="____" maxLength={6} autoFocus /></div>
            <button className="btn-primary w-full" disabled={busy || code.replace(/\D/g, "").length < 4} onClick={onConfirm}>
              {busy ? "Подтверждаем…" : "Подтвердить и разрешить доступ"}</button>
            <p className="text-center text-xs text-slate-400">После подтверждения вы вернётесь в приложение</p>
          </div>
        )}
      </div>
      <div className="flex justify-start"><button className="btn-ghost" onClick={onCancel}>← Отменить авторизацию</button></div>
    </div>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"><div className="mt-10 w-full max-w-2xl">{children}</div></div>;
}
