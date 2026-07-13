import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useCategories, useCounterparties, useProjects } from "../api/hooks";

// Одна нормализованная строка выписки (из /api/imports/bank-detect)
export interface DetectRow {
  op_date: string;
  type: "income" | "outcome" | "move";
  amount: string;
  amount_to?: string | null;
  account?: string | null;       // номер счёта банка (источник)
  to_account?: string | null;    // номер счёта банка (получатель, для move)
  counterparty?: string | null;
  counterparty_id?: number | null;
  category_id?: number | null;
  project_id?: number | null;
  description?: string | null;
  excluded?: boolean;
}
export interface DetectResult {
  bank_name: string;
  filename?: string;
  period: { from: string | null; to: string | null };
  accounts: { bank_account: string; matched_app_account_id?: number | null; matched_name?: string | null; will_create?: boolean; suggest_name?: string; balance?: number | null; currency?: string; name?: string }[];
  counterparties: { total: number; new: string[]; existing: number };
  rows: DetectRow[];
  totals: { count: number; sum: string };
}
export interface AccDecision { bank_account: string; app_account_id?: number | null; create?: boolean; create_name?: string }

interface Props {
  companyId: number;
  source: string;                 // slug банка/источника (tbank, csv...)
  detect: DetectResult;
  accounts: AccDecision[];        // решения по счетам (из мастера/детекта)
  legalEntityId?: number | null;
  connectionId?: number | null;   // подключение — для отметки времени синхронизации
  onClose: () => void;
  onDone: () => void;             // после успешной загрузки (обновить списки)
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  const mon = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"][Number(m) - 1] || m;
  return `${d} ${mon} ’${y.slice(2)}`;
};
const shortAcc = (a?: string | null) => (a ? `…${a.slice(-4)}` : "—");

export function ImportPreviewModal({ companyId, source, detect, accounts, legalEntityId, connectionId, onClose, onDone }: Props) {
  const cats = useCategories();
  const parties = useCounterparties();
  const projects = useProjects();
  const [rows, setRows] = useState<DetectRow[]>(() => detect.rows.map((r) => ({ ...r })));
  const [tab, setTab] = useState<"ops" | "parties" | "accounts" | "entities">("ops");
  const [result, setResult] = useState<any>(null);
  const [showRule, setShowRule] = useState(false);

  const setRow = (i: number, patch: Partial<DetectRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const included = rows.filter((r) => !r.excluded);
  const sum = useMemo(
    () => included.reduce((s, r) => s + (r.type === "income" ? Number(r.amount) : r.type === "outcome" ? -Number(r.amount) : 0), 0),
    [rows],
  );
  const allChecked = included.length === rows.length && rows.length > 0;

  const commit = useMutation({
    mutationFn: async () =>
      (await api.post("/api/imports/commit", {
        source, filename: detect.filename, legal_entity_id: legalEntityId ?? null,
        connection_id: connectionId ?? null, accounts, rows: included,
      }, { params: { company_id: companyId } })).data,
    onSuccess: (data) => setResult(data),
  });

  if (result) return <SuccessModal result={result} onClose={() => { onDone(); onClose(); }} onDone={onDone} />;

  const catName = (id?: number | null, t?: string) =>
    id ? (cats.data?.find((c) => c.id === id)?.name ?? "") : (t === "income" ? "Нераспределённый приход" : t === "move" ? "Перемещение" : "Нераспределённый расход");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-6 w-full max-w-6xl rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold">
              Предпросмотр данных из {detect.bank_name}
              {detect.period.from && <> за {fmtDate(detect.period.from)} — {fmtDate(detect.period.to!)}</>}
            </h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Исключите лишние объекты перед загрузкой, распределите операции по контрагентам, статьям и проектам
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Закрыть">✕</button>
        </div>

        <div className="flex items-center gap-1 border-b px-5 pt-3 text-sm">
          {([["ops", `Операции ${rows.length}`], ["parties", `Контрагенты ${detect.counterparties.total}`],
            ["accounts", `Счета ${detect.accounts.length}`], ["entities", "Юрлица"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 pb-2 font-medium ${tab === k ? "border-brand text-brand" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
          <button className="ml-auto pb-2 font-medium text-brand hover:underline" onClick={() => setShowRule(true)}>Создать правило распределения</button>
        </div>
        {showRule && (
          <RuleModal companyId={companyId}
            onClose={() => setShowRule(false)}
            onApplied={(newRows) => { setRows(newRows); setShowRule(false); }}
            rows={rows} />
        )}

        <div className="max-h-[60vh] overflow-auto px-5 py-3">
          {tab === "ops" && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-xs uppercase text-slate-400">
                <tr className="border-b text-left">
                  <th className="w-8 py-2"><input type="checkbox" checked={allChecked}
                    onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, excluded: !e.target.checked })))} /></th>
                  <th className="py-2">Дата</th><th>Счёт</th><th className="w-8">Тип</th>
                  <th>Контрагент</th><th>Статья</th><th>Проект</th><th>Комментарий</th>
                  <th className="text-right">Сумма</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-b align-top ${r.excluded ? "opacity-40" : ""}`}>
                    <td className="py-2"><input type="checkbox" checked={!r.excluded}
                      onChange={(e) => setRow(i, { excluded: !e.target.checked })} /></td>
                    <td className="whitespace-nowrap py-2 text-slate-600">{fmtDate(r.op_date)}</td>
                    <td className="whitespace-nowrap font-mono text-xs text-slate-500">
                      {r.type === "move" && r.to_account ? <div>{shortAcc(r.to_account)}</div> : null}
                      <div>{shortAcc(r.account)}</div>
                    </td>
                    <td className="text-center text-base">
                      {r.type === "income" ? <span className="text-emerald-500" title="Поступление">↓</span>
                        : r.type === "move" ? <span className="text-slate-400" title="Перемещение">⇄</span>
                        : <span className="text-red-400" title="Выплата">↑</span>}
                    </td>
                    <td>
                      {r.type === "move" ? <span className="text-slate-400">—</span> : (
                        <select className="input !h-8 !w-40 !py-1 text-sm" value={r.counterparty_id ?? ""}
                          onChange={(e) => setRow(i, { counterparty_id: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">{r.counterparty ? `${r.counterparty} (новый)` : "— не выбран —"}</option>
                          {parties.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <select className="input !h-8 !w-44 !py-1 text-sm" value={r.category_id ?? ""}
                        onChange={(e) => setRow(i, { category_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{catName(null, r.type)}</option>
                        {cats.data?.filter((c) => r.type === "income" ? c.kind === "income" : r.type === "outcome" ? c.kind === "outcome" : true)
                          .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="input !h-8 !w-32 !py-1 text-sm" value={r.project_id ?? ""}
                        onChange={(e) => setRow(i, { project_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">Не выбран</option>
                        {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                    <td className="max-w-[16rem] truncate text-slate-500" title={r.description ?? ""}>{r.description}</td>
                    <td className="whitespace-nowrap text-right font-medium">
                      {r.type === "move" ? (
                        <div className="text-slate-500"><div>−{money(r.amount)}</div><div>+{money(r.amount)}</div></div>
                      ) : (
                        <span className={r.type === "income" ? "text-emerald-600" : "text-red-600"}>
                          {r.type === "income" ? "+" : "−"}{money(r.amount)}
                        </span>
                      )}
                    </td>
                    <td><span className="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-600">Новая</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "parties" && (
            <div className="space-y-1 text-sm">
              <p className="mb-2 text-slate-500">Будет создано новых контрагентов: <b>{detect.counterparties.new.length}</b>, найдено существующих: <b>{detect.counterparties.existing}</b>.</p>
              {detect.counterparties.new.map((n) => (
                <div key={n} className="flex items-center gap-2 border-b py-1"><span className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">новый</span>{n}</div>
              ))}
            </div>
          )}
          {tab === "accounts" && (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-400"><tr className="border-b text-left"><th className="py-2">Счёт в банке</th><th>Счёт в приложении</th><th>Действие</th></tr></thead>
              <tbody>
                {detect.accounts.map((a) => (
                  <tr key={a.bank_account} className="border-b">
                    <td className="py-2 font-mono text-xs">{a.bank_account}</td>
                    <td>{a.matched_name ?? a.suggest_name ?? "—"}</td>
                    <td>{a.will_create ? <span className="text-emerald-600">создать новый</span> : <span className="text-slate-500">сопоставлен</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === "entities" && <p className="py-4 text-sm text-slate-500">Юрлицо будет привязано к создаваемым счетам.</p>}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <div className="text-sm">
            Операций к загрузке: <b>{included.length}</b> на сумму{" "}
            <b className={sum < 0 ? "text-red-600" : "text-emerald-600"}>{sum < 0 ? "−" : ""}{money(Math.abs(sum))}</b>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Отменить</button>
            <button className="btn-primary" disabled={commit.isPending || included.length === 0} onClick={() => commit.mutate()}>
              {commit.isPending ? "Загрузка…" : "Загрузить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CountRow({ label, loaded, total, existing }: { label: string; loaded: number; total: number; existing?: number }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-4 py-3">
      <span className="font-medium">{label}: {loaded} из {total}</span>
      <span className="flex items-center gap-2 text-sm text-slate-400">
        {existing ? <span>уже существует {existing}</span> : null}
        <span className="text-emerald-500">✓</span>
      </span>
    </div>
  );
}

// ---- Создать правило распределения (авто-назначение статьи/проекта/контрагента) ----
const PARAMS: [string, string][] = [["counterparty", "Контрагент"], ["description", "Назначение платежа"], ["amount", "Сумма"], ["account", "Счёт"]];
const TEXT_OPS: [string, string][] = [["contains", "содержит"], ["not_contains", "не содержит"], ["equals", "равно"], ["starts_with", "начинается с"]];
const NUM_OPS: [string, string][] = [["gt", "больше"], ["lt", "меньше"], ["equals", "равно"]];
interface Cond { param: string; op: string; value: string }

function RuleModal({ companyId, rows, onClose, onApplied }: { companyId: number; rows: DetectRow[]; onClose: () => void; onApplied: (r: DetectRow[]) => void }) {
  const cats = useCategories();
  const parties = useCounterparties();
  const projects = useProjects();
  const [opType, setOpType] = useState<"income" | "outcome" | "move">("outcome");
  const [conds, setConds] = useState<Cond[]>([{ param: "counterparty", op: "contains", value: "" }]);
  const [useCat, setUseCat] = useState(true);
  const [catId, setCatId] = useState<string>("");
  const [useProj, setUseProj] = useState(false);
  const [projId, setProjId] = useState<string>("");
  const [useCp, setUseCp] = useState(false);
  const [cpId, setCpId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const opsFor = (p: string) => (p === "amount" ? NUM_OPS : TEXT_OPS);
  const setCond = (i: number, patch: Partial<Cond>) => setConds((cs) => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const catList = cats.data?.filter((c) => opType === "income" ? c.kind === "income" : opType === "outcome" ? c.kind === "outcome" : true);

  const save = async () => {
    const actions: any = {};
    if (useCat && catId) actions.category_id = Number(catId);
    if (useProj && projId) actions.project_id = Number(projId);
    if (useCp && cpId) actions.counterparty_id = Number(cpId);
    if (!conds.some((c) => c.value.trim())) return setErr("Заполните значение условия");
    if (!Object.keys(actions).length) return setErr("Выберите хотя бы одно действие (статья, проект или контрагент)");
    setBusy(true); setErr("");
    try {
      await api.post("/api/distribution-rules", {
        op_type: opType, scope: "bank",
        conditions: conds.filter((c) => c.value.trim()), actions,
      }, { params: { company_id: companyId } });
      const applied = (await api.post("/api/distribution-rules/apply", { rows, scope: "bank" }, { params: { company_id: companyId } })).data;
      onApplied(applied.rows);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || "Не удалось сохранить правило");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-10 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Создать правило распределения <span className="ml-2 text-xs font-normal uppercase text-slate-400">Шаг 1 из 2</span></h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <div className="mb-4 rounded-md border p-3">
          <div className="mb-2 text-sm font-semibold">Тип операции</div>
          <div className="flex gap-5 text-sm">
            {([["income", "Поступление"], ["outcome", "Выплата"], ["move", "Перемещение"]] as const).map(([v, l]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" checked={opType === v} onChange={() => setOpType(v)} />{l}</label>
            ))}
          </div>
        </div>

        <div className="mb-4 rounded-md border p-3">
          <div className="mb-2 text-sm font-semibold">Если у операции</div>
          <div className="space-y-2">
            {conds.map((c, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1"><div className="label">Параметр</div>
                  <select className="input !py-1.5" value={c.param} onChange={(e) => setCond(i, { param: e.target.value, op: opsFor(e.target.value)[0][0] })}>
                    {PARAMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div className="flex-1"><div className="label">Условие</div>
                  <select className="input !py-1.5" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                    {opsFor(c.param).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div className="flex-1"><div className="label">Значение</div>
                  <input className="input !py-1.5" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}
                    placeholder={c.param === "amount" ? "10000" : "текст"} /></div>
                {conds.length > 1 && <button className="pb-2 text-red-400 hover:text-red-600" onClick={() => setConds((cs) => cs.filter((_, idx) => idx !== i))}>✕</button>}
              </div>
            ))}
          </div>
          <button className="mt-2 text-sm text-brand hover:underline" onClick={() => setConds((cs) => [...cs, { param: "description", op: "contains", value: "" }])}>+ Добавить условие</button>
        </div>

        <div className="mb-4 rounded-md border p-3">
          <div className="mb-2 text-sm font-semibold">То назначить операции</div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <label className="flex w-28 items-center gap-2"><input type="checkbox" checked={useCat} onChange={(e) => setUseCat(e.target.checked)} />Статья</label>
              <select className="input !py-1.5" disabled={!useCat} value={catId} onChange={(e) => setCatId(e.target.value)}>
                <option value="">— выберите статью —</option>
                {catList?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex w-28 items-center gap-2"><input type="checkbox" checked={useProj} onChange={(e) => setUseProj(e.target.checked)} />Проект</label>
              <select className="input !py-1.5" disabled={!useProj} value={projId} onChange={(e) => setProjId(e.target.value)}>
                <option value="">— выберите проект —</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex w-28 items-center gap-2"><input type="checkbox" checked={useCp} onChange={(e) => setUseCp(e.target.checked)} />Контрагент</label>
              <select className="input !py-1.5" disabled={!useCp} value={cpId} onChange={(e) => setCpId(e.target.value)}>
                <option value="">— выберите контрагента —</option>
                {parties.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        {err && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Отменить</button>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? "Сохранение…" : "Сохранить и применить"}</button>
        </div>
      </div>
    </div>
  );
}

export function SuccessModal({ result, onClose, onDone }: { result: any; onClose: () => void; onDone?: () => void }) {
  const ops = result.operations, cp = result.counterparties, ac = result.accounts, en = result.entities;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-16 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">✓</span>
          <h3 className="text-lg font-semibold">Данные загружены успешно</h3>
        </div>
        <p className="mb-3 text-sm font-medium text-slate-500">Загружено новых объектов:</p>
        <div className="space-y-2">
          <CountRow label="Операций" loaded={ops.loaded} total={ops.total} />
          <CountRow label="Контрагентов" loaded={cp.new} total={cp.new + cp.existing} existing={cp.existing} />
          <CountRow label="Счетов" loaded={ac.new} total={ac.new + ac.existing} existing={ac.existing} />
          <CountRow label="Юрлиц" loaded={en.new} total={en.new + en.existing} existing={en.existing} />
        </div>
        <div className="mt-5 flex items-center justify-between">
          <button className="text-brand hover:underline" onClick={() => { onDone?.(); onClose(); }}>Загрузить ещё файл</button>
          <button className="btn-primary" onClick={onClose}>Продолжить работу</button>
        </div>
      </div>
    </div>
  );
}
