import { useEffect, useMemo, useRef, useState } from "react";

type Opt = { id: number | string; name: string };

/**
 * Набираемый выпадающий список (комбобокс): печатаешь текст — список фильтруется по
 * совпадению, выбираешь строку мышью или клавиатурой (стрелки + Enter).
 * Совместим по интерфейсу с обычным <select>: value = id (строкой), onChange(value).
 */
export function SearchSelect({
  value, onChange, options, placeholder = "Начните вводить…",
  emptyLabel = "—", allowClear = true, className = "", disabled = false,
  autoFocus = false, onClose,
}: {
  value: string | number | null | undefined;
  onChange: (value: string) => void;
  options: Opt[];
  placeholder?: string;
  emptyLabel?: string;
  allowClear?: boolean;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => String(o.id) === String(value ?? ""));
  const selectedName = selected?.name ?? "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
    return base.slice(0, 200); // ограничение для очень длинных списков
  }, [options, query]);

  // пункты списка: сверху «очистить» (emptyLabel), затем отфильтрованные варианты
  const items: (Opt | null)[] = allowClear ? [null, ...filtered] : filtered;

  const close = () => { setOpen(false); setQuery(""); onClose?.(); };
  const pick = (o: Opt | null) => { onChange(o ? String(o.id) : ""); close(); inputRef.current?.blur(); };

  // Инлайн-режим: сразу сфокусировать и открыть список
  useEffect(() => { if (autoFocus) { inputRef.current?.focus(); setOpen(true); setHi(0); } }, [autoFocus]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); setHi(0); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (hi < items.length) pick(items[hi]); }
    else if (e.key === "Escape") { close(); inputRef.current?.blur(); }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <input
        ref={inputRef}
        className="input"
        disabled={disabled}
        value={open ? query : selectedName}
        placeholder={selectedName || placeholder}
        onFocus={() => { setOpen(true); setQuery(""); setHi(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={onKey}
      />
      {open && (
        <div className="absolute z-30 mt-1 max-h-60 w-full min-w-[10rem] overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {items.length === 0 && <div className="px-3 py-1.5 text-slate-400">Ничего не найдено</div>}
          {items.map((o, i) => (
            <button
              type="button"
              key={o ? String(o.id) : "__empty"}
              className={`block w-full truncate px-3 py-1.5 text-left ${i === hi ? "bg-brand-light/60" : "hover:bg-slate-50"} ${o && String(o.id) === String(value) ? "font-medium text-brand-dark" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              {o ? o.name : <span className="text-slate-400">{emptyLabel}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
