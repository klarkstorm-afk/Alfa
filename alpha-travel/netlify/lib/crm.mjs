// Alpha Travel — передача заявок во внешнюю CRM.
// Подключается в админке: «Компания и контакты» → «CRM». Настройки (ссылка-вебхук, токен) хранятся
// приватно в Netlify Blobs и никогда не попадают в браузер посетителя или в репозиторий.
// Поддерживается:
//   bitrix24 — входящий вебхук Битрикс24 (https://<портал>.bitrix24.kg/rest/<id>/<код>/), метод crm.lead.add
//   amocrm   — amoCRM / Kommo: домен аккаунта + долгосрочный токен, метод /api/v4/leads/complex
//   webhook  — любая CRM или сервис-посредник (Make, Zapier, n8n, Albato, HubSpot workflow и т.п.): POST JSON
// Запасной вариант без админки: переменные Netlify CRM_WEBHOOK_URL и CRM_WEBHOOK_SECRET.
import { createHmac } from "node:crypto";
import { env, metaStore } from "./util.mjs";

export const CRM_KINDS = ["bitrix24", "amocrm", "webhook"];
const NAMES = { bitrix24: "Битрикс24", amocrm: "amoCRM / Kommo", webhook: "Вебхук" };

const BITRIX_RE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/rest\/\d{1,10}\/[a-z0-9]{6,64}\/?$/i;
const AMO_RE = /^[a-z0-9][a-z0-9-]{0,62}\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i;
// вебхук: только https и не внутренние адреса
function safeHttps(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.username || x.password) return false;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return false;      // IP-адреса не принимаем
    return u.length <= 600;
  } catch { return false; }
}

export async function crmCfg() {
  let c = null;
  try { c = await metaStore().get("crm", { type: "json" }); } catch (_) {}
  if (c && c.on && CRM_KINDS.includes(c.kind)) return c;
  if (!c && env("CRM_WEBHOOK_URL") && safeHttps(env("CRM_WEBHOOK_URL")))
    return { kind: "webhook", url: env("CRM_WEBHOOK_URL"), secret: env("CRM_WEBHOOK_SECRET"), on: true, fromEnv: true };
  return null;
}

// что видит админка: без токенов и полных ссылок
const mask = s => { s = String(s || ""); return s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s ? "••••" : ""; };
export function publicCfg(c) {
  if (!c) return { on: false };
  let where = "";
  if (c.kind === "bitrix24") try { where = new URL(c.url).hostname; } catch (_) {}
  if (c.kind === "amocrm") where = c.domain;
  if (c.kind === "webhook") try { where = new URL(c.url).hostname; } catch (_) {}
  return { on: !!c.on, kind: c.kind, name: NAMES[c.kind], where, token: c.kind === "amocrm" ? mask(c.token) : c.kind === "bitrix24" ? mask(c.url.split("/rest/")[1]) : "",
    secret: !!c.secret, fromEnv: !!c.fromEnv, reviews: !!c.reviews, at: c.at || "", last: c.last || null };
}

// проверка и сборка новой настройки из формы админки (пустое поле токена = оставить прежний)
export function buildCfg(b, prev) {
  const kind = String(b.kind || "");
  if (!CRM_KINDS.includes(kind)) throw new Error("Выберите тип CRM");
  const keep = prev && prev.kind === kind ? prev : {};
  const c = { kind, on: true, reviews: !!b.reviews, at: new Date().toISOString() };
  if (kind === "bitrix24") {
    const url = String(b.url || "").trim() || keep.url || "";
    if (!BITRIX_RE.test(url)) throw new Error("Ссылка вебхука Битрикс24 должна выглядеть так: https://ваш-портал.bitrix24.kg/rest/1/abc123xyz/");
    c.url = url.endsWith("/") ? url : url + "/";
  }
  if (kind === "amocrm") {
    const domain = String(b.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || keep.domain || "";
    if (!AMO_RE.test(domain)) throw new Error("Домен amoCRM: например alphatravel.amocrm.ru или alphatravel.kommo.com");
    const token = String(b.token || "").trim() || keep.token || "";
    if (token.length < 20 || /\s/.test(token)) throw new Error("Вставьте долгосрочный токен amoCRM (Настройки → Интеграции → ваша интеграция → Ключи и доступы)");
    c.domain = domain; c.token = token;
  }
  if (kind === "webhook") {
    const url = String(b.url || "").trim() || keep.url || "";
    if (!safeHttps(url)) throw new Error("Нужна ссылка https://… (внутренние адреса и IP не принимаются)");
    c.url = url;
    const secret = b.secret === "" && keep.secret ? keep.secret : String(b.secret || "").trim();
    if (secret.length > 200) throw new Error("Секрет слишком длинный");
    c.secret = secret;
  }
  return c;
}

/* ---------- данные заявки в удобном для CRM виде ---------- */
const TYPES = { tour: "Тур", hotel: "Отель", custom: "Свой тур", merch: "Мерч", gen: "Общий вопрос" };
function contactParts(contact) {
  const raw = String(contact || "").trim(), m = raw.match(/^([^:]{2,20}):\s*(.+)$/);
  const kind = (m ? m[1] : "").trim(), value = (m ? m[2] : raw).trim(), dig = value.replace(/\D/g, "");
  const isPhone = /^[+\d][\d\s()\-.]{6,}$/.test(value) && dig.length >= 7;
  return { kind, value, phone: isPhone ? "+" + dig : "" };
}
export function leadPayload(rec) {
  const d = rec.data || {}, isRev = rec.form === "review", c = contactParts(d.contact), site = (env("URL") || "").replace(/\/$/, "");
  return {
    event: isRev ? "review" : "lead", source: "alpha-travel", id: rec.id, created_at: rec.at, test: !!rec.test,
    type: isRev ? "review" : (d.type || "tour"), type_label: isRev ? "Отзыв" : (TYPES[d.type] || d.type || "Заявка"),
    name: d.name || "", contact: d.contact || "", contact_method: c.kind, contact_value: c.value, phone: c.phone, email: d.email || "",
    comment: d.comment || "", summary: d.summary || "", lang: d.lang || "",
    rating: isRev ? +d.rating || null : undefined, text: isRev ? d.text || "" : undefined, target: isRev ? d.target || "" : undefined,
    admin_url: site ? site + "/#admin" : ""
  };
}
const noteText = p => [
  `${p.type_label} с сайта Alpha Travel (${p.id})`, p.summary, "",
  `Имя: ${p.name}`, `Связь: ${p.contact}`, p.email ? `E-mail: ${p.email}` : "", p.comment ? `Комментарий: ${p.comment}` : "",
  p.text ? `Отзыв (${p.rating}/5): ${p.text}` : "", `Язык: ${String(p.lang).toUpperCase()}`
].filter((x, i) => x !== "" || i === 2).join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 6000);

async function call(url, init, label) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) });
      const txt = await r.text().catch(() => "");
      let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
      if (r.ok) return j;
      last = new Error(`${label} HTTP ${r.status}: ${(j && (j.error_description || j.detail || j.title || j.error)) || txt.slice(0, 160)}`);
      if (r.status < 500 && r.status !== 429) break;                  // ошибка настройки — повтор не поможет
    } catch (e) { last = e; }
    await new Promise(res => setTimeout(res, 700));
  }
  throw last;
}

const IM = { telegram: "TELEGRAM", instagram: "INSTAGRAM", facebook: "FACEBOOK" };
async function toBitrix(c, p) {
  const f = {
    TITLE: `${p.type_label}: ${p.name}`.slice(0, 250), NAME: p.name, SOURCE_ID: "WEB", OPENED: "Y",
    SOURCE_DESCRIPTION: "Сайт Alpha Travel", COMMENTS: noteText(p).replace(/\n/g, "<br>")
  };
  if (p.phone) f.PHONE = [{ VALUE: p.phone, VALUE_TYPE: /whatsapp/i.test(p.contact_method) ? "MOBILE" : "WORK" }];
  if (p.email) f.EMAIL = [{ VALUE: p.email, VALUE_TYPE: "WORK" }];
  const im = IM[String(p.contact_method).toLowerCase()];
  if (!p.phone && p.contact_value) f.IM = [{ VALUE: p.contact_value, VALUE_TYPE: im || "OTHER" }];
  const j = await call(c.url + "crm.lead.add.json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: f, params: { REGISTER_SONET_EVENT: "Y" } }) }, "Битрикс24");
  if (!j || j.error || !j.result) throw new Error("Битрикс24: " + ((j && (j.error_description || j.error)) || "пустой ответ"));
  return String(j.result);
}

async function toAmo(c, p) {
  const base = `https://${c.domain}/api/v4`, h = { "content-type": "application/json", authorization: `Bearer ${c.token}` };
  const cf = [];
  if (p.phone) cf.push({ field_code: "PHONE", values: [{ value: p.phone, enum_code: "WORK" }] });
  if (p.email) cf.push({ field_code: "EMAIL", values: [{ value: p.email, enum_code: "WORK" }] });
  const lead = [{ name: `${p.type_label}: ${p.name}`.slice(0, 250), _embedded: { tags: [{ name: "Сайт" }, { name: p.type_label }], contacts: [{ first_name: p.name || "Клиент", ...(cf.length ? { custom_fields_values: cf } : {}) }] } }];
  const j = await call(base + "/leads/complex", { method: "POST", headers: h, body: JSON.stringify(lead) }, "amoCRM");
  const id = Array.isArray(j) && j[0] && j[0].id;
  if (!id) throw new Error("amoCRM: сделка не создана");
  await call(`${base}/leads/${id}/notes`, { method: "POST", headers: h, body: JSON.stringify([{ note_type: "common", params: { text: noteText(p) } }]) }, "amoCRM").catch(e => console.error("amo note", String(e)));
  return String(id);
}

async function toWebhook(c, p) {
  const body = JSON.stringify(p), h = { "content-type": "application/json", "user-agent": "alpha-travel-site" };
  if (c.secret) { h["x-alpha-secret"] = c.secret; h["x-alpha-signature"] = "sha256=" + createHmac("sha256", c.secret).update(body).digest("hex"); }
  const j = await call(c.url, { method: "POST", headers: h, body }, "Вебхук");
  return j && (j.id || j.lead_id || j.result) ? String(j.id || j.lead_id || j.result).slice(0, 40) : "ok";
}

export async function crmPush(rec, cfg) {
  const c = cfg || await crmCfg();
  if (!c) return { st: "off" };
  if (rec.form === "review" && !c.reviews) return { st: "skip" };
  const p = leadPayload(rec);
  const id = c.kind === "bitrix24" ? await toBitrix(c, p) : c.kind === "amocrm" ? await toAmo(c, p) : await toWebhook(c, p);
  return { st: "sent", id };
}

// последний результат — чтобы в админке было видно, работает ли связь
export async function crmMark(ok, err) {
  try {
    const st = metaStore(), c = await st.get("crm", { type: "json" });
    if (c) { c.last = { ok, at: new Date().toISOString(), err: ok ? "" : String(err || "").slice(0, 200) }; await st.setJSON("crm", c); }
  } catch (_) {}
}
