// Типы данных, отражающие схемы бэкенда.
export type OperationType = "income" | "outcome" | "move" | "accrual" | "shipment" | "supply";
export type OperationStatus = "planned" | "committed";
export type CategoryKind = "income" | "outcome";

export interface User {
  id: number;
  email: string;
  full_name?: string | null;
  is_admin: boolean;
}

export interface Company {
  id: number;
  name: string;
  inn?: string | null;
  base_currency: string;
  is_archived: boolean;
  period_locked_until?: string | null;
  settings?: Record<string, any>;
}

export interface LegalEntity {
  id: number;
  company_id: number;
  name: string;
  full_name?: string | null;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  address?: string | null;
  is_archived: boolean;
}

export interface Account {
  id: number;
  company_id: number;
  group_id?: number | null;
  legal_entity_id?: number | null;
  name: string;
  kind: string;
  currency_code: string;
  opening_balance: string;
  exclude_from_totals: boolean;
  is_undistributed?: boolean;
  is_archived: boolean;
}

export interface AccountBalance {
  account_id: number;
  name: string;
  currency_code: string;
  balance: string;
}

export type CashFlowActivity = "operating" | "investing" | "financing";
export type BalanceSection =
  | "current_asset" | "noncurrent_asset" | "short_liability" | "long_liability" | "capital";

export interface Category {
  id: number;
  company_id: number;
  parent_id?: number | null;
  name: string;
  kind: CategoryKind | "asset" | "liability" | "capital";
  activity: CashFlowActivity;
  balance_section?: BalanceSection | null;
  is_dividend?: boolean;
  in_cashflow: boolean;
  in_pnl: boolean;
  sort: number;
  is_archived: boolean;
}

export interface Project {
  id: number;
  company_id: number;
  group_id?: number | null;
  name: string;
  is_archived: boolean;
}

export interface Counterparty {
  id: number;
  company_id: number;
  group_id?: number | null;
  name: string;
  kind: string;
  inn?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
  is_archived: boolean;
}

export interface OperationItem {
  id?: number;
  amount: string;
  category_id?: number | null;
  project_id?: number | null;
  description?: string | null;
}

export interface Operation {
  id: number;
  company_id: number;
  type: OperationType;
  status: OperationStatus;
  is_calculation_committed: boolean;
  is_opu_calculation?: boolean | null;
  op_date: string;
  accrual_date?: string | null;
  account_id?: number | null;
  to_account_id?: number | null;
  bound_move_operation_id?: number | null;
  amount: string;
  currency_code: string;
  base_amount?: string | null;
  category_id?: number | null;
  debit_category_id?: number | null;
  credit_category_id?: number | null;
  project_id?: number | null;
  counterparty_id?: number | null;
  deal_id?: number | null;
  description?: string | null;
  items: OperationItem[];
}

export interface OperationSummary {
  count: number;
  income_count: number; income_sum: string;
  outcome_count: number; outcome_sum: string;
  move_count: number; move_sum: string;
  accrual_count: number;
  total: string;
}
export interface OperationList {
  total: number;
  items: Operation[];
  summary: OperationSummary;
}

export interface Deal {
  id: number;
  company_id: number;
  kind: "sale" | "purchase";
  name: string;
  status_id?: number | null;
  counterparty_id?: number | null;
  project_id?: number | null;
  amount: string;
  cost: string;
  currency_code: string;
  start_date?: string | null;
  close_date?: string | null;
  note?: string | null;
}

export interface DealStatus {
  id: number;
  company_id: number;
  name: string;
  sort: number;
  is_won: boolean;
  is_lost: boolean;
}

export interface Product {
  id: number;
  company_id: number;
  group_id?: number | null;
  name: string;
  sku?: string | null;
  unit?: string | null;
  price: string;
  cost: string;
  is_service: boolean;
  vat_rate: string;
  price_includes_vat: boolean;
  is_archived: boolean;
}

export interface Budget {
  id: number;
  company_id: number;
  name: string;
  project_id?: number | null;
  date_from: string;
  date_to: string;
  items: { id?: number; category_id: number; period: string; amount: string }[];
}

// Отчёты
export interface ReportCategory {
  category_id: number | null;
  name: string;
  by_period: Record<string, string>;
  total: string;
  has_operations?: boolean;
  children?: ReportCategory[];
}

export interface ReportSection {
  kind: string;
  categories: ReportCategory[];
  by_period: Record<string, string>;
  total: string;
}

export interface PnlOperation {
  operation_id: number;
  type: string;
  date: string;
  amount: string;
  description: string | null;
  counterparty: string | null;
  project: string | null;
}

export interface CashSubsection {
  by_period: Record<string, string>;
  total: string;
  categories: { category_id: number | null; name: string; by_period: Record<string, string>; total: string }[];
}
export interface CashActivity {
  key: CashFlowActivity;
  title: string;
  income: CashSubsection;
  outcome: CashSubsection;
  net_by_period: Record<string, string>;
  net_total: string;
}
export interface CashGroup {
  key: number | null;
  name: string;
  income: string;
  outcome: string;
  net_by_period: Record<string, string>;
  net_total: string;
}

export interface CashflowReport {
  report: "cashflow";
  periods: string[];
  group_by?: string;
  groups?: CashGroup[] | null;
  activities: CashActivity[];
  moves: { writeoff_by_period: Record<string, string>; deposit_by_period: Record<string, string> };
  net_by_period: Record<string, string>;
  net_total: string;
  opening_by_period: Record<string, string>;
  closing_by_period: Record<string, string>;
  opening_balance: string;
  closing_balance: string;
}

export interface PnlGroup {
  key: number | null;
  name: string;
  income: string;
  outcome: string;
  profit: string;
  margin: number | null;
}

export interface PnlReport {
  report: "pnl";
  method: string;
  group_by?: string;
  groups?: PnlGroup[] | null;
  periods: string[];
  income: ReportSection;
  outcome: ReportSection;
  profit_by_period: Record<string, string>;
  profit_total: string;
  margin: number | null;
  metrics?: Record<string, string>;
  plan?: {
    income_by_period: Record<string, string>;
    outcome_by_period: Record<string, string>;
    profit_by_period: Record<string, string>;
    income_total: string;
    outcome_total: string;
    profit_total: string;
  } | null;
  dividends_by_period: Record<string, string>;
  dividends_total: string;
  retained_by_period: Record<string, string>;
  retained_total: string;
}

export interface BalanceSectionData {
  key: string;
  title: string;
  total: string;
  items: { name: string; amount: string }[];
}
export interface BalanceReport {
  report: "balance";
  as_of: string;
  assets: { total: string; sections: BalanceSectionData[] };
  liabilities: { total: string; sections: BalanceSectionData[] };
  capital: { total: string; sections: BalanceSectionData[] };
  passive_total: string;
  difference: string;
  balanced: boolean;
}

export interface PlanFactReport {
  report: "plan_fact";
  budget_id: number;
  budget_name: string;
  periods: string[];
  rows: {
    category_id: number | null;
    name: string;
    kind: string | null;
    plan_by_period: Record<string, string>;
    fact_by_period: Record<string, string>;
    plan_total: string;
    fact_total: string;
    deviation: string;
  }[];
}

export interface PaymentCalendar {
  report: "payment_calendar";
  periods: string[];
  opening_balance: string;
  closing_balance: string;
  has_gap: boolean;
  rows: {
    period: string; income: string; outcome: string; income_fact: string; outcome_fact: string;
    net: string; opening: string; closing: string; gap: boolean;
  }[];
}

export interface Dashboard {
  cash_balance: string;
  income_total: string;
  outcome_total: string;
  net_total: string;
  series: { period: string; income: string; outcome: string; net: string; closing: string }[];
  activities: { key: string; title: string; net_total: string }[];
  projects: { name: string; income: string; expense: string; profit: string; margin: number }[];
  top_clients: { name: string; income: string; cumulative_share?: number; pareto?: boolean }[];
  payment_structure?: {
    income: { name: string; amount: string }[];
    outcome: { name: string; amount: string }[];
  };
}
