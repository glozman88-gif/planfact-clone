import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { useApp } from "../context/AppContext";
import type { Account, Category, Counterparty, DealStatus, LegalEntity, Project } from "./types";

// Универсальный список справочника, привязанного к компании.
function useDict<T>(path: string, key: string) {
  const { companyId } = useApp();
  return useQuery({
    queryKey: [key, companyId],
    enabled: !!companyId,
    queryFn: async () => (await api.get<T[]>(path, { params: { company_id: companyId } })).data,
  });
}

export const useAccounts = () => useDict<Account>("/api/accounts", "accounts");
export const useCategories = () => useDict<Category>("/api/categories", "categories");
export const useProjects = () => useDict<Project>("/api/projects", "projects");
export const useCounterparties = () => useDict<Counterparty>("/api/counterparties", "counterparties");
export const useDealStatuses = () => useDict<DealStatus>("/api/deal-statuses", "deal-statuses");
export const useLegalEntities = () => useDict<LegalEntity>("/api/legal-entities", "legal-entities");

// Универсальные CRUD-мутации для справочника.
export function useCrud(path: string, key: string) {
  const { companyId } = useApp();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [key] });

  const create = useMutation({
    mutationFn: (body: any) => api.post(path, body, { params: { company_id: companyId } }),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => api.put(`${path}/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${path}/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}
