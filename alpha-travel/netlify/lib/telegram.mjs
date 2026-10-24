// Alpha Travel — уведомления о заявках и отзывах в Telegram.
// TELEGRAM_BOT_TOKEN — в переменных окружения Netlify (токен от @BotFather).
// Чаты, куда слать, хозяин подключает в админке (хранятся приватно в Netlify Blobs);
// запасной вариант — переменная TELEGRAM_CHAT_ID (можно несколько через запятую).
import { env, metaStore } from "./util.mjs";

export const tgReady = () => /^\d{5,}:[\w-]{20,}$/.test(env("TELEGRAM_BOT_TOKEN"));
const api = (m, body) => fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${m}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  signal: AbortSignal.timeout(8000)
}).then(r => r.json().catch(() => ({ ok: false, description: "HTTP " + r.status })));

export async function tgChats() {
  try { const v = await metaStore().get("tg", { type: "json" }); if (v?.chats?.length) return v.chats.map(String); } catch (_) {}
  return env("TELEGRAM_CHAT_ID").split(",").map(s => s.trim()).filter(Boolean);
}

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Контакт «WhatsApp: +996…» → ссылка на нужную соцсеть
export function contactLink(contact) {
  const raw = String(contact || "").trim();
  const m = raw.match(/^([^:]{2,20}):\s*(.+)$/);
  let kind = (m ? m[1] : "").toLowerCase(), v = (m ? m[2] : raw).trim();
  const dig = v.replace(/\D/g, "");
  const user = v.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?(instagram\.com|t\.me|telegram\.me|snapchat\.com\/add|facebook\.com|m\.facebook\.com|fb\.com)\/?/i, "").replace(/[/?#].*$/, "").replace(/^@/, "").trim();
  const isPhone = /^[+\d][\d\s()\-.]{6,}$/.test(v) && dig.length >= 7;
  if (/whatsapp/.test(kind)) return dig.length >= 7 ? { label: "WhatsApp", url: `https://wa.me/${dig}`, phone: "+" + dig } : null;
  if (/telegram/.test(kind)) return isPhone ? { label: "Telegram", url: `https://t.me/+${dig}`, phone: "+" + dig } : /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(user) ? { label: "Telegram @" + user, url: `https://t.me/${user}` } : null;
  if (/instagram/.test(kind)) return /^[A-Za-z0-9._]{1,30}$/.test(user) ? { label: "Instagram @" + user, url: `https://instagram.com/${user}` } : null;
  if (/snapchat/.test(kind)) return /^[A-Za-z0-9._-]{2,30}$/.test(user) ? { label: "Snapchat " + user, url: `https://www.snapchat.com/add/${user}` } : null;
  if (/facebook/.test(kind)) return /(facebook\.com|fb\.com|fb\.me)/i.test(v) ? { label: "Facebook", url: /^https?:/i.test(v) ? v : "https://" + v }
    : /^[A-Za-z0-9.]{3,50}$/.test(user) ? { label: "Facebook " + user, url: `https://facebook.com/${user}` }
    : { label: "Facebook: найти", url: `https://www.facebook.com/search/top?q=${encodeURIComponent(v)}` };
  if (isPhone) return { label: "WhatsApp", url: `https://wa.me/${dig}`, phone: "+" + dig };
  return null;
}

const site = () => (env("URL") || "").replace(/\/$/, "");

const TYPES = { tour: "тур", hotel: "отель", custom: "свой тур", merch: "мерч", gen: "общий вопрос" };

export function leadMessage(rec) {
  const d = rec.data || {}, isRev = rec.form === "review";
  const link = isRev ? null : contactLink(d.contact);
  const lines = isRev ? [
    `⭐ <b>Новый отзыв — ждёт модерации</b>`,
    `${"★".repeat(+d.rating || 0)}${"☆".repeat(5 - (+d.rating || 0))}  ${esc(d.name)}`,
    d.target ? `О чём: ${esc(d.target)}` : "",
    `«${esc(String(d.text || "").slice(0, 900))}»`
  ] : [
    `🆕 <b>Новая заявка${d.type ? " · " + esc(TYPES[d.type] || d.type) : ""}</b>`,
    String(d.summary || "").split("\n").filter(Boolean).slice(0, 14).map(esc).join("\n"),
    "",
    `👤 <b>${esc(d.name)}</b>`,
    `💬 ${esc(d.contact)}${link?.phone ? `\n📞 ${esc(link.phone)}` : ""}`,
    d.email ? `✉️ ${esc(d.email)}` : "",
    d.comment ? `📝 ${esc(String(d.comment).slice(0, 700))}` : ""
  ];
  lines.push("", `🌐 ${esc(String(d.lang || "").toUpperCase())} · ${new Date(rec.at).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" })} (Бишкек)`);
  const kb = [];
  if (link) kb.push([{ text: `Написать: ${link.label}`, url: link.url }]);
  if (d.email && /@/.test(d.email)) kb.push([{ text: "Ответить на e-mail", url: `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(d.email)}` }]);
  if (site()) kb.push([{ text: "Открыть в админке", url: `${site()}/#admin` }]);
  return { text: lines.filter(x => x !== "").join("\n").replace(/\n{3,}/g, "\n\n"), reply_markup: kb.length ? { inline_keyboard: kb } : undefined };
}

export async function tgSend(chats, msg, tries = 3) {
  let ok = 0, last = "";
  for (const chat_id of chats) {
    for (let i = 0; i < tries; i++) {
      const r = await api("sendMessage", { chat_id, parse_mode: "HTML", disable_web_page_preview: true, ...msg }).catch(e => ({ ok: false, description: String(e) }));
      if (r.ok) { ok++; break; }
      last = r.description || "error";
      if (r.error_code && r.error_code < 500 && r.error_code !== 429) break;     // неверный чат/токен — повтор не поможет
      await new Promise(res => setTimeout(res, Math.min(2000, (r.parameters?.retry_after || i + 1) * 700)));   // не дольше 2 с — функция не должна зависать
    }
  }
  if (!ok) throw new Error(last || "telegram");
  return ok;
}

// чаты, которые недавно писали боту — чтобы хозяин подключил свой одним нажатием
export async function tgFind() {
  const r = await api("getUpdates", { limit: 50, allowed_updates: ["message", "my_chat_member"] });
  if (!r.ok) throw new Error(r.description || "telegram");
  const seen = new Map();
  for (const u of r.result || []) {
    const c = u.message?.chat || u.my_chat_member?.chat;
    if (c) seen.set(String(c.id), { id: String(c.id), title: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id), type: c.type });
  }
  const me = await api("getMe");
  return { bot: me.ok ? me.result.username : "", chats: [...seen.values()] };
}
