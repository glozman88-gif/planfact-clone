// Мини-график тренда (спарклайн) для строк отчётов.
export function Sparkline({ values, color = "#16b1bf", width = 90, height = 26 }: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!values.length) return <svg width={width} height={height} />;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
