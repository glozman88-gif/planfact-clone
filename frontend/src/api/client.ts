import axios from "axios";

// Базовый axios-клиент. Токен берём из localStorage и кладём в Authorization.
export const api = axios.create({ baseURL: "/" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error?.response?.status === 401 && !location.pathname.startsWith("/login")) {
      localStorage.removeItem("token");
      location.href = "/login";
    }
    return Promise.reject(error);
  }
);

// Настройка отображения копеек (управляется из настроек компании)
let SHOW_KOPECKS = true;
export function setMoneyKopecks(v: boolean) { SHOW_KOPECKS = v; }

// Хелпер форматирования денег
// Символ валюты по коду (для отображения вместо RUB/USD/EUR)
const CURRENCY_SYMBOL: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€" };

export function money(value: string | number | null | undefined, currency = "₽"): string {
  const n = Number(value ?? 0);
  const sym = CURRENCY_SYMBOL[currency] ?? currency;
  return n.toLocaleString("ru-RU", { maximumFractionDigits: SHOW_KOPECKS ? 2 : 0, minimumFractionDigits: 0 }) + " " + sym;
}

// Скачивание файла из защищённого эндпойнта (с Bearer-токеном). Имя берём из
// Content-Disposition, иначе fallback. Чистит пустые параметры.
export async function downloadFile(url: string, params: Record<string, any>, fallbackName: string): Promise<void> {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const res = await api.get(url, { params: clean, responseType: "blob" });
  const cd = (res.headers["content-disposition"] as string | undefined) ?? "";
  const m = cd.match(/filename="?([^";]+)"?/);
  const name = m?.[1] || fallbackName;
  const blobUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}
