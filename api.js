// Alpha Travel — admin API (Netlify Function).
// Saves admin changes to GitHub (Netlify then redeploys) and reads form submissions
// (bookings, reviews) from Netlify Forms. All secrets live in Netlify environment variables:
//   ADMIN_PASSWORD  — password for /#admin
//   GITHUB_TOKEN    — fine-grained token with "Contents: Read and write" on the repo
//   GITHUB_REPO     — "owner/repo", e.g. "yourname/alpha-travel"
//   GITHUB_BRANCH   — optional, default "main"
//   NETLIFY_TOKEN   — Netlify personal access token (to read and delete form submissions)
//   SITE_DIR        — optional, default "" (repo root is published)
//   CRM_KEY         — optional; key for the encrypted CRM file (statuses, notes). Default: ADMIN_PASSWORD
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const env = (k) => {
  try { const v = globalThis.Netlify?.env?.get?.(k); if (v !== undefined && v !== null) return v; } catch (_) {}
  return process.env[k];
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function authed(req) {
  const given = req.headers.get("x-admin-key") || "";
  const want = env("ADMIN_PASSWORD") || "";
  if (!want || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

async function gh(path, opt = {}) {
  const repo = env("GITHUB_REPO"), token = env("GITHUB_TOKEN");
  if (!repo || !token) throw new Error("Не заданы GITHUB_REPO или GITHUB_TOKEN в настройках Netlify");
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "alpha-travel-admin", "Content-Type": "application/json",
    },
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    throw new Error(`GitHub ${r.status}: ${t}`);
  }
  return r.status === 204 ? null : r.json();
}

async function nf(path, opt = {}) {
  const token = env("NETLIFY_TOKEN");
  if (!token) throw new Error("Не задан NETLIFY_TOKEN в настройках Netlify");
  const r = await fetch(`https://api.netlify.com/api/v1${path}`, {
    ...opt, headers: { Authorization: `Bearer ${token}`, "User-Agent": "alpha-travel-admin" },
  });
  if (!r.ok) throw new Error(`Netlify ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// ---------- CRM: statuses, notes, manager, reminders for bookings ----------
// Stored in the repo as crm/leads.json, ENCRYPTED (AES-256-GCM), so client data is safe even in a public repo.
// Commits carry "[skip netlify]", so saving a status does not redeploy the site.
const CRM_PATH = "crm/leads.json";
const ST = new Set(["new", "work", "done"]);
function crmKey() {
  const k = env("CRM_KEY") || env("ADMIN_PASSWORD") || "";
  return crypto.createHash("sha256").update("alpha-crm:" + k).digest();
}
function crmEnc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", crmKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}
function crmDec(text) {
  const o = JSON.parse(text);
  const d = crypto.createDecipheriv("aes-256-gcm", crmKey(), Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8"));
}
function ghHeaders() {
  return { Authorization: `Bearer ${env("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "alpha-travel-admin", "Content-Type": "application/json" };
}
async function ghFileGet(path) {
  const repo = env("GITHUB_REPO"), branch = env("GITHUB_BRANCH") || "main";
  if (!repo || !env("GITHUB_TOKEN")) throw new Error("Не заданы GITHUB_REPO или GITHUB_TOKEN в настройках Netlify");
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { sha: j.sha, text: Buffer.from(j.content || "", "base64").toString("utf8") };
}
async function ghFilePut(path, text, sha, message) {
  const repo = env("GITHUB_REPO"), branch = env("GITHUB_BRANCH") || "main";
  return fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT", headers: ghHeaders(),
    body: JSON.stringify({ message, branch, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}) }),
  });
}
function cleanPatch(p) {
  const o = {};
  if (typeof p.st === "string" && ST.has(p.st)) o.st = p.st;
  if (typeof p.note === "string") o.note = p.note.slice(0, 3000);
  if (typeof p.mgr === "string") o.mgr = p.mgr.slice(0, 80);
  if (typeof p.rem === "string" && (p.rem === "" || /^\d{4}-\d{2}-\d{2}$/.test(p.rem))) o.rem = p.rem;
  return o;
}

const SAFE_PATH = /^(data\/site\.json|img\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)|bg\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp))$/;

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  if (!authed(req)) return json({ error: "unauthorized" }, 401);

  try {
    if (route === "login") {
      return json({ ok: true, github: !!(env("GITHUB_TOKEN") && env("GITHUB_REPO")), netlify: !!env("NETLIFY_TOKEN") });
    }

    // 1) upload one image as a git blob (keeps each request small)
    if (route === "blob" && req.method === "POST") {
      const { content } = await req.json();
      if (typeof content !== "string" || !content) return json({ error: "empty" }, 400);
      if (content.length > 5_500_000) return json({ error: "Файл слишком большой" }, 413);
      const b = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
      return json({ sha: b.sha });
    }

    // 2) one commit with data/site.json + new images + removed images
    if (route === "commit" && req.method === "POST") {
      const { files, message } = await req.json();
      const dir = String(env("SITE_DIR") ?? "").replace(/^\/+|\/+$/g, "");
      const branch = env("GITHUB_BRANCH") || "main";
      const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
      const head = ref.object.sha;
      const commit = await gh(`/git/commits/${head}`);
      const existing = new Set();
      const full = await gh(`/git/trees/${commit.tree.sha}?recursive=1`);
      (full.tree || []).forEach((e) => existing.add(e.path));
      const tree = [];
      for (const [p, v] of Object.entries(files || {})) {
        if (!SAFE_PATH.test(p)) continue;
        const path = dir ? `${dir}/${p}` : p;
        if (v === null) { if (existing.has(path)) tree.push({ path, mode: "100644", type: "blob", sha: null }); }
        else if (v && typeof v.sha === "string") tree.push({ path, mode: "100644", type: "blob", sha: v.sha });
        else if (v && typeof v.text === "string") {
          if (p === "data/site.json") JSON.parse(v.text); // refuse to commit broken JSON
          tree.push({ path, mode: "100644", type: "blob", content: v.text });
        }
      }
      if (!tree.length) return json({ error: "Нечего сохранять" }, 400);
      const nt = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
      const nc = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message: message || "Админка: обновление сайта", tree: nt.sha, parents: [head] }) });
      await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: nc.sha }) });
      return json({ ok: true, commit: nc.sha });
    }

    // CRM: read (decrypted) state
    if (route === "crm" && req.method === "GET") {
      const f = await ghFileGet(CRM_PATH);
      if (!f) return json({ leads: {} });
      try { const o = crmDec(f.text); return json({ leads: o.leads || {} }); }
      catch (_) { return json({ leads: {}, warn: "key" }); }
    }

    // CRM: apply changes [{ id, patch | null }] — merged on the server, retried on conflicts
    if (route === "crm" && req.method === "POST") {
      const body = await req.json();
      const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const f = await ghFileGet(CRM_PATH);
        let state = { leads: {} };
        if (f) {
          try { state = crmDec(f.text); if (!state.leads) state.leads = {}; }
          catch (_) { if (!body.reset) return json({ error: "Файл CRM зашифрован другим паролем (пароль админки менялся). Нажмите «Начать CRM заново»." }, 409); }
        }
        for (const op of ops) {
          const id = String(op && op.id || "");
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
          if (op.patch === null) { delete state.leads[id]; continue; }
          const p = cleanPatch(op.patch || {});
          state.leads[id] = Object.assign({}, state.leads[id] || {}, p, { upd: Date.now() });
        }
        const ids = Object.keys(state.leads);
        if (ids.length > 3000) ids.sort((a, b) => (state.leads[a].upd || 0) - (state.leads[b].upd || 0)).slice(0, ids.length - 3000).forEach((k) => delete state.leads[k]);
        const r = await ghFilePut(CRM_PATH, crmEnc(state), f && f.sha, "CRM: заявки [skip netlify]");
        if (r.ok) return json({ ok: true, leads: state.leads });
        if (r.status === 409 || r.status === 422) continue; // someone saved at the same time — re-read and merge again
        throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      return json({ error: "Не удалось сохранить: слишком много одновременных изменений" }, 409);
    }

    // 3) read submissions of a Netlify form ("booking" or "review")
    if (route === "inbox" && req.method === "GET") {
      const form = url.searchParams.get("form");
      if (!["booking", "review"].includes(form)) return json({ error: "bad form" }, 400);
      const siteId = context?.site?.id || env("SITE_ID") || env("NETLIFY_SITE_ID");
      if (!siteId) return json({ error: "Не найден SITE_ID" }, 500);
      const forms = await nf(`/sites/${siteId}/forms`);
      const f = (forms || []).find((x) => x.name === form);
      if (!f) return json({ items: [] });
      const subs = await nf(`/forms/${f.id}/submissions?per_page=100`);
      return json({ items: (subs || []).map((s) => ({ id: s.id, created_at: s.created_at, data: s.data || {} })) });
    }

    // 4) delete a submission (rejected review, handled or deleted booking)
    if (route === "submission" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id || !/^[A-Za-z0-9]+$/.test(id)) return json({ error: "bad id" }, 400);
      await nf(`/submissions/${id}`, { method: "DELETE" });
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
};
