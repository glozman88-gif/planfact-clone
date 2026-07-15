// Быстрые пресеты периода для фильтров по дате.
const iso = (d: Date) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};

export function datePresets(): { label: string; from: string; to: string }[] {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const shift = (base: Date, off: number) => { const x = new Date(base); x.setDate(x.getDate() + off); return x; };
  const dow = (t.getDay() + 6) % 7;                 // 0 = понедельник
  const weekStart = shift(t, -dow);
  const y = t.getFullYear(), m = t.getMonth();
  const q = Math.floor(m / 3);
  return [
    { label: "Сегодня", from: iso(t), to: iso(t) },
    { label: "Вчера", from: iso(shift(t, -1)), to: iso(shift(t, -1)) },
    { label: "Эта неделя", from: iso(weekStart), to: iso(shift(weekStart, 6)) },
    { label: "Прошлая неделя", from: iso(shift(weekStart, -7)), to: iso(shift(weekStart, -1)) },
    { label: "Этот месяц", from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { label: "Прошлый месяц", from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { label: "Этот квартал", from: iso(new Date(y, q * 3, 1)), to: iso(new Date(y, q * 3 + 3, 0)) },
    { label: "Прошлый квартал", from: iso(new Date(y, q * 3 - 3, 1)), to: iso(new Date(y, q * 3, 0)) },
    { label: "Этот год", from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) },
    { label: "Прошлый год", from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) },
    { label: "Последние 7 дней", from: iso(shift(t, -6)), to: iso(t) },
    { label: "Последние 30 дней", from: iso(shift(t, -29)), to: iso(t) },
    { label: "Последние 12 месяцев", from: iso(new Date(y - 1, m, t.getDate())), to: iso(t) },
    { label: "Будущие", from: iso(shift(t, 1)), to: "" },
    { label: "Всё время", from: "", to: "" },
  ];
}

export function DatePresets({ onSelect, className = "" }: { onSelect: (from: string, to: string) => void; className?: string }) {
  return (
    <select className={`input ${className}`} value="" onChange={(e) => {
      const p = datePresets().find((x) => x.label === e.target.value);
      if (p) onSelect(p.from, p.to);
    }} title="Быстрый период">
      <option value="">Быстрый период…</option>
      {datePresets().map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
    </select>
  );
}
