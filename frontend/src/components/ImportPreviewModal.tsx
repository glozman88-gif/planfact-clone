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
  accounts: { bank_account: string; matched_app_account_id?: number | null; matched_name?: string | null; will_create?: boolean; suggest_name?: string }[];
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
  onClose: () => void;
  onDone: () => void;             // после успешной загрузки (обновить списки)
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  const mon = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"][Number(m) - 1] || m;
  return `${d} ${mon} ’${y.slice(2)}`;
};
const shortAcc = (a?: string | null) => (a ? `…${a.slice(-4)}` : "—");

export function ImportPreviewModal({ companyId, source, detect, accounts, legalEntityId, onClose, onDone }: Props) {
  const cats = useCategories();
  const parties = useCounterparties();
  const projects = useProjects();
  const [rows, setRows] = useState<DetectRow[]>(() => detect.rows.map((r) => ({ ...r })));
  const [tab, setTab] = useState<"ops" | "parties" | "accounts" | "entities">("ops");
  const [result, setResult] = useState<any>(null);

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
        accounts, rows: included,
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
          <button className="ml-auto pb-2 font-medium text-brand hover:underline">Создать правило распределения</button>
        </div>

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
