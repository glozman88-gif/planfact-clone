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
        { name: "bank_name", label: "Банк (наименование)" },
        { name: "settlement_account", label: "Расчётный счёт (Р/с)" },
        { name: "bik", label: "БИК" },
        { name: "corr_account", label: "Корр. счёт (К/с)" },
        { name: "director_name", label: "ФИО руководителя" },
        { name: "accountant_name", label: "ФИО бухгалтера" },
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
