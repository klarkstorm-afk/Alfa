// Alpha Travel — приём заявок и отзывов с сайта (POST /lead).
// Сохраняет в админку (Netlify Blobs), сразу шлёт уведомление в Telegram и, если подключена, передаёт заявку в CRM.
// Никаких ключей в коде: TELEGRAM_BOT_TOKEN задаётся в Netlify → Environment variables.
import { randomBytes } from "node:crypto";
import { json, leadsStore, keyFor, personKeys } from "../lib/util.mjs";
import { tgReady, tgChats, tgSend, leadMessage } from "../lib/telegram.mjs";
import { crmCfg, crmPush, crmMark } from "../lib/crm.mjs";

export const config = { path: "/lead" };

const LIM = {
  booking: { type: 20, summary: 3000, name: 80, contact: 80, email: 120, comment: 1500, lang: 5, consent: 160 },
  review: { name: 60, rating: 1, target: 40, text: 1200, lang: 5, consent: 160 }
};
const clean = v => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();

// Ограничение частоты (на экземпляр функции): защищает хранилище и Telegram от флуда.
const hits = new Map(), global = [];
function limited(ip, now) {
  while (global.length && now - global[0] > 3600e3) global.shift();
  if (global.length >= 400) return "rate_global";
  const h = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (h.length && now - h[h.length - 1] < 20e3) return "rate_short";
  if (h.length >= 10) return "rate_hour";
  h.push(now); hits.set(ip, h); global.push(now);
  if (hits.size > 5000) hits.clear();
  return "";
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let p;
  try { const raw = await req.text(); if (raw.length > 20000) return json({ error: "too_big" }, 413); p = JSON.parse(raw); }
  catch { return json({ error: "invalid" }, 400); }
  const form = p && LIM[p.form] ? p.form : null;
  if (!form || !p.data || typeof p.data !== "object") return json({ error: "invalid" }, 400);
  if (clean(p.data["bot-field"])) return json({ ok: true });                 // ловушка для ботов

  const d = {};
  for (const [k, n] of Object.entries(LIM[form])) d[k] = clean(p.data[k]).slice(0, n);
  const bad = form === "booking"
    ? d.name.length < 2 || d.contact.replace(/^[^:]{2,20}:\s*/, "").length < 3 || !d.consent || (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email))
    : d.name.length < 2 || !/^[1-5]$/.test(d.rating) || d.text.length < 3 || !d.consent;
  if (bad) return json({ error: "invalid" }, 400);
  if (/<\s*(script|iframe|a\s)/i.test(Object.values(d).join(" "))) return json({ error: "invalid" }, 400);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const now = Date.now(), lim = limited(ip, now);
  if (lim) return json({ error: lim }, 429);

  const id = `${form[0]}-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
  const rec = { id, form, at: new Date(now).toISOString(), data: d, st: "new", note: "", mgr: "", rem: "" };
  const store = leadsStore(), key = keyFor(form, now, id);

  let stored = false;
  try {
    await store.setJSON(key, rec);
    await Promise.all(personKeys(rec).map(k => store.set(k, key)));
    stored = true;
  } catch (e) { console.error("store failed", String(e)); }

  // Уведомление в Telegram и передача в CRM — параллельно, чтобы посетитель не ждал.
  // Результаты пишем в заявку: в админке видно, если что-то не дошло (и можно отправить повторно).
  let tg = "off", cx = "off";
  const jobs = [];
  if (tgReady()) jobs.push(tgChats().then(async chats => {
    if (!chats.length) return;
    try { await tgSend(chats, leadMessage(rec)); tg = "sent"; } catch (e) { tg = "failed"; console.error("telegram failed", String(e)); }
  }));
  jobs.push(crmCfg().then(async cfg => {
    if (!cfg) return;
    try { const r = await crmPush(rec, cfg); cx = r.st; if (r.id) rec.cxid = r.id; if (r.st === "sent") await crmMark(true); }
    catch (e) { cx = "failed"; rec.cxerr = String(e?.message || e).slice(0, 200); console.error("crm failed", String(e)); await crmMark(false, e?.message || e); }
  }).catch(e => console.error("crm cfg", String(e))));
  await Promise.all(jobs);
  if (stored && (tg !== "off" || cx !== "off")) { rec.tg = tg; rec.cx = cx; await store.setJSON(key, rec).catch(() => {}); }
  if (!stored && tg !== "sent" && cx !== "sent") return json({ error: "store" }, 503);
  return json({ ok: true, id });
};
