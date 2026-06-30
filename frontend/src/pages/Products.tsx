import { CrudPage } from "../components/CrudPage";
import { money } from "../api/client";

// Цена с НДС с учётом признака «цена уже включает НДС».
function priceWithVat(r: any): number {
  const p = Number(r.price || 0);
  const rate = Number(r.vat_rate || 0) / 100;
  return r.price_includes_vat ? p : p * (1 + rate);
}

export function Products() {
  return (
    <CrudPage
      title="Товары и услуги"
      path="/api/products"
      queryKey="products"
      fields={[
        { name: "name", label: "Наименование", required: true },
        { name: "sku", label: "Артикул" },
        { name: "unit", label: "Единица", default: "шт" },
        { name: "price", label: "Цена за ед.", type: "number", default: "0" },
        { name: "cost", label: "Себестоимость", type: "number", default: "0" },
        { name: "vat_rate", label: "Ставка НДС, %", type: "select", default: "20",
          options: [{ value: "0", label: "Без НДС (0%)" }, { value: "10", label: "10%" }, { value: "20", label: "20%" }] },
        { name: "price_includes_vat", label: "Цена указана с НДС", type: "checkbox", default: true },
        { name: "is_service", label: "Это услуга", type: "checkbox", default: false },
      ]}
      columns={[
        { name: "name", label: "Наименование" },
        { name: "sku", label: "Артикул" },
        { name: "unit", label: "Единица" },
        { name: "price", label: "Цена за ед.", align: "right", render: (r) => money(r.price) },
        { name: "vat_rate", label: "НДС", align: "right", render: (r) => `${Number(r.vat_rate || 0)}%` },
        { name: "with_vat", label: "Цена с НДС", align: "right", render: (r) => money(priceWithVat(r)) },
        { name: "is_service", label: "Тип", render: (r) => (r.is_service ? "Услуга" : "Товар") },
      ]}
    />
  );
}
