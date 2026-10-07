import json, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'n8n')
os.makedirs(OUT, exist_ok=True)
FS = "https://firestore.googleapis.com/v1/projects/{{ $('Sorgu Hazırla').first().json.project }}/databases/(default)/documents"
GCRED = {"googleApi": {"id": "", "name": "Google Service Account (Firestore)"}}
TCRED = {"telegramApi": {"id": "", "name": "Telegram Bot"}}

def code(name, js, pos):
    return {"parameters": {"jsCode": js}, "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2, "position": pos}

def http(name, method, url, body, pos, cont=False):
    p = {"method": method, "url": url, "authentication": "predefinedCredentialType", "nodeCredentialType": "googleApi", "options": {}}
    if body:
        p.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
    n = {"parameters": p, "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos, "credentials": GCRED}
    if cont:
        n["onError"] = "continueRegularOutput"
    return n

def ifnode(name, left, right, pos):
    return {"parameters": {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"},
            "conditions": [{"id": name.replace(' ', '-'), "leftValue": left, "rightValue": right,
                            "operator": {"type": "string", "operation": "equals"}}], "combinator": "and"}, "options": {}},
            "name": name, "type": "n8n-nodes-base.if", "typeVersion": 2, "position": pos}

def conn(pairs):
    c = {}
    for a, outs in pairs.items():
        c[a] = {"main": [[{"node": t, "type": "main", "index": 0} for t in o] for o in outs]}
    return c

DEC = """const dec = v => { if (!v) return null; if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue; if ('booleanValue' in v) return v.booleanValue; return null; };
const docs = items => items.map(i => i.json.document).filter(Boolean).map(d => { const f = {}; for (const k in d.fields || {}) f[k] = dec(d.fields[k]); f._id = d.name.split('/').pop(); return f; });
const hm = ms => new Date(ms + 3 * 3600e3).toISOString().substr(11, 5);
"""

# ---------------- Akış 1: Hatırlatma + yönetici uyarısı ----------------
q = code("Sorgu Hazırla", """// >>> BURAYI DÜZENLEYİN <<<
const PROJECT = 'PROJE_ID';                       // Firebase proje kimliği
const SITE_URL = 'https://PROJE_ID.web.app';      // Sitenizin adresi (sonunda / olmasın)
const now = Date.now();
const f = (field, op, value) => ({ fieldFilter: { field: { fieldPath: field }, op, value } });
const body = { structuredQuery: { from: [{ collectionId: 'attendance' }], limit: 300,
  where: { compositeFilter: { op: 'AND', filters: [
    f('confirmed', 'EQUAL', { booleanValue: false }),
    f('alertSent', 'EQUAL', { booleanValue: false }),
    f('windowStart', 'LESS_THAN_OR_EQUAL', { integerValue: String(now) }),
    f('windowStart', 'GREATER_THAN_OR_EQUAL', { integerValue: String(now - 12 * 3600e3) }) ] } } } };
return [{ json: { project: PROJECT, siteUrl: SITE_URL, body } }];""", [220, 300])

karar = code("Karar", DEC + """const now = Date.now(); const out = [];
for (const d of docs($input.all())) {
  if (d.windowEnd <= now) { out.push({ json: { action: 'alert', attId: d._id, sicil: d.sicil, ad: d.ad, type: d.type, planned: d.planned } }); continue; }
  const step = (d.aralik || 5) * 60000;
  const due = Math.floor((now - d.windowStart) / step) + 1;
  if ((d.lastReminderAt || 0) < d.windowStart + (due - 1) * step) {
    out.push({ json: { action: 'remind', attId: d._id, sicil: d.sicil, ad: d.ad, type: d.type, planned: d.planned,
      windowStart: d.windowStart, windowEnd: d.windowEnd, reminders: (d.reminders || 0) + 1 } });
  }
}
return out;""", [660, 300])

mesaj = code("Mesaj Hazırla", DEC + """const base = $('Karar').all(); const site = $('Sorgu Hazırla').first().json.siteUrl; const out = [];
$input.all().forEach((it, i) => {
  const a = base[i].json; const f = it.json.fields || {};
  const chat = f.telegramChatId?.stringValue, token = f.token?.stringValue;
  if (!chat || !token) return;
  const tr = a.type === 'giris' ? 'girişinizi' : 'çıkışınızı';
  const link = `${site}/onay.html?id=${encodeURIComponent(a.attId)}&t=${token}`;
  const text = `⏰ ${a.ad}, lütfen kalbim ${tr} yapın.\\n\\nVardiya saatiniz: ${a.planned}\\nİşlem süresi: ${hm(a.windowStart)} – ${hm(a.windowEnd)}\\n\\nİşlemi yaptıysanız aşağıdaki butonla onaylayın:\\n${link}`;
  out.push({ json: { chatId: chat, text, link, attId: a.attId, reminders: a.reminders } });
});
return out;""", [1100, 160])

tg_r = {"parameters": {"chatId": "={{ $json.chatId }}", "text": "={{ $json.text }}", "replyMarkup": "inlineKeyboard",
        "inlineKeyboard": {"rows": [{"row": {"buttons": [{"text": "✅ İşlemi yaptım, onayla", "additionalFields": {"url": "={{ $json.link }}"}}]}}]},
        "additionalFields": {"appendAttribution": False}},
        "name": "Telegram Hatırlat", "type": "n8n-nodes-base.telegram", "typeVersion": 1.2, "position": [1320, 160], "credentials": TCRED}

patch_r = http("Sayacı Güncelle", "PATCH",
    "=" + FS + "/attendance/{{ $('Mesaj Hazırla').item.json.attId }}?updateMask.fieldPaths=reminders&updateMask.fieldPaths=lastReminderAt",
    "={{ JSON.stringify({ fields: { reminders: { integerValue: String($('Mesaj Hazırla').item.json.reminders) }, lastReminderAt: { integerValue: String(Date.now()) } } }) }}",
    [1540, 160])

toplu = code("Alert Toplu", "return [{ json: { alerts: $input.all().map(i => i.json) } }];", [880, 440])
adm_q = http("Yöneticiler", "POST", "=" + FS + ":runQuery",
    "={{ JSON.stringify({ structuredQuery: { from: [{ collectionId: 'employees' }], where: { compositeFilter: { op: 'AND', filters: [" +
    "{ fieldFilter: { field: { fieldPath: 'isAdmin' }, op: 'EQUAL', value: { booleanValue: true } } }," +
    "{ fieldFilter: { field: { fieldPath: 'notify' }, op: 'EQUAL', value: { booleanValue: true } } }] } } } }) }}", [1100, 440])
alert_msg = code("Alert Mesajları", DEC + """const alerts = $('Alert Toplu').first().json.alerts;
const admins = docs($input.all()).filter(a => a.telegramChatId); const out = [];
for (const a of alerts) for (const adm of admins) {
  const tr = a.type === 'giris' ? 'girişini' : 'çıkışını';
  out.push({ json: { chatId: adm.telegramChatId, attId: a.attId,
    text: `⚠️ ${a.ad} (${a.sicil}) ${a.planned} vardiyası için kalbim ${tr} yapmadı. Lütfen kontrol ediniz.` } });
}
return out;""", [1320, 440])
tg_a = {"parameters": {"chatId": "={{ $json.chatId }}", "text": "={{ $json.text }}", "additionalFields": {"appendAttribution": False}},
        "name": "Telegram Yönetici", "type": "n8n-nodes-base.telegram", "typeVersion": 1.2, "position": [1540, 440], "credentials": TCRED}
patch_a = http("Alert İşaretle", "PATCH",
    "=" + FS + "/attendance/{{ $('Alert Mesajları').item.json.attId }}?updateMask.fieldPaths=alertSent&updateMask.fieldPaths=alertAt",
    "={{ JSON.stringify({ fields: { alertSent: { booleanValue: true }, alertAt: { integerValue: String(Date.now()) } } }) }}", [1760, 440])

wf1 = {
    "name": "Giriş-Çıkış Hatırlatma ve Yönetici Uyarısı",
    "nodes": [
        {"parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, "name": "Her Dakika",
         "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [0, 300]},
        q,
        http("Bekleyenler", "POST", "=" + FS + ":runQuery", "={{ JSON.stringify($('Sorgu Hazırla').first().json.body) }}", [440, 300]),
        karar,
        ifnode("Hatırlatma mı?", "={{ $json.action }}", "remind", [880, 300]),
        http("Çalışan Bilgisi", "GET", "=" + FS + "/employees/{{ $json.sicil }}", None, [880, 160], cont=True),
        mesaj, tg_r, patch_r, toplu, adm_q, alert_msg, tg_a, patch_a,
    ],
    "connections": conn({
        "Her Dakika": [["Sorgu Hazırla"]],
        "Sorgu Hazırla": [["Bekleyenler"]],
        "Bekleyenler": [["Karar"]],
        "Karar": [["Hatırlatma mı?"]],
        "Hatırlatma mı?": [["Çalışan Bilgisi"], ["Alert Toplu"]],
        "Çalışan Bilgisi": [["Mesaj Hazırla"]],
        "Mesaj Hazırla": [["Telegram Hatırlat"]],
        "Telegram Hatırlat": [["Sayacı Güncelle"]],
        "Alert Toplu": [["Yöneticiler"]],
        "Yöneticiler": [["Alert Mesajları"]],
        "Alert Mesajları": [["Telegram Yönetici"]],
        "Telegram Yönetici": [["Alert İşaretle"]],
    }),
    "settings": {"executionOrder": "v1", "timezone": "Europe/Istanbul"},
}
# Çalışan Bilgisi düğümü yatay konum düzeltmesi (okunabilirlik)
for n in wf1["nodes"]:
    if n["name"] == "Çalışan Bilgisi": n["position"] = [880, 160]
    if n["name"] == "Hatırlatma mı?": n["position"] = [880, 300]
    if n["name"] == "Mesaj Hazırla": n["position"] = [1100, 160]

# ---------------- Akış 2: Telegram telefon kaydı ----------------
TG = "https://api.telegram.org/bot{{ $('Analiz').first().json.botToken }}/sendMessage"
FS2 = "https://firestore.googleapis.com/v1/projects/{{ $('Analiz').first().json.project }}/databases/(default)/documents"

analiz = code("Analiz", """// >>> BURAYI DÜZENLEYİN <<<
const BOT_TOKEN = 'BOTFATHER_TOKEN';   // BotFather'dan aldığınız token
const PROJECT = 'PROJE_ID';            // Firebase proje kimliği
const m = $json.message || {};
const base = { botToken: BOT_TOKEN, project: PROJECT, chatId: String(m.chat?.id || '') };
if (m.contact) {
  if (m.contact.user_id && m.from && m.contact.user_id !== m.from.id)
    return [{ json: { ...base, type: 'other', reply: 'Lütfen yalnızca kendi telefon numaranızı paylaşın.' } }];
  return [{ json: { ...base, type: 'contact', tel10: String(m.contact.phone_number).replace(/\\D/g, '').slice(-10), firstName: m.contact.first_name || '' } }];
}
return [{ json: { ...base, type: 'start', reply: 'Merhaba! Giriş/çıkış hatırlatmalarını alabilmek için aşağıdaki butonla telefon numaranızı paylaşın.' } }];""", [220, 300])

ask = {"parameters": {"method": "POST", "url": "=" + TG, "sendBody": True, "specifyBody": "json",
       "jsonBody": "={{ JSON.stringify({ chat_id: $json.chatId, text: $json.reply, reply_markup: { keyboard: [[{ text: '📱 Numaramı paylaş', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }) }}",
       "options": {}}, "name": "Telefon İste", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [660, 440]}

find = http("Çalışanı Bul", "POST", "=" + FS2 + ":runQuery",
    "={{ JSON.stringify({ structuredQuery: { from: [{ collectionId: 'employees' }], limit: 1, where: { fieldFilter: { field: { fieldPath: 'tel10' }, op: 'EQUAL', value: { stringValue: $json.tel10 } } } } }) }}",
    [660, 160])
find["parameters"]["url"] = "=" + FS2 + ":runQuery"

esle = code("Eşle", """const a = $('Analiz').first().json;
const d = $input.all().map(i => i.json.document).filter(Boolean)[0];
if (!d) return [{ json: { found: 'no', chatId: a.chatId, botToken: a.botToken, project: a.project } }];
return [{ json: { found: 'yes', sicil: d.name.split('/').pop(), ad: d.fields.ad?.stringValue || '', chatId: a.chatId, botToken: a.botToken, project: a.project } }];""", [880, 160])

save = http("Chat ID Kaydet", "PATCH", "=" + FS2 + "/employees/{{ $json.sicil }}?updateMask.fieldPaths=telegramChatId",
    "={{ JSON.stringify({ fields: { telegramChatId: { stringValue: $json.chatId } } }) }}", [1320, 60])

def tgsend(name, text_expr, pos):
    return {"parameters": {"method": "POST", "url": "=" + TG, "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ chat_id: $('Eşle').first().json.chatId, text: " + text_expr + ", reply_markup: { remove_keyboard: true } }) }}",
            "options": {}}, "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos}

wf2 = {
    "name": "Telegram Telefon Kaydı",
    "nodes": [
        {"parameters": {"updates": ["message"], "additionalFields": {}}, "name": "Telegram Mesaj",
         "type": "n8n-nodes-base.telegramTrigger", "typeVersion": 1.1, "position": [0, 300], "webhookId": "bim-takip-kayit", "credentials": TCRED},
        analiz,
        ifnode("Kontakt mu?", "={{ $json.type }}", "contact", [440, 300]),
        ask, find, esle,
        ifnode("Bulundu mu?", "={{ $json.found }}", "yes", [1100, 160]),
        save,
        tgsend("Kayıt Tamam", "'✅ Teşekkürler ' + $('Eşle').first().json.ad + ', kaydınız tamamlandı. Hatırlatmalar bu sohbete gelecek.'", [1540, 60]),
        tgsend("Numara Yok", "'Bu numara sistemde kayıtlı değil. Lütfen yöneticinizle iletişime geçin.'", [1320, 260]),
    ],
    "connections": conn({
        "Telegram Mesaj": [["Analiz"]],
        "Analiz": [["Kontakt mu?"]],
        "Kontakt mu?": [["Çalışanı Bul"], ["Telefon İste"]],
        "Çalışanı Bul": [["Eşle"]],
        "Eşle": [["Bulundu mu?"]],
        "Bulundu mu?": [["Chat ID Kaydet"], ["Numara Yok"]],
        "Chat ID Kaydet": [["Kayıt Tamam"]],
    }),
    "settings": {"executionOrder": "v1"},
}

for name, wf in (("01-hatirlatma-ve-uyari.json", wf1), ("02-telegram-kayit.json", wf2)):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
print("ok")
