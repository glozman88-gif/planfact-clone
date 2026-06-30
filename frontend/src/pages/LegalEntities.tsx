import { CrudPage } from "../components/CrudPage";

export function LegalEntities() {
  return (
    <CrudPage
      title="Юридические лица"
      path="/api/legal-entities"
      queryKey="legal-entities"
      fields={[
        { name: "name", label: "Краткое название", required: true },
        { name: "full_name", label: "Полное наименование" },
        { name: "inn", label: "ИНН" },
        { name: "kpp", label: "КПП" },
        { name: "ogrn", label: "ОГРН / ОГРНИП" },
        { name: "address", label: "Адрес" },
      ]}
      columns={[
        { name: "name", label: "Название" },
        { name: "inn", label: "ИНН" },
        { name: "kpp", label: "КПП" },
        { name: "ogrn", label: "ОГРН" },
      ]}
    />
  );
}
