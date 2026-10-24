// Alpha Travel — общие помощники серверных функций. Секреты только в переменных окружения Netlify.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

export const env = k => {
  try { const v = globalThis.Netlify?.env?.get?.(k); if (v !== undefined && v !== null) return String(v).trim(); } catch (_) {}
  return String(process.env[k] ?? "").trim();
};
export const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const leadsStore = () => getStore({ name: "alpha-leads", consistency: "strong" });
export const metaStore = () => getStore({ name: "alpha-admin", consistency: "strong" });

// Ключи «<b|r>/<1e15 - время>/<id>»: список идёт от новых к старым, читаем только нужную страницу.
export const INV = 1e15;
export const PREFIX = { booking: "b/", review: "r/" };
export const keyFor = (form, ts, id) => `${PREFIX[form]}${String(INV - ts).padStart(15, "0")}/${id}`;
// id вида «b-<время36>-<случайно>» — по нему ключ находится сразу, без перебора
export const parseId = id => {
  const m = /^([br])-([0-9a-z]{6,12})-[0-9a-f]{6,16}$/.exec(String(id || ""));
  if (!m) return null;
  const form = m[1] === "b" ? "booking" : "review";
  return { form, key: keyFor(form, parseInt(m[2], 36), id) };
};

export const h16 = v => createHash("sha256").update(String(v)).digest("hex").slice(0, 16);
export const digits = v => String(v || "").replace(/\D/g, "");
// индекс для запросов клиента (Цифровой кодекс КР / GDPR): хэш контакта и e-mail, сами данные в ключе не хранятся
export const personKeys = rec => {
  const d = rec.data || {}, out = [];
  const c = String(d.contact || "").replace(/^[^:]{2,20}:\s*/, "").trim().toLowerCase();
  if (c) out.push(`idx/${h16(digits(c).length >= 7 ? digits(c) : c.replace(/^@/, ""))}/${rec.id}`);
  if (d.email) out.push(`idx/${h16(String(d.email).trim().toLowerCase())}/${rec.id}`);
  return out;
};
