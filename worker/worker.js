// Cloudflare Worker: n8n yerine. Hem dakikalık hatırlatma (cron) hem Telegram telefon kaydı (webhook).
// Ücretsiz plan yeter: Cron Trigger her dakika, 100 bin istek/gün, uyku modu yok.
//
// Gerekli ayarlar (Settings → Variables and Secrets):
//   FIREBASE_PROJECT  (metin)  örn. takibim-cdb44
//   SITE_URL          (metin)  örn. https://deimnegric.github.io/takibim   (sonunda / yok)
//   SA_EMAIL          (secret) servis hesabı e-postası (client_email)
//   SA_KEY            (secret) servis hesabı private_key (-----BEGIN PRIVATE KEY----- ... dahil)
//   BOT_TOKEN         (secret) BotFather token'ı
//   WEBHOOK_SECRET    (secret) kendi belirlediğiniz uzun rastgele metin (harf/rakam/_/-)

const TZ = 'Europe/Istanbul';
const hm = ms => new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/* ---------- Google OAuth (servis hesabı) ---------- */
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(new TextEncoder().encode(s));

async function accessToken(env) {
  const ck = typeof caches !== 'undefined' ? caches.default : null, key = new Request('https://token.cache/sa');
  if (ck) { const hit = await ck.match(key); if (hit) return hit.text(); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({ iss: env.SA_EMAIL, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = env.SA_KEY.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64u(sig)}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google token alınamadı: ' + JSON.stringify(j));
  if (ck) await ck.put(key, new Response(j.access_token, { headers: { 'cache-control': 'max-age=3000' } }));
  return j.access_token;
}

/* ---------- Firestore REST ---------- */
const base = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
async function fs(env, path, method = 'GET', body) {
  const r = await fetch(base(env) + path, { method, headers: { authorization: 'Bearer ' + await accessToken(env), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Firestore ${method} ${path.split('?')[0]} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
const dec = v => { if (!v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue; if ('booleanValue' in v) return v.booleanValue; return null; };
const plain = d => { const o = { _id: d.name.split('/').pop() }; for (const k in d.fields || {}) o[k] = dec(d.fields[k]); return o; };
const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: v } });
const rng = (f, op, n) => ({ fieldFilter: { field: { fieldPath: f }, op, value: { integerValue: String(n) } } });
async function query(env, q) {
  const res = await fs(env, ':runQuery', 'POST', { structuredQuery: q });
  return res.filter(x => x.document).map(x => plain(x.document));
}
const patch = (env, path, fields) => fs(env, `${path}?${Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&')}`, 'PATCH',
  { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }])) });

/* ---------- Telegram ---------- */
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log('Telegram hata', method, JSON.stringify(j).slice(0, 200));
  return j.ok === true;
}

/* ---------- Dakikalık iş ---------- */
export async function tick(env, now = Date.now()) {
  const rows = await query(env, { from: [{ collectionId: 'attendance' }], limit: 300, where: { compositeFilter: { op: 'AND', filters: [
    eq('confirmed', { booleanValue: false }), eq('alertSent', { booleanValue: false }),
    rng('windowStart', 'LESS_THAN_OR_EQUAL', now), rng('windowStart', 'GREATER_THAN_OR_EQUAL', now - 12 * 3600e3)] } } });
  if (!rows.length) return { reminded: 0, alerted: 0 };

  const emps = new Map(), getEmp = async s => { if (!emps.has(s)) { try { emps.set(s, plain(await fs(env, `/employees/${encodeURIComponent(s)}`))); } catch { emps.set(s, null); } } return emps.get(s); };
  let reminded = 0, alerted = 0, admins = null;

  for (const d of rows) {
    const path = `/attendance/${encodeURIComponent(d._id)}`, tr = d.type === 'giris' ? 'girişinizi' : 'çıkışınızı';
    if (d.windowEnd <= now) {                       // süre doldu → yöneticilere uyarı
      admins ??= (await query(env, { from: [{ collectionId: 'employees' }], where: { compositeFilter: { op: 'AND', filters: [
        eq('isAdmin', { booleanValue: true }), eq('notify', { booleanValue: true })] } } })).filter(a => a.telegramChatId);
      const e = await getEmp(d.sicil);
      const txt = `⚠️ ${d.ad} (${d.sicil}) ${d.planned} vardiyası için kalbim ${d.type === 'giris' ? 'girişini' : 'çıkışını'} yapmadı. Lütfen kontrol ediniz.` +
        (e?.telegramChatId ? '' : '\n(Çalışanın Telegram botu bağlı değil, hatırlatma gidememiş olabilir.)');
      await patch(env, path, { alertSent: true, alertAt: now });   // önce işaretle: çift mesaj olmasın
      for (const a of admins) if (await tg(env, 'sendMessage', { chat_id: a.telegramChatId, text: txt })) alerted++;
      continue;
    }
    const step = (d.aralik || 5) * 60000, due = Math.floor((now - d.windowStart) / step) + 1;
    if ((d.lastReminderAt || 0) >= d.windowStart + (due - 1) * step) continue;   // bu aralıkta zaten gönderildi
    const e = await getEmp(d.sicil);
    if (!e?.telegramChatId || !e?.token) continue;
    await patch(env, path, { reminders: (d.reminders || 0) + 1, lastReminderAt: now });
    const link = `${env.SITE_URL}/onay.html?id=${encodeURIComponent(d._id)}&t=${e.token}`;
    const ok = await tg(env, 'sendMessage', { chat_id: e.telegramChatId,
      text: `⏰ ${d.ad}, lütfen kalbim ${tr} yapın.\n\nVardiya saatiniz: ${d.planned}\nİşlem süresi: ${hm(d.windowStart)} – ${hm(d.windowEnd)}\n\nİşlemi yaptıysanız aşağıdaki butonla onaylayın.`,
      reply_markup: { inline_keyboard: [[{ text: '✅ İşlemi yaptım, onayla', url: link }]] } });
    if (ok) reminded++;
  }
  return { reminded, alerted };
}

/* ---------- Telegram webhook: telefon paylaşımı ---------- */
async function webhook(env, upd) {
  const m = upd.message; if (!m) return;
  const chat = m.chat.id;
  const ask = text => tg(env, 'sendMessage', { chat_id: chat, text,
    reply_markup: { keyboard: [[{ text: '📱 Numaramı paylaş', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
  if (!m.contact) return ask('Merhaba! Giriş/çıkış hatırlatmalarını alabilmek için aşağıdaki butonla telefon numaranızı paylaşın.');
  if (m.contact.user_id && m.contact.user_id !== m.from?.id) return ask('Lütfen yalnızca kendi telefon numaranızı paylaşın.');
  const t10 = String(m.contact.phone_number).replace(/\D/g, '').slice(-10);
  const found = await query(env, { from: [{ collectionId: 'employees' }], limit: 1, where: eq('tel10', { stringValue: t10 }) });
  const done = text => tg(env, 'sendMessage', { chat_id: chat, text, reply_markup: { remove_keyboard: true } });
  if (!found.length) return done('Bu numara sistemde kayıtlı değil. Lütfen yöneticinizle iletişime geçin.');
  await patch(env, `/employees/${encodeURIComponent(found[0]._id)}`, { telegramChatId: String(chat) });
  return done(`✅ Teşekkürler ${found[0].ad}, kaydınız tamamlandı. Hatırlatmalar bu sohbete gelecek.`);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env).then(r => console.log('tick', JSON.stringify(r)))); },

  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await req.json().catch(() => null);
      if (upd) ctx.waitUntil(webhook(env, upd).catch(e => console.log('webhook hata', e.message)));
      return new Response('ok');
    }
    if (u.pathname === '/kur' && u.searchParams.get('key') === env.WEBHOOK_SECRET) {      // tek seferlik: webhook'u Telegram'a tanıt
      const ok = await tg(env, 'setWebhook', { url: `${u.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'] });
      return new Response(ok ? 'Webhook kuruldu ✅' : 'Webhook kurulamadı ❌ (BOT_TOKEN doğru mu? Loglara bakın)', { status: ok ? 200 : 500 });
    }
    if (u.pathname === '/test' && u.searchParams.get('key') === env.WEBHOOK_SECRET) {     // elle çalıştır: sonucu gösterir
      try { return Response.json(await tick(env)); } catch (e) { return new Response('Hata: ' + e.message, { status: 500 }); }
    }
    return new Response('Takip worker çalışıyor.');
  }
};
