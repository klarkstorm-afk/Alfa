// Alpha Travel — API админки (/api/*). Netlify Function.
// Все секреты — только в Netlify → Site configuration → Environment variables:
//   ADMIN_PASSWORD      пароль входа в /#admin                                   (обязательно)
//   SESSION_SECRET      длинная случайная строка для подписи входа               (рекомендуется)
//   GITHUB_TOKEN        fine-grained токен: Contents Read and write на репозиторий (для «Опубликовать»)
//   GITHUB_REPO         "владелец/репозиторий", GITHUB_BRANCH — по умолчанию main
//   TELEGRAM_BOT_TOKEN  токен бота от @BotFather (уведомления о заявках)
//   NETLIFY_TOKEN       необязательно: только чтобы видеть СТАРЫЕ заявки из Netlify Forms
//   CRM_KEY             необязательно: ключ старого зашифрованного файла crm/leads.json (для переноса)
//   CRM_WEBHOOK_URL     необязательно: вебхук внешней CRM, если не хотите подключать её в админке
// Вход: 3 неверных пароля с одного адреса → блокировка входа на 12 часов (и сообщение в Telegram).
import crypto from "node:crypto";
import { env, json, leadsStore, metaStore, PREFIX, parseId, h16, digits, personKeys } from "../lib/util.mjs";
import { tgReady, tgChats, tgSend, tgFind } from "../lib/telegram.mjs";
import { crmCfg, crmPush, crmMark, publicCfg, buildCfg } from "../lib/crm.mjs";

export const config = { path: "/api/*" };

/* ---------- вход: пароль → подписанная HttpOnly-кука (пароль не хранится в браузере) ---------- */
const COOKIE = "at_s", DAYS = 7, MAX_TRIES = 3, LOCK_H = 12;
const skey = () => crypto.createHash("sha256").update("alpha-session:" + env("ADMIN_PASSWORD") + ":" + env("SESSION_SECRET")).digest();
const sign = b => crypto.createHmac("sha256", skey()).update(b).digest("base64url");
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
async function sver() { return (await metaStore().get("session-v", { type: "json" }).catch(() => null))?.v || 1; }
async function makeCookie() {
  const body = Buffer.from(JSON.stringify({ e: Date.now() + DAYS * 864e5, v: await sver() })).toString("base64url");
  return `${COOKIE}=${body}.${sign(body)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
async function authed(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)at_s=([^;]+)/);
  if (!m) return false;
  const [b, s] = m[1].split(".");
  if (!b || !s || !same(s, sign(b))) return false;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.e > Date.now() && p.v === await sver(); } catch { return false; }
}
// 3 неверных пароля подряд с одного адреса → вход с него закрыт на 12 часов.
// Счётчик хранится на сервере (Netlify Blobs), поэтому очистка браузера или новая вкладка его не сбрасывают.
async function login(req, context) {
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "?";
  const k = "tries/" + h16(ip), st = metaStore(), now = Date.now(), WIN = LOCK_H * 3600e3;
  let rec = (await st.get(k, { type: "json" }).catch(() => null)) || { n: 0, t: now };
  if (rec.until && now < rec.until) return json({ error: "locked", wait: Math.ceil((rec.until - now) / 1e3), until: new Date(rec.until).toISOString() }, 429);
  if (rec.until || now - rec.t > WIN) rec = { n: 0, t: now };          // блок истёк или старые ошибки — начинаем заново
  let pw = ""; try { pw = String((await req.json()).password || ""); } catch {}
  if (!pw || !same(pw, env("ADMIN_PASSWORD"))) {
    rec.n++;
    if (rec.n >= MAX_TRIES) {
      rec.until = now + WIN; await st.setJSON(k, rec);
      await st.setJSON(`audit/${now}`, { action: "login-locked", who: h16(ip), at: new Date(now).toISOString() }).catch(() => {});
      if (tgReady()) await tgChats().then(c => c.length && tgSend(c, { text: `🔒 Alpha Travel: ${MAX_TRIES} неверных пароля подряд — вход в админку с этого адреса закрыт на ${LOCK_H} ч.\nЕсли это были не вы — смените ADMIN_PASSWORD в Netlify (Trigger deploy): все старые входы сразу перестанут действовать.` }, 1)).catch(() => {});
      return json({ error: "locked", wait: LOCK_H * 3600, until: new Date(rec.until).toISOString() }, 429);
    }
    await st.setJSON(k, rec);
    return json({ error: "bad", left: MAX_TRIES - rec.n }, 401);
  }
  await st.delete(k).catch(() => {});
  return json(info(), 200, { "set-cookie": await makeCookie() });
}
const info = () => ({ ok: true, github: !!(env("GITHUB_TOKEN") && env("GITHUB_REPO")), netlify: !!env("NETLIFY_TOKEN"), telegram: tgReady() });

/* ---------- внешняя CRM: настройка, проверка, повторная отправка ---------- */
async function crmRoute(req, m) {
  const meta = metaStore();
  if (m === "GET") return json({ cfg: publicCfg(await crmCfg()) });
  const b = await req.json().catch(() => ({}));
  if (b.action === "save") {
    const prev = await meta.get("crm", { type: "json" }).catch(() => null);
    let c; try { c = buildCfg(b, prev); } catch (e) { return json({ error: e.message }, 400); }
    await meta.setJSON("crm", c);
    await meta.setJSON(`audit/${Date.now()}`, { action: "crm-save", kind: c.kind, at: c.at }).catch(() => {});
    return json({ ok: true, cfg: publicCfg(c) });
  }
  if (b.action === "off") {
    await meta.setJSON("crm", { on: false, at: new Date().toISOString() });
    return json({ ok: true, cfg: publicCfg(await crmCfg()) });
  }
  if (b.action === "test") {
    const c = await crmCfg();
    if (!c) return json({ error: "Сначала подключите CRM" }, 400);
    const rec = { id: "b-test-" + Date.now().toString(36), form: "booking", at: new Date().toISOString(), test: true,
      data: { type: "tour", name: "Тест Alpha Travel", contact: "WhatsApp: +996 700 000 000", email: "", comment: "Проверка связи сайта с CRM — эту заявку можно удалить.", summary: "Тур: тестовая заявка", lang: "ru" } };
    try { const r = await crmPush(rec, c); await crmMark(true); return json({ ok: true, id: r.id || "" }); }
    catch (e) { await crmMark(false, e.message); return json({ error: "CRM не приняла заявку: " + String(e.message || e).slice(0, 220) }, 502); }
  }
  if (b.action === "resend") {
    const c = await crmCfg();
    if (!c) return json({ error: "Сначала подключите CRM" }, 400);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 20), st = leadsStore(), out = {};
    for (const id of ids) {
      const pid = parseId(id); if (!pid) continue;
      const rec = await st.get(pid.key, { type: "json" }).catch(() => null); if (!rec) continue;
      try { const r = await crmPush({ ...rec, form: rec.form || pid.form }, c); rec.cx = r.st; rec.cxid = r.id || ""; rec.cxerr = ""; }
      catch (e) { rec.cx = "failed"; rec.cxerr = String(e.message || e).slice(0, 200); }
      await st.setJSON(pid.key, rec); out[id] = { cx: rec.cx, cxid: rec.cxid || "", cxerr: rec.cxerr || "" };
    }
    const ok = Object.values(out).filter(x => x.cx === "sent").length;
    await crmMark(ok > 0 || !ids.length, ok ? "" : (Object.values(out)[0] || {}).cxerr);
    return json({ ok: true, items: out, sent: ok });
  }
  return json({ error: "bad action" }, 400);
}

/* ---------- GitHub (сохранение контента сайта) ---------- */
async function gh(path, opt = {}) {
  const repo = env("GITHUB_REPO"), token = env("GITHUB_TOKEN");
  if (!repo || !token) throw new Error("Не заданы GITHUB_REPO или GITHUB_TOKEN в настройках Netlify");
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...opt, headers: {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "alpha-travel-admin", "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}
const SAFE_PATH = /^(data\/site\.json|img\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)|bg\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp))$/;

/* ---------- старые заявки из Netlify Forms (только чтение/удаление, если задан NETLIFY_TOKEN) ---------- */
async function nf(path, opt = {}) {
  const r = await fetch(`https://api.netlify.com/api/v1${path}`, { ...opt, headers: { Authorization: `Bearer ${env("NETLIFY_TOKEN")}`, "User-Agent": "alpha-travel-admin" } });
  if (!r.ok) throw new Error(`Netlify ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function legacy(form, context) {
  if (!env("NETLIFY_TOKEN")) return [];
  try {
    const siteId = context?.site?.id || env("SITE_ID");
    const forms = await nf(`/sites/${siteId}/forms`), f = (forms || []).find(x => x.name === form);
    if (!f) return [];
    const subs = await nf(`/forms/${f.id}/submissions?per_page=100`);
    const crm = await crmMap((subs || []).map(s => s.id));
    return (subs || []).map(s => ({ id: s.id, created_at: s.created_at, data: s.data || {}, crm: crm[s.id] || null, legacy: true }));
  } catch (e) { console.error("legacy forms", String(e)); return []; }
}
async function crmMap(ids) {
  const st = leadsStore(), out = {};
  await Promise.all(ids.map(async id => { const v = await st.get("crm/" + id, { type: "json" }).catch(() => null); if (v) out[id] = v; }));
  return out;
}

/* ---------- заявки и отзывы (Netlify Blobs) ---------- */
async function page(form, pg, per = 100) {
  const st = leadsStore(), off = (pg - 1) * per, keys = []; let seen = 0, more = false;
  for await (const p of st.list({ prefix: PREFIX[form], paginate: true })) {
    for (const b of p.blobs) { if (seen++ < off) continue; if (keys.length < per) keys.push(b.key); else { more = true; break; } }
    if (more) break;
  }
  const items = [];
  for (let i = 0; i < keys.length; i += 25)
    items.push(...(await Promise.all(keys.slice(i, i + 25).map(k => st.get(k, { type: "json" })))).filter(Boolean));
  return { items: items.map(r => ({ id: r.id, created_at: r.at, data: r.data, crm: { st: r.st, note: r.note, mgr: r.mgr, rem: r.rem }, tg: r.tg || "", cx: r.cx || "", cxid: r.cxid || "", cxerr: r.cxerr || "" })), more };
}
const CRM_ST = new Set(["new", "work", "done"]);
function cleanPatch(p) {
  const o = {};
  if (typeof p.st === "string" && CRM_ST.has(p.st)) o.st = p.st;
  if (typeof p.note === "string") o.note = p.note.slice(0, 3000);
  if (typeof p.mgr === "string") o.mgr = p.mgr.slice(0, 80);
  if (typeof p.rem === "string" && (p.rem === "" || /^\d{4}-\d{2}-\d{2}$/.test(p.rem))) o.rem = p.rem;
  return o;
}
async function dropRec(key) {
  const st = leadsStore(), r = await st.get(key, { type: "json" }).catch(() => null);
  await Promise.all([st.delete(key), ...(r ? personKeys(r).map(k => st.delete(k)) : [])]);
}

// одноразовый перенос старого зашифрованного crm/leads.json (лежал в публичном репозитории)
async function migrateCrm() {
  const meta = metaStore();
  if (await meta.get("crm-migrated").catch(() => null)) return;
  try {
    const repo = env("GITHUB_REPO"), branch = env("GITHUB_BRANCH") || "main";
    if (repo && env("GITHUB_TOKEN")) {
      const f = await gh(`/contents/crm/leads.json?ref=${encodeURIComponent(branch)}`).catch(() => null);
      if (f?.content) {
        const o = JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
        const key = crypto.createHash("sha256").update("alpha-crm:" + (env("CRM_KEY") || env("ADMIN_PASSWORD"))).digest();
        const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64")); d.setAuthTag(Buffer.from(o.tag, "base64"));
        const state = JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8"));
        const st = leadsStore();
        await Promise.all(Object.entries(state.leads || {}).map(([id, v]) => st.setJSON("crm/" + id, cleanPatch(v))));
      }
    }
  } catch (e) { console.error("crm migrate", String(e)); }
  await meta.set("crm-migrated", new Date().toISOString());
}

async function person(req, url) {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase().replace(/^@/, "");
  if (q.length < 3) return json({ error: "Введите телефон, @логин или e-mail" }, 400);
  const st = leadsStore(), hk = h16(digits(q).length >= 7 && !q.includes("@") ? digits(q) : q);
  const { blobs } = await st.list({ prefix: `idx/${hk}/` });
  const keys = (await Promise.all(blobs.map(b => st.get(b.key)))).map(v => typeof v === "string" ? v : v ? Buffer.from(v).toString() : "").filter(Boolean);
  const recs = (await Promise.all(keys.map(k => st.get(k, { type: "json" }).then(r => r && { k, r }).catch(() => null)))).filter(Boolean);
  if (req.method === "GET") return json({ items: recs.map(x => x.r) });
  if (req.method === "DELETE") {
    for (const x of recs) await dropRec(x.k);
    await metaStore().setJSON(`audit/${Date.now()}`, { action: "erase", n: recs.length, who: hk, at: new Date().toISOString() });
    return json({ ok: true, deleted: recs.length });
  }
  return json({ error: "method" }, 405);
}

/* ---------- маршруты ---------- */
export default async (req, context) => {
  if (!env("ADMIN_PASSWORD")) return json({ error: "Не задан ADMIN_PASSWORD в настройках Netlify" }, 503);
  const url = new URL(req.url), m = req.method;
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  // защита от подделки запросов с чужих сайтов: все изменения — только с заголовком админки
  if (m !== "GET" && req.headers.get("x-at") !== "1") return json({ error: "forbidden" }, 403);
  if (route === "login" && m === "POST") return login(req, context);
  if (!(await authed(req))) return json({ error: "unauthorized" }, 401);

  try {
    if (route === "me") return json(info());
    if (route === "logout") {
      let all = false; try { all = !!(await req.json()).all; } catch {}
      if (all) await metaStore().setJSON("session-v", { v: (await sver()) + 1 });
      return json({ ok: true }, 200, { "set-cookie": clearCookie });
    }

    if (route === "blob" && m === "POST") {
      const { content } = await req.json();
      if (typeof content !== "string" || !content) return json({ error: "empty" }, 400);
      if (content.length > 5_500_000) return json({ error: "Файл слишком большой" }, 413);
      const b = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
      return json({ sha: b.sha });
    }
    if (route === "commit" && m === "POST") {
      const { files, message } = await req.json();
      const branch = env("GITHUB_BRANCH") || "main";
      const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`), head = ref.object.sha;
      const commit = await gh(`/git/commits/${head}`), tree = [];
      for (const [p, v] of Object.entries(files || {})) {
        if (!SAFE_PATH.test(p)) continue;
        if (v === null) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
        else if (v && typeof v.sha === "string") tree.push({ path: p, mode: "100644", type: "blob", sha: v.sha });
        else if (v && typeof v.text === "string") { if (p === "data/site.json") JSON.parse(v.text); tree.push({ path: p, mode: "100644", type: "blob", content: v.text }); }
      }
      if (!tree.length) return json({ error: "Нечего сохранять" }, 400);
      let nt;
      try { nt = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) }); }
      catch (e) { // удаление файла, которого уже нет, ломает коммит — повторяем без удалений
        const t2 = tree.filter(x => x.sha !== null); if (!t2.length) throw e;
        nt = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree: t2 }) });
      }
      const nc = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message: String(message || "Админка: обновление сайта").slice(0, 120), tree: nt.sha, parents: [head] }) });
      await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: nc.sha }) });
      return json({ ok: true, commit: nc.sha });
    }

    if (route === "inbox" && m === "GET") {
      const form = url.searchParams.get("form");
      if (!PREFIX[form]) return json({ error: "bad form" }, 400);
      const pg = Math.max(1, Math.min(1000, +url.searchParams.get("page") || 1));
      const r = await page(form, pg);
      if (pg === 1) { await migrateCrm(); r.items = r.items.concat(await legacy(form, context)); }
      return json(r);
    }
    if (route === "submission" && m === "DELETE") {
      const id = url.searchParams.get("id") || "", pid = parseId(id);
      if (pid) { await dropRec(pid.key); return json({ ok: true }); }
      if (!/^[A-Za-z0-9]+$/.test(id) || !env("NETLIFY_TOKEN")) return json({ error: "bad id" }, 400);
      await nf(`/submissions/${id}`, { method: "DELETE" }); await leadsStore().delete("crm/" + id).catch(() => {});
      return json({ ok: true });
    }

    // CRM: статус, заметка, менеджер, напоминание — хранятся на сервере (не в публичном репозитории)
    if (route === "crm" && m === "GET") return json({ leads: {} });   // состояние приходит вместе с заявками
    if (route === "crm" && m === "POST") {
      const body = await req.json(), ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [], st = leadsStore(), out = {};
      for (const op of ops) {
        const id = String(op?.id || "");
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
        const pid = parseId(id);
        if (op.patch === null) { if (!pid) await st.delete("crm/" + id).catch(() => {}); continue; }
        const p = cleanPatch(op.patch || {});
        if (pid) {
          const r = await st.get(pid.key, { type: "json" });
          if (!r) continue;
          Object.assign(r, p, { upd: Date.now() }); await st.setJSON(pid.key, r);
          out[id] = { st: r.st, note: r.note, mgr: r.mgr, rem: r.rem };
        } else {
          const cur = (await st.get("crm/" + id, { type: "json" }).catch(() => null)) || {};
          const nx = Object.assign(cur, p, { upd: Date.now() }); await st.setJSON("crm/" + id, nx); out[id] = nx;
        }
      }
      return json({ ok: true, leads: out });
    }

    if (route === "person") return person(req, url);
    if (route === "crm-link") return crmRoute(req, m);

    // Telegram: статус, поиск чата, сохранение, тест
    if (route === "tg") {
      if (m === "GET") return json({ token: tgReady(), chats: await tgChats() });
      const b = await req.json().catch(() => ({}));
      if (!tgReady()) return json({ error: "Нет TELEGRAM_BOT_TOKEN в настройках Netlify (или он неверный)" }, 400);
      if (b.action === "find") return json(await tgFind());
      if (b.action === "save") {
        const chats = [...new Set((Array.isArray(b.chats) ? b.chats : []).map(String).filter(c => /^-?\d{3,20}$/.test(c)))].slice(0, 5);
        await metaStore().setJSON("tg", { chats, at: new Date().toISOString() });
        return json({ ok: true, chats });
      }
      if (b.action === "test") {
        const chats = await tgChats();
        if (!chats.length) return json({ error: "Сначала подключите чат" }, 400);
        await tgSend(chats, { text: "✅ Alpha Travel: уведомления о заявках работают.\nСюда будут приходить новые брони и отзывы со ссылкой на контакт клиента." }, 1);
        return json({ ok: true });
      }
      return json({ error: "bad action" }, 400);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("api", route, String(e));
    return json({ error: String(e?.message || e).slice(0, 300) }, 500);
  }
};
