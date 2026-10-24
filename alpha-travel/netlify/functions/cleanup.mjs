// Alpha Travel — ежедневная очистка: заявки и неопубликованные отзывы старше 12 месяцев удаляются
// (срок из политики конфиденциальности; принцип ограничения хранения — Цифровой кодекс КР, GDPR).
import { leadsStore, metaStore, INV, personKeys } from "../lib/util.mjs";

export const config = { schedule: "@daily" };

export default async () => {
  const st = leadsStore(), cutoff = Date.now() - 365 * 864e5; let n = 0;
  for (const prefix of ["b/", "r/"]) {
    const old = [];
    for await (const p of st.list({ prefix, paginate: true }))
      for (const b of p.blobs) if (INV - +b.key.split("/")[1] < cutoff) old.push(b.key);
    for (let i = 0; i < old.length; i += 20)
      await Promise.all(old.slice(i, i + 20).map(async k => {
        const r = await st.get(k, { type: "json" }).catch(() => null);
        await Promise.all([st.delete(k), ...(r ? personKeys(r).map(x => st.delete(x)) : [])]); n++;
      }));
  }
  // счётчики неудачных входов: удаляем только истёкшие (блокировка на 12 часов должна доживать до конца)
  const meta = metaStore(), now = Date.now();
  for await (const p of meta.list({ prefix: "tries/", paginate: true }))
    for (const b of p.blobs) {
      const r = await meta.get(b.key, { type: "json" }).catch(() => null);
      if (!r || (r.until ? r.until < now : now - (r.t || 0) > 12 * 3600e3)) await meta.delete(b.key);
    }
  // журнал действий админки (удаления по запросу клиента, блокировки входа) — 3 года
  for await (const p of meta.list({ prefix: "audit/", paginate: true }))
    for (const b of p.blobs) if (now - +b.key.split("/")[1] > 3 * 365 * 864e5) await meta.delete(b.key);
  console.log("cleanup removed", n);
  return new Response("ok");
};
