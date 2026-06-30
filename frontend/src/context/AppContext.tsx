import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "../api/client";
import type { Company, User } from "../api/types";

interface AppState {
  user: User | null;
  companies: Company[];
  companyId: number | null;
  setCompanyId: (id: number) => void;
  reloadCompanies: () => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const Ctx = createContext<AppState>(null as any);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyIdState] = useState<number | null>(
    Number(localStorage.getItem("companyId")) || null
  );
  const [loading, setLoading] = useState(true);

  function setCompanyId(id: number) {
    localStorage.setItem("companyId", String(id));
    setCompanyIdState(id);
  }

  async function reloadCompanies() {
    const { data } = await api.get<Company[]>("/api/companies");
    setCompanies(data);
    if (data.length && (!companyId || !data.find((c) => c.id === companyId))) {
      setCompanyId(data[0].id);
    }
  }

  function logout() {
    localStorage.removeItem("token");
    location.href = "/login";
  }

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get<User>("/api/auth/me");
        setUser(data);
        await reloadCompanies();
      } catch {
        // не авторизованы — интерсептор перекинет на /login
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider value={{ user, companies, companyId, setCompanyId, reloadCompanies, logout, loading }}>
      {children}
    </Ctx.Provider>
  );
}
