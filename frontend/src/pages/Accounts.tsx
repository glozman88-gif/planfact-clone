import { useQuery } from "@tanstack/react-query";
import { api, money } from "../api/client";
import { useApp } from "../context/AppContext";
import { useLegalEntities } from "../api/hooks";
import { CrudPage } from "../components/CrudPage";
import type { AccountBalance } from "../api/types";

const KINDS = [
  { value: "cash", label: "Наличные" },
  { value: "bank", label: "Расчётный счёт" },
  { value: "card", label: "Карта" },
  { value: "ewallet", label: "Эл. кошелёк" },
  { value: "other", label: "Прочее" },
];

export function Accounts() {
  const { companyId } = useApp();
  const legalEntities = useLegalEntities();
  const balances = useQuery({
    queryKey: ["balances", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (await api.get<AccountBalance[]>("/api/account-balances", { params: { company_id: companyId } })).data,
  });
  const balMap = new Map(balances.data?.map((b) => [b.account_id, b.balance]));
  const leOptions = (legalEntities.data ?? []).map((le) => ({ value: le.id, label: le.name }));
  const leName = (id?: number | null) => legalEntities.data?.find((le) => le.id === id)?.name ?? "";

  return (
    <CrudPage
      title="Счета"
      path="/api/accounts"
      queryKey="accounts"
      fields={[
        { name: "name", label: "Название", required: true },
        { name: "kind", label: "Тип", type: "select", options: KINDS, default: "bank" },
        { name: "legal_entity_id", label: "Юрлицо", type: "select", options: leOptions, required: true },
        { name: "currency_code", label: "Валюта", default: "RUB" },
        { name: "opening_balance", label: "Начальный остаток", type: "number", default: "0" },
        { name: "exclude_from_totals", label: "Не учитывать в общем остатке", type: "checkbox" },
      ]}
      columns={[
        { name: "name", label: "Название" },
        { name: "kind", label: "Тип", render: (r) => KINDS.find((k) => k.value === r.kind)?.label ?? r.kind },
        { name: "legal_entity_id", label: "Юрлицо", render: (r) => leName(r.legal_entity_id) },
        { name: "currency_code", label: "Валюта", render: (r) => (({ RUB: "₽", USD: "$", EUR: "€" } as Record<string, string>)[r.currency_code] ?? r.currency_code) },
        { name: "balance", label: "Текущий остаток", align: "right", render: (r) => money(balMap.get(r.id) ?? "0", r.currency_code) },
        { name: "credit_limit", label: "Кредитный лимит", align: "right", render: (r) => Number(r.credit_limit) > 0 ? <span className="text-slate-400">+{money(r.credit_limit, r.currency_code)}</span> : "—" },
      ]}
    />
  );
}
