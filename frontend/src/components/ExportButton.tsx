import { useState } from "react";
import { downloadFile } from "../api/client";

// Кнопка экспорта отчёта/списка в Excel. Скачивает .xlsx с защищённого эндпойнта.
export function ExportButton({
  url, params, filename, label = "Экспорт в Excel",
}: {
  url: string;
  params: Record<string, any>;
  filename: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  return (
    <button
      className="btn-ghost flex items-center gap-1.5 whitespace-nowrap"
      disabled={busy}
      title="Скачать в формате Excel"
      onClick={async () => {
        setBusy(true);
        setErr(false);
        try {
          await downloadFile(url, params, filename);
        } catch {
          setErr(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
      </svg>
      {busy ? "Экспорт…" : err ? "Ошибка — повторить" : label}
    </button>
  );
}
