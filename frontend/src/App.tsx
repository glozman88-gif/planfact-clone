import { Navigate, Route, Routes } from "react-router-dom";
import { useApp } from "./context/AppContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Operations } from "./pages/Operations";
import { Cashflow } from "./pages/Cashflow";
import { Pnl } from "./pages/Pnl";
import { Balance } from "./pages/Balance";
import { PaymentCalendar } from "./pages/PaymentCalendar";
import { Products } from "./pages/Products";
import { Budgets } from "./pages/Budgets";
import { Accounts } from "./pages/Accounts";
import { Categories } from "./pages/Categories";
import { Projects } from "./pages/Projects";
import { ProjectCard } from "./pages/ProjectCard";
import { Counterparties } from "./pages/Counterparties";
import { LegalEntities } from "./pages/LegalEntities";
import { Deals } from "./pages/Deals";
import { DealCard } from "./pages/DealCard";
import { RecurringOperations } from "./pages/RecurringOperations";
import { ImportOperations } from "./pages/ImportOperations";
import { ImportRules } from "./pages/ImportRules";
import { BankIntegration } from "./pages/BankIntegration";
import { Settings } from "./pages/Settings";

export default function App() {
  const token = localStorage.getItem("token");
  const { loading } = useApp();

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-500">Загрузка…</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="operations" element={<Operations />} />
        <Route path="recurring" element={<RecurringOperations />} />
        <Route path="reports/cashflow" element={<Cashflow />} />
        <Route path="reports/pnl" element={<Pnl />} />
        <Route path="reports/balance" element={<Balance />} />
        <Route path="budgets" element={<Budgets />} />
        <Route path="budget/bdr" element={<Budgets mode="bdr" />} />
        <Route path="budget/bdds" element={<Budgets mode="bdds" />} />
        <Route path="budget/calendar" element={<PaymentCalendar />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="categories" element={<Categories />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectCard />} />
        <Route path="counterparties" element={<Counterparties />} />
        <Route path="legal-entities" element={<LegalEntities />} />
        <Route path="products" element={<Products />} />
        <Route path="deals" element={<Deals />} />
        <Route path="deals/:id" element={<DealCard />} />
        <Route path="import" element={<ImportOperations />} />
        <Route path="import-rules" element={<ImportRules />} />
        <Route path="bank-integration" element={<BankIntegration />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
