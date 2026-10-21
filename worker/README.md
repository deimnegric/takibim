# Bildirim motoru (Cloudflare Worker) — n8n yerine

Her dakika Firestore'a bakar, hatırlatmaları ve yönetici uyarılarını Telegram'dan gönderir; ayrıca botun telefon kayıt akışını yürütür. Cloudflare ücretsiz planı yeterlidir (kart istemez, uyku modu yoktur).

## 1) Servis hesabı anahtarı (bir kez)
Firebase Console → Proje ayarları → **Hizmet hesapları** → "Yeni özel anahtar oluştur" → JSON iner.
Google Cloud Console → IAM → bu hesaba **Cloud Datastore User** rolünü verin (Firebase Admin SDK hesabında zaten olabilir; varsa gerekmez).
JSON'dan iki değer lazım: `client_email` ve `private_key`.

## 2) Worker'ı kurma (panelden, komut gerekmez)
1. dash.cloudflare.com → ücretsiz hesap → **Workers & Pages → Create → Create Worker** → ad: `takip-bildirim` → Deploy.
2. **Edit code** → içindeki her şeyi silin, `worker.js` içeriğini yapıştırın → Deploy.
3. **Settings → Variables and Secrets** (hepsini ekleyin):
   | Ad | Tür | Değer |
   |---|---|---|
   | FIREBASE_PROJECT | Text | takibim-cdb44 |
   | SITE_URL | Text | https://deimnegric.github.io/takibim |
   | SA_EMAIL | Secret | JSON'daki client_email |
   | SA_KEY | Secret | JSON'daki private_key (BEGIN/END satırları dahil, `\n` olarak kalabilir) |
   | BOT_TOKEN | Secret | BotFather token'ı |
   | WEBHOOK_SECRET | Secret | kendi uydurduğunuz uzun harf/rakam dizisi |
4. **Settings → Trigger Events → Add Cron Trigger** → `* * * * *` (her dakika).

## 3) Telegram'ı bağlama (bir kez)
Tarayıcıda açın: `https://takip-bildirim.<hesabınız>.workers.dev/kur?key=WEBHOOK_SECRET_DEĞERİ`
"Webhook kuruldu ✅" yazmalı. Sonra çalışan botu açıp `/start` yazar, **Numaramı paylaş** der.

## 4) Deneme
`https://takip-bildirim.<hesabınız>.workers.dev/test?key=WEBHOOK_SECRET_DEĞERİ` → `{"reminded":0,"alerted":0}` gibi JSON dönerse Firestore ve Google erişimi çalışıyor demektir. Hata varsa ekranda yazar.
Canlı log: Worker → **Logs** sekmesi.

Komut satırını tercih ederseniz: `cd worker && npx wrangler deploy` ve `npx wrangler secret put SA_KEY` vb.
