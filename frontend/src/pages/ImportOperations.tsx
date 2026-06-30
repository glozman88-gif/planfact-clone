import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useApp } from "../context/AppContext";
import { useAccounts } from "../api/hooks";

interface ImportField { key: string; label: string; required: boolean }
interface Preview { filename: string; width: number; total_rows: number; rows: string[][] }
interface ImportResult { rows_total: number; rows_imported: number; errors: string[] }
interface ImportLogRow {
  id: number; source: string; filename: string | null; rows_total: number;
  rows_imported: number; status: string; message: string | null; created_at: string | null;
}
interface ImportRule {
  id: number; name: string;
  mapping: Record<string, number | null>;
  options: { has_header?: boolean; default_account_id?: number | null; create_missing?: boolean };
}

// Поля для авто-сопоставления по ключевым словам в заголовке колонки.
const GUESS: Record<string, string[]> = {
  op_date: ["дата опл", "дата пров", "дата опер", "дата", "date", "payment"],
  amount_income: ["приход", "поступлен", "зачислен", "пополнен", "кредит оборот"],
  amount_outcome: ["расход", "списан", "выплат", "дебет оборот"],
  amount: ["сумма операц", "сумма платеж", "сумма", "оборот", "amount", "сумм"],
  type: ["тип", "направлен", "type", "операци", "дебет/кредит"],
  account: ["счёт", "счет", "касса", "account"],
  category: ["статья", "категор", "category"],
  counterparty: ["контрагент", "плательщ", "получател", "counterparty", "назначение платеж"],
  project: ["проект", "project"],
  accrual_date: ["дата начисл", "начислен", "accrual"],
  description: ["назначен", "коммент", "описан", "purpose", "description"],
};

function guessMapping(fields: ImportField[], header: string[]): Record<string, number | null> {
  const used = new Set<number>();
  const map: Record<string, number | null> = {};
  for (const f of fields) {
    const keys = GUESS[f.key] ?? [];
    let found: number | null = null;
    for (const kw of keys) {
      const idx = header.findIndex((h, i) => !used.has(i) && h.toLowerCase().includes(kw));
      if (idx >= 0) { found = idx; used.add(idx); break; }
    }
    map[f.key] = found;
  }
  return map;
}

export function ImportOperations() {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  const [defAccount, setDefAccount] = useState("");
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [ruleName, setRuleName] = useState("");

  const fieldsQ = useQuery({
    queryKey: ["import-fields"],
    queryFn: async () => (await api.get<ImportField[]>("/api/imports/fields")).data,
  });
  const fields = fieldsQ.data ?? [];

  const logsQ = useQuery({
    queryKey: ["import-logs", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<ImportLogRow[]>("/api/imports/logs", { params: { company_id: companyId } })).data,
  });

  const rulesQ = useQuery({
    queryKey: ["import-rules", companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<ImportRule[]>("/api/imports/rules", { params: { company_id: companyId } })).data,
  });

  function applyRule(rule: ImportRule) {
    setMapping(rule.mapping ?? {});
    if (rule.options?.has_header != null) setHasHeader(!!rule.options.has_header);
    if (rule.options?.create_missing != null) setCreateMissing(!!rule.options.create_missing);
    setDefAccount(rule.options?.default_account_id ? String(rule.options.default_account_id) : "");
    setRuleName(rule.name);
  }

  const saveRule = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("name", ruleName);
      fd.append("mapping", JSON.stringify(mapping));
      fd.append("options", JSON.stringify({
        has_header: hasHeader,
        default_account_id: defAccount ? Number(defAccount) : null,
        create_missing: createMissing,
      }));
      return api.post("/api/imports/rules", fd, { params: { company_id: companyId } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["import-rules"] }),
  });

  const deleteRule = useMutation({
    mutationFn: (id: number) => api.delete(`/api/imports/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["import-rules"] }),
  });

  const header = useMemo(() => {
    if (!preview) return [];
    const w = preview.width;
    if (hasHeader && preview.rows.length) return preview.rows[0];
    return Array.from({ length: w }, (_, i) => `Колонка ${i + 1}`);
  }, [preview, hasHeader]);

  const dataRows = useMemo(() => {
    if (!preview) return [];
    return hasHeader ? preview.rows.slice(1) : preview.rows;
  }, [preview, hasHeader]);

  const doPreview = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return (await api.post<Preview>("/api/imports/preview", fd)).data;
    },
    onSuccess: (p) => {
      setPreview(p);
      setResult(null);
      const hdr = p.rows.length ? p.rows[0] : [];
      setMapping(guessMapping(fields, hdr));
    },
  });

  const doImport = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("mapping", JSON.stringify(mapping));
      fd.append("options", JSON.stringify({
        has_header: hasHeader,
        default_account_id: defAccount ? Number(defAccount) : null,
        create_missing: createMissing,
      }));
      return (await api.post<ImportResult>("/api/imports/operations", fd, { params: { company_id: companyId } })).data;
    },
    onSuccess: (r) => {
      setResult(r);
      ["operations", "balances", "dashboard", "balance", "cashflow", "pnl"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      qc.invalidateQueries({ queryKey: ["import-logs"] });
    },
  });

  const mappedCol = (key: string) => mapping[key];
  const dateMapped = mappedCol("op_date");
  const hasAmount = mappedCol("amount") != null || mappedCol("amount_income") != null || mappedCol("amount_outcome") != null;
  const canImport = !!file && dateMapped != null && hasAmount;

  // Для подсветки: индекс колонки → метка целевого поля
  const colToField: Record<number, string> = {};
  for (const f of fields) {
    const idx = mapping[f.key];
    if (idx != null) colToField[idx] = f.label;
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setResult(null);
    doPreview.mutate(f);
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Импорт операций</h1>

      {/* Шаг 1: файл */}
      <div className="card space-y-2">
        <h2 className="font-semibold">1. Файл (Excel .xlsx или CSV)</h2>
        <p className="text-xs text-slate-500">
          Загрузите таблицу операций (.xlsx/.csv), банковскую выписку 1С (1CClientBankExchange, .txt)
          или CSV-выписку банка (Тинькофф — одна колонка суммы со знаком; Сбер и др. — отдельные
          колонки Приход/Расход). После загрузки сопоставьте колонки с полями операции.
        </p>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt"
            className="text-sm"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {doPreview.isPending && <span className="text-sm text-slate-400">Чтение файла…</span>}
          {preview && <span className="text-sm text-slate-500">Строк в файле: {preview.total_rows}</span>}
        </div>
        {doPreview.isError && <div className="text-sm text-red-600">Не удалось прочитать файл</div>}
      </div>

      {preview && (
        <>
          {/* Шаг 2: сопоставление */}
          <div className="card space-y-3">
            <h2 className="font-semibold">2. Сопоставление колонок</h2>

            {/* Правила импорта */}
            <div className="flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-2 text-sm">
              <div>
                <div className="label">Правило импорта</div>
                <select
                  className="input !w-56"
                  value=""
                  onChange={(e) => {
                    const rule = rulesQ.data?.find((r) => r.id === Number(e.target.value));
                    if (rule) applyRule(rule);
                  }}
                >
                  <option value="">— применить сохранённое —</option>
                  {rulesQ.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <input
                className="input !w-48"
                placeholder="Название правила"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
              />
              <button className="btn-ghost" disabled={!ruleName || saveRule.isPending} onClick={() => saveRule.mutate()}>
                Сохранить правило
              </button>
              {rulesQ.data?.some((r) => r.name === ruleName) && (
                <button
                  className="btn-ghost text-red-500"
                  onClick={() => {
                    const r = rulesQ.data?.find((x) => x.name === ruleName);
                    if (r && confirm(`Удалить правило «${r.name}»?`)) deleteRule.mutate(r.id);
                  }}
                >
                  Удалить
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                Первая строка — заголовки
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                Создавать недостающие статьи и контрагентов
              </label>
              <label className="flex items-center gap-2">
                Счёт по умолчанию:
                <select className="input !w-48" value={defAccount} onChange={(e) => setDefAccount(e.target.value)}>
                  <option value="">— не задан —</option>
                  {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((f) => (
                <div key={f.key}>
                  <label className="label">
                    {f.label}{f.required && <span className="text-red-500"> *</span>}
                  </label>
                  <select
                    className={`input ${f.required && mapping[f.key] == null ? "ring-1 ring-red-300" : ""}`}
                    value={mapping[f.key] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === "" ? null : Number(e.target.value) })}
                  >
                    <option value="">— не импортировать —</option>
                    {header.map((h, i) => <option key={i} value={i}>{h || `Колонка ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {mapping["type"] == null && (
              <p className="text-xs text-slate-500">
                Колонка «Тип» не задана — направление определится по знаку суммы (плюс — поступление, минус — выплата).
              </p>
            )}
          </div>

          {/* Шаг 3: предпросмотр */}
          <div className="card space-y-2 p-0">
            <h2 className="px-4 pt-4 font-semibold">3. Предпросмотр ({dataRows.length} из {hasHeader ? preview.total_rows - 1 : preview.total_rows} строк)</h2>
            <div className="overflow-x-auto">
              <table className="table whitespace-nowrap text-sm">
                <thead>
                  <tr>
                    {header.map((h, i) => (
                      <th key={i} className={colToField[i] ? "bg-brand-light" : ""}>
                        <div>{h || `Колонка ${i + 1}`}</div>
                        {colToField[i] && <div className="text-xs font-normal text-brand-dark">→ {colToField[i]}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.slice(0, 15).map((row, ri) => (
                    <tr key={ri} className="hover:bg-slate-50">
                      {header.map((_, ci) => (
                        <td key={ci} className={colToField[ci] ? "bg-brand-light/30" : ""}>{row[ci] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3 px-4 pb-4">
              <button className="btn-primary" disabled={!canImport || doImport.isPending} onClick={() => doImport.mutate()}>
                {doImport.isPending ? "Импорт…" : "Импортировать"}
              </button>
              {!canImport && <span className="text-sm text-amber-600">Сопоставьте Дату и Сумму (одной колонкой или отдельно Приход/Расход)</span>}
            </div>
          </div>
        </>
      )}

      {/* Результат */}
      {result && (
        <div className={`card ${result.errors.length ? "border-amber-300" : "border-emerald-300"} border`}>
          <div className="font-semibold">
            Импортировано операций: {result.rows_imported} из {result.rows_total}
          </div>
          {result.errors.length > 0 && (
            <details className="mt-2 text-sm text-amber-700">
              <summary className="cursor-pointer">Пропущено строк: {result.errors.length}</summary>
              <ul className="mt-1 list-disc pl-5">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* История импортов */}
      <div className="card p-0">
        <h2 className="px-4 pt-4 font-semibold">История импортов</h2>
        <table className="table text-sm">
          <thead>
            <tr><th>Когда</th><th>Файл</th><th>Источник</th><th className="text-right">Импортировано</th><th>Статус</th></tr>
          </thead>
          <tbody>
            {(logsQ.data ?? []).map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap">{l.created_at ? l.created_at.slice(0, 19).replace("T", " ") : "—"}</td>
                <td>{l.filename || "—"}</td>
                <td>{l.source}</td>
                <td className="text-right">{l.rows_imported} / {l.rows_total}</td>
                <td>
                  <span className={l.status === "done" ? "text-emerald-600" : "text-amber-600"}>
                    {l.status === "done" ? "успешно" : "частично"}
                  </span>
                </td>
              </tr>
            ))}
            {logsQ.data && logsQ.data.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-slate-400">Импортов ещё не было</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
