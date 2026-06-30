import { CrudPage } from "../components/CrudPage";

export function Categories() {
  return (
    <CrudPage
      title="Статьи доходов и расходов"
      path="/api/categories"
      queryKey="categories"
      fields={[
        { name: "name", label: "Название", required: true },
        {
          name: "kind",
          label: "Тип статьи",
          type: "select",
          options: [
            { value: "income", label: "Доходы" },
            { value: "outcome", label: "Расходы" },
            { value: "asset", label: "Активы" },
            { value: "liability", label: "Обязательства" },
            { value: "capital", label: "Капитал" },
          ],
          default: "outcome",
        },
        {
          name: "activity",
          label: "Вид деятельности (ДДС)",
          type: "select",
          options: [
            { value: "operating", label: "Операционная" },
            { value: "investing", label: "Инвестиционная" },
            { value: "financing", label: "Финансовая" },
          ],
          default: "operating",
        },
        {
          name: "balance_section",
          label: "Раздел баланса (для активов/обязательств/капитала)",
          type: "select",
          options: [
            { value: "current_asset", label: "Оборотные активы" },
            { value: "noncurrent_asset", label: "Внеоборотные активы" },
            { value: "short_liability", label: "Краткосрочные обязательства" },
            { value: "long_liability", label: "Долгосрочные обязательства" },
            { value: "capital", label: "Капитал" },
          ],
        },
        { name: "is_dividend", label: "Это статья «Дивиденды» (контр-капитал)", type: "checkbox", default: false },
        { name: "in_cashflow", label: "Учитывать в ДДС", type: "checkbox", default: true },
        { name: "in_pnl", label: "Учитывать в ОПиУ", type: "checkbox", default: true },
        { name: "sort", label: "Сортировка", type: "number", default: "0" },
      ]}
      columns={[
        { name: "name", label: "Название" },
        {
          name: "kind", label: "Тип",
          render: (r) => ({ income: "Доходы", outcome: "Расходы", asset: "Активы", liability: "Обязательства", capital: "Капитал" }[r.kind as string] ?? r.kind),
        },
        {
          name: "activity", label: "Вид деятельности",
          render: (r) => ({ operating: "Операционная", investing: "Инвестиционная", financing: "Финансовая" }[r.activity as string] ?? r.activity),
        },
        { name: "in_cashflow", label: "ДДС", render: (r) => (r.in_cashflow ? "✓" : "—") },
        { name: "in_pnl", label: "ОПиУ", render: (r) => (r.in_pnl ? "✓" : "—") },
      ]}
    />
  );
}
