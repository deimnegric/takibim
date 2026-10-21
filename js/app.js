import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, doc, query, where, onSnapshot, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const TZ = 'Europe/Istanbul';
const pad = n => String(n).padStart(2, '0');
const todayStr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
const fmtDate = s => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanSicil = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const tel10 = t => String(t ?? '').replace(/\D/g, '').slice(-10);
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const emailOf = sicil => `${sicil}@bimtakip.app`;

const DEF = { girisOnce: 14, girisSonra: 15, cikisOnce: 15, cikisSonra: 15, aralik: 5, esik: '12:00' };
let S = { ...DEF };
let rows = [], employees = [], me = null, selDate = todayStr();
let unsubRows = null, unsubEmp = null, adminTab = 'vardiya', parsed = null;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500);
}

/* ---------- Saat ---------- */
function tick() {
  $('#clock').textContent = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
}
setInterval(() => { tick(); renderDash(); }, 30000); tick();

/* ---------- Pano ---------- */
function watchRows() {
  unsubRows?.();
  unsubRows = onSnapshot(query(collection(db, 'attendance'), where('date', '==', selDate)),
    snap => { rows = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderDash(); },
    err => toast('Veri okunamadı: ' + err.message));
}

function people() {
  const m = new Map();
  for (const r of rows) {
    let p = m.get(r.sicil);
    if (!p) { p = { sicil: r.sicil, ad: r.ad, giris: null, cikis: null, group: r.group || 'sabah' }; m.set(r.sicil, p); }
    p[r.type] = r;
    if (r.type === 'giris') p.group = r.group || p.group;
  }
  return [...m.values()].sort((a, b) =>
    ((a.giris?.planned || a.cikis?.planned || '99') + a.ad).localeCompare((b.giris?.planned || b.cikis?.planned || '99') + b.ad, 'tr'));
}

const stateOf = r => !r ? 'none' : r.confirmed ? 'ok' : Date.now() < r.windowStart ? 'wait' : 'bad';
const col = (title, list, fn) => `<div class="col"><h3>${title}<span class="cnt">${list.length}</span></h3>${
  list.length ? list.map(fn).join('') : '<p class="empty">Kayıt yok</p>'}</div>`;

function chip(r, label) {
  if (!r) return '';
  const st = stateOf(r);
  const icon = st === 'ok' ? '✓' : st === 'bad' ? '!' : '·';
  const info = `${label} ${r.planned}` + (r.reminders ? ` • ${r.reminders} hatırlatma` : '');
  return `<button class="chip ${st} ${me ? 'adm' : ''}" data-id="${esc(r.id)}" title="${esc(info)}">${label} ${r.planned} ${icon}</button>`;
}

function renderDash() {
  const isToday = selDate === todayStr();
  $('#ttlWork').textContent = isToday ? 'Bugün Çalışanlar' : `Çalışanlar – ${fmtDate(selDate)}`;
  const ps = people();
  const sabah = ps.filter(p => p.group !== 'aksam'), aksam = ps.filter(p => p.group === 'aksam');
  $('#listWork').innerHTML =
    col('Sabahçılar', sabah, workRow) + col('Akşamcılar', aksam, workRow);
  $('#listStatus').innerHTML =
    col('Sabahçılar', sabah, statRow) + col('Akşamcılar', aksam, statRow);

  const g = rows.filter(r => r.type === 'giris'), c = rows.filter(r => r.type === 'cikis');
  const bad = rows.filter(r => stateOf(r) === 'bad').length;
  $('#stats').innerHTML =
    `<span class="pill">${ps.length} çalışan</span>` +
    `<span class="pill ok">Giriş ${g.filter(r => r.confirmed).length}/${g.length}</span>` +
    `<span class="pill ok">Çıkış ${c.filter(r => r.confirmed).length}/${c.length}</span>` +
    (bad ? `<span class="pill bad">${bad} eksik</span>` : '');
}
const workRow = p => `<div class="row"><span class="nm">${esc(p.ad)}</span><span class="tm">${p.giris?.planned || '–'} – ${p.cikis?.planned || '–'}</span></div>`;
const statRow = p => `<div class="row st"><span class="nm">${esc(p.ad)}</span><span class="chips">${chip(p.giris, 'Giriş')}${chip(p.cikis, 'Çıkış')}</span></div>`;

$('#listStatus').addEventListener('click', async e => {
  const b = e.target.closest('.chip.adm'); if (!b || !me) return;
  const r = rows.find(x => x.id === b.dataset.id); if (!r) return;
  const msg = r.confirmed ? `${r.ad} – ${r.type === 'giris' ? 'giriş' : 'çıkış'} onayı geri alınsın mı?`
    : `${r.ad} – ${r.type === 'giris' ? 'giriş' : 'çıkış'} manuel olarak onaylansın mı?`;
  if (!confirm(msg)) return;
  try {
    await updateDoc(doc(db, 'attendance', r.id), r.confirmed
      ? { confirmed: false, confirmedAt: null, confirmedBy: null }
      : { confirmed: true, confirmedAt: serverTimestamp(), confirmedBy: 'yonetici' });
  } catch (err) { toast('Kaydedilemedi: ' + err.message); }
});

$('#selDate').value = selDate;
$('#selDate').onchange = e => { if (e.target.value) { selDate = e.target.value; watchRows(); } };
$('#btnToday').onclick = () => { selDate = todayStr(); $('#selDate').value = selDate; watchRows(); };

/* ---------- Giriş / başlık ---------- */
function renderHeader() {
  const h = $('#hdrActions');
  h.innerHTML = me
    ? `<button class="btn light small" id="btnView">${$('#viewAdmin').hidden ? 'Yönetim' : 'Pano'}</button><button class="btn light small" id="btnOut">Çıkış</button>`
    : `<button class="btn light small" id="btnAdmin">Yönetici</button>`;
  $('#btnAdmin')?.addEventListener('click', () => { $('#loginErr').textContent = ''; $('#dlgLogin').showModal(); });
  $('#btnOut')?.addEventListener('click', () => signOut(auth));
  $('#btnView')?.addEventListener('click', () => { $('#viewAdmin').hidden = !$('#viewAdmin').hidden; $('#viewDash').hidden = !$('#viewAdmin').hidden; showView(); renderHeader(); });
}
function showView() {
  if (!me) { $('#viewAdmin').hidden = true; $('#viewDash').hidden = false; return; }
  if (!$('#viewAdmin').hidden) renderAdmin();
}

$('#btnLoginCancel').onclick = () => $('#dlgLogin').close();
$('#frmLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const sicil = cleanSicil($('#inSicil').value), pw = $('#inPass').value;
  $('#btnLoginGo').disabled = true; $('#loginErr').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, emailOf(sicil), pw);
    $('#dlgLogin').close(); $('#inPass').value = '';
  } catch (err) {
    $('#loginErr').textContent = 'Sicil no veya şifre hatalı.';
  } finally { $('#btnLoginGo').disabled = false; }
});

onAuthStateChanged(auth, async u => {
  me = null; unsubEmp?.(); employees = [];
  if (u) {
    const sicil = (u.email || '').split('@')[0];
    try {
      const s = await getDoc(doc(db, 'employees', sicil));
      if (s.exists() && s.data().isAdmin) {
        me = { sicil, ...s.data() };
        await loadSettings(); watchEmployees();
        $('#viewAdmin').hidden = false; $('#viewDash').hidden = true;
      } else { await signOut(auth); toast('Bu hesap yönetici değil.'); return; }
    } catch (e) { await signOut(auth); toast('Yetki kontrolü başarısız.'); return; }
  }
  renderHeader(); renderDash(); showView();
});

async function loadSettings() {
  try { const s = await getDoc(doc(db, 'settings', 'main')); S = { ...DEF, ...(s.exists() ? s.data() : {}) }; } catch { S = { ...DEF }; }
}
function watchEmployees() {
  unsubEmp = onSnapshot(collection(db, 'employees'), snap => {
    employees = snap.docs.map(d => ({ sicil: d.id, ...d.data() })).sort((a, b) => (a.ad || '').localeCompare(b.ad || '', 'tr'));
    renderEmpList(); renderAdminList();
  }, err => toast('Çalışanlar okunamadı: ' + err.message));
}

/* ---------- Yönetim ---------- */
$$('.tab').forEach(t => t.onclick = () => { adminTab = t.dataset.tab; renderAdmin(); });
function renderAdmin() {
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === adminTab));
  const b = $('#adminBody');
  ({ vardiya: tabVardiya, calisan: tabCalisan, yonetici: tabYonetici, ayar: tabAyar })[adminTab](b);
}

/* --- Excel yardımcıları --- */
let xlsxP = null;
const loadXLSX = () => xlsxP ||= new Promise((res, rej) => {
  if (window.XLSX) return res(window.XLSX);
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Excel kütüphanesi yüklenemedi')); document.head.appendChild(s);
});
const norm = s => String(s ?? '').replace(/[İI]/g, 'i').replace(/ı/g, 'i').toLowerCase()
  .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/\s+/g, ' ').trim();

function pTime(v) {
  if (v === '' || v == null) return null;
  let h, m;
  if (typeof v === 'number') {
    if (v < 1) { const t = Math.round(v * 1440); h = Math.floor(t / 60) % 24; m = t % 60; }
    else if (v < 24) { h = Math.floor(v); m = Math.round((v % 1) * 100); }
    else return null;
  } else {
    const x = String(v).trim().replace(/[.,]/g, ':').match(/^(\d{1,2}):(\d{2})/);
    if (!x) return null; h = +x[1]; m = +x[2];
  }
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}
function pDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  return null;
}

async function parseExcel(file) {
  const X = await loadXLSX();
  const wb = X.read(await file.arrayBuffer(), { type: 'array' });
  const out = []; let skipped = 0;
  for (const name of wb.SheetNames) {
    const data = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    const hi = data.findIndex(r => r.some(c => norm(c).includes('sicil')));
    if (hi < 0) continue;
    const H = data[hi].map(norm);
    const find = f => H.findIndex(f);
    const ix = {
      sicil: find(h => h.includes('sicil')),
      ad: find(h => h === 'ad' || h.includes('ad soyad') || h.includes('adi soyadi') || h.includes('isim') || h.includes('personel')),
      tel: find(h => h.includes('tel') || h.includes('gsm')),
      tarih: find(h => h.includes('tarih')),
      giris: find(h => h.includes('giris') || h.includes('baslangic')),
      cikis: find(h => h.includes('cikis') || h.includes('bitis')),
      vardiya: find(h => h.includes('vardiya') || h === 'saat' || h.includes('mesai'))
    };
    if (ix.tarih < 0) throw new Error('"Tarih" sütunu bulunamadı.');
    for (const r of data.slice(hi + 1)) {
      const sicil = cleanSicil(r[ix.sicil]); if (!sicil) continue;
      const date = pDate(r[ix.tarih]);
      let giris = ix.giris >= 0 ? pTime(r[ix.giris]) : null, cikis = ix.cikis >= 0 ? pTime(r[ix.cikis]) : null;
      if (!giris && ix.vardiya >= 0) {
        const m = String(r[ix.vardiya]).match(/(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})/);
        if (m) { giris = pTime(m[1]); cikis = pTime(m[2]); }
      }
      if (!date || !giris) { skipped++; continue; }
      out.push({ sicil, ad: String(ix.ad >= 0 ? r[ix.ad] : '').trim() || sicil, tel: String(ix.tel >= 0 ? r[ix.tel] : '').trim(), date, giris, cikis });
    }
  }
  return { rows: out, skipped };
}

const groupOf = t => t < S.esik ? 'sabah' : 'aksam';

async function saveShifts(list) {
  const dates = [...new Set(list.map(r => r.date))];
  const existing = new Set();
  for (let i = 0; i < dates.length; i += 30) {
    const snap = await getDocs(query(collection(db, 'attendance'), where('date', 'in', dates.slice(i, i + 30))));
    snap.forEach(d => existing.add(d.id));
  }
  const ops = [];
  const empMap = new Map(employees.map(e => [e.sicil, e]));
  const seen = new Set(); let newEmp = 0, noTel = 0;
  for (const r of list) {
    if (seen.has(r.sicil)) continue; seen.add(r.sicil);
    const e = empMap.get(r.sicil), upd = {};
    if (!e) { Object.assign(upd, { sicil: r.sicil, ad: r.ad, telefon: r.tel, tel10: tel10(r.tel), aktif: true, isAdmin: false, notify: false, token: newToken() }); newEmp++; }
    else {
      if (r.tel && r.tel !== e.telefon) Object.assign(upd, { telefon: r.tel, tel10: tel10(r.tel) });
      if (!e.token) upd.token = newToken();
    }
    if (Object.keys(upd).length) ops.push([doc(db, 'employees', r.sicil), upd]);
    if (!(r.tel || e?.telefon)) noTel++;
  }
  let count = 0;
  for (const r of list) {
    const items = [['giris', r.giris, 0]];
    if (r.cikis) items.push(['cikis', r.cikis, r.cikis <= r.giris ? 1 : 0]);
    for (const [type, planned, plus] of items) {
      const id = `${r.date}_${r.sicil}_${type}`;
      const base = new Date(`${r.date}T${planned}:00+03:00`).getTime() + plus * 864e5;
      const [o, s] = type === 'giris' ? [S.girisOnce, S.girisSonra] : [S.cikisOnce, S.cikisSonra];
      const data = { date: r.date, sicil: r.sicil, ad: r.ad, type, planned, plannedAt: base,
        windowStart: base - o * 60000, windowEnd: base + s * 60000, aralik: S.aralik, group: groupOf(r.giris) };
      if (!existing.has(id)) Object.assign(data, { confirmed: false, reminders: 0, lastReminderAt: 0, alertSent: false });
      ops.push([doc(db, 'attendance', id), data]); count++;
    }
  }
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([ref, data]) => b.set(ref, data, { merge: true }));
    await b.commit();
  }
  const today = todayStr();
  selDate = dates.includes(today) ? today : dates.sort()[0];
  $('#selDate').value = selDate; watchRows();
  return { count, newEmp, noTel };
}

function tabVardiya(b) {
  b.innerHTML = `
  <div class="card"><h2>Vardiya Yükle (Excel)</h2>
    <p class="hint">Sütunlar: <b>Sicil, Ad Soyad, Telefon, Tarih, Giriş, Çıkış</b> (ya da "Vardiya" sütununda 08:45-17:45). Aynı gün tekrar yüklenirse onaylar silinmez.</p>
    <div class="rowbtn"><input type="file" id="fileX" accept=".xlsx,.xls,.csv"><button class="btn light small" id="btnTpl">Örnek şablon indir</button></div>
    <div id="prev"></div></div>
  <div class="card"><h2>Seçili gün: ${fmtDate(selDate)}</h2>
    <div class="rowbtn"><button class="btn" id="btnExp">Excel'e aktar</button><button class="btn danger" id="btnDelDay">Bu günün vardiyasını sil</button></div></div>`;

  $('#btnTpl').onclick = async () => {
    const X = await loadXLSX(); const t = todayStr();
    const ws = X.utils.aoa_to_sheet([['Sicil', 'Ad Soyad', 'Telefon', 'Tarih', 'Giriş', 'Çıkış'],
      ['1001', 'Ayşe Yılmaz', '05321234567', fmtDate(t), '08:45', '17:45'],
      ['1002', 'Mehmet Demir', '05331234567', fmtDate(t), '14:45', '23:45']]);
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Vardiya'); X.writeFile(wb, 'vardiya-sablon.xlsx');
  };
  $('#fileX').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#prev').innerHTML = '<p class="hint">Okunuyor…</p>';
    try {
      const res = await parseExcel(f); parsed = res.rows;
      if (!parsed.length) { $('#prev').innerHTML = '<p class="err">Geçerli satır bulunamadı.</p>'; return; }
      const ds = [...new Set(parsed.map(r => r.date))].sort(), n = new Set(parsed.map(r => r.sicil)).size;
      $('#prev').innerHTML = `<p><b>${parsed.length}</b> vardiya satırı, <b>${n}</b> kişi, ${fmtDate(ds[0])} – ${fmtDate(ds.at(-1))}` +
        (res.skipped ? ` <span class="tag">${res.skipped} satır atlandı</span>` : '') + `</p>
        <div class="tw"><table><tr><th>Sicil</th><th>Ad</th><th>Tarih</th><th>Giriş</th><th>Çıkış</th></tr>${
          parsed.slice(0, 8).map(r => `<tr><td>${esc(r.sicil)}</td><td>${esc(r.ad)}</td><td>${fmtDate(r.date)}</td><td>${r.giris}</td><td>${r.cikis || '–'}</td></tr>`).join('')}</table></div>
        <div class="rowbtn"><button class="btn" id="btnSave">Vardiyayı kaydet</button></div>`;
      $('#btnSave').onclick = async ev => {
        ev.target.disabled = true; ev.target.textContent = 'Kaydediliyor…';
        try {
          const r = await saveShifts(parsed);
          toast(`${r.count} kayıt işlendi` + (r.newEmp ? `, ${r.newEmp} yeni çalışan` : '') + (r.noTel ? `, ${r.noTel} kişinin telefonu eksik` : ''));
          parsed = null; renderAdmin();
        } catch (err) { toast('Hata: ' + err.message); ev.target.disabled = false; ev.target.textContent = 'Vardiyayı kaydet'; }
      };
    } catch (err) { $('#prev').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  };
  $('#btnExp').onclick = async () => {
    if (!rows.length) return toast('Bu günde kayıt yok.');
    const X = await loadXLSX();
    const data = [['Sicil', 'Ad Soyad', 'Tarih', 'İşlem', 'Planlanan', 'Durum', 'Onay Saati', 'Onaylayan', 'Hatırlatma']];
    [...rows].sort((a, b) => a.planned.localeCompare(b.planned)).forEach(r => data.push([r.sicil, r.ad, fmtDate(r.date),
      r.type === 'giris' ? 'Giriş' : 'Çıkış', r.planned, r.confirmed ? 'Yapıldı' : 'Yapılmadı',
      r.confirmedAt?.toDate ? r.confirmedAt.toDate().toLocaleTimeString('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '',
      r.confirmedBy === 'yonetici' ? 'Yönetici' : r.confirmedBy === 'calisan' ? 'Çalışan' : '', r.reminders || 0]));
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(data), 'Rapor'); X.writeFile(wb, `takip-${selDate}.xlsx`);
  };
  $('#btnDelDay').onclick = async () => {
    if (!rows.length) return toast('Bu günde kayıt yok.');
    if (!confirm(`${fmtDate(selDate)} tarihli ${rows.length} kayıt silinsin mi?`)) return;
    const bt = writeBatch(db); rows.forEach(r => bt.delete(doc(db, 'attendance', r.id)));
    try { await bt.commit(); toast('Silindi.'); } catch (e) { toast('Silinemedi: ' + e.message); }
  };
}

/* --- Çalışanlar --- */
function tabCalisan(b) {
  b.innerHTML = `
  <div class="card"><h2>Çalışan Ekle / Güncelle</h2>
    <form class="form" id="frmEmp">
      <label>Sicil No<input id="eSicil" required></label>
      <label>Ad Soyad<input id="eAd" required></label>
      <label>Telefon<input id="eTel" inputmode="tel" placeholder="05xx xxx xx xx"></label>
      <button class="btn">Kaydet</button>
    </form></div>
  <div class="card"><h2>Çalışanlar</h2><input id="eSearch" placeholder="Ara…"><div class="tw" id="empList"></div>
    <p class="hint">"Bot" sütunu, çalışanın Telegram botuna telefonunu paylaşıp paylaşmadığını gösterir. Bağlı olmayana mesaj gitmez.</p></div>`;
  $('#frmEmp').onsubmit = async e => {
    e.preventDefault();
    const sicil = cleanSicil($('#eSicil').value), cur = employees.find(x => x.sicil === sicil);
    const data = { sicil, ad: $('#eAd').value.trim(), telefon: $('#eTel').value.trim(), tel10: tel10($('#eTel').value), aktif: true };
    if (!cur) Object.assign(data, { isAdmin: false, notify: false });
    if (!cur?.token) data.token = newToken();
    try { await setDoc(doc(db, 'employees', sicil), data, { merge: true }); e.target.reset(); toast('Kaydedildi.'); } catch (err) { toast(err.message); }
  };
  $('#eSearch').oninput = renderEmpList;
  renderEmpList();
}
function renderEmpList() {
  const el = $('#empList'); if (!el) return;
  const q = norm($('#eSearch')?.value || '');
  const list = employees.filter(e => !q || norm(e.ad + e.sicil + e.telefon).includes(q));
  el.innerHTML = `<table><tr><th>Sicil</th><th>Ad</th><th>Telefon</th><th>Bot</th><th></th></tr>${
    list.map(e => `<tr><td>${esc(e.sicil)}</td><td>${esc(e.ad)}${e.isAdmin ? ' <span class="tag">yönetici</span>' : ''}</td><td>${esc(e.telefon)}</td>
    <td>${e.telegramChatId ? '<span class="tag ok">bağlı</span>' : '<span class="tag">yok</span>'}</td>
    <td><button class="btn light small" data-ed="${esc(e.sicil)}">Düzenle</button> <button class="btn danger small" data-del="${esc(e.sicil)}">Sil</button></td></tr>`).join('')}</table>`;
  el.onclick = async ev => {
    const ed = ev.target.dataset.ed, del = ev.target.dataset.del;
    if (ed) {
      const e = employees.find(x => x.sicil === ed);
      const ad = prompt('Ad Soyad', e.ad); if (ad === null) return;
      const tel = prompt('Telefon', e.telefon || ''); if (tel === null) return;
      await updateDoc(doc(db, 'employees', ed), { ad: ad.trim(), telefon: tel.trim(), tel10: tel10(tel) }).catch(x => toast(x.message));
    }
    if (del) {
      if (del === me.sicil) return toast('Kendinizi silemezsiniz.');
      if (confirm('Çalışan silinsin mi? (Geçmiş vardiya kayıtları kalır)')) await deleteDoc(doc(db, 'employees', del)).catch(x => toast(x.message));
    }
  };
}

/* --- Yöneticiler --- */
function tabYonetici(b) {
  b.innerHTML = `
  <div class="card"><h2>Yönetici Ekle</h2>
    <p class="hint">Çalışanlar listesinden seçin ve bir şifre belirleyin (en az 6 karakter). Yönetici, sicil no + bu şifre ile girer.</p>
    <form class="form" id="frmAdm"><label>Çalışan<select id="aSel" required></select></label>
      <label>Şifre<input id="aPw" type="text" minlength="6" required></label><button class="btn">Yönetici yap</button></form></div>
  <div class="card"><h2>Yöneticiler</h2><div class="tw" id="admList"></div>
    <p class="hint">"Bildirim" açık olan yöneticilere, giriş/çıkış yapılmadığında Telegram'dan uyarı gider.</p></div>`;
  $('#frmAdm').onsubmit = async e => {
    e.preventDefault();
    const sicil = $('#aSel').value, pw = $('#aPw').value;
    try {
      try {
        const sec = initializeApp(firebaseConfig, 'sec' + Date.now()), a = getAuth(sec);
        try { await createUserWithEmailAndPassword(a, emailOf(sicil), pw); }
        finally { await signOut(a).catch(() => { }); await deleteApp(sec); }
      } catch (err) {
        if (err.code !== 'auth/email-already-in-use') throw err;
        toast('Bu sicil için hesap zaten var; yetki verildi, şifre değişmedi.');
      }
      await updateDoc(doc(db, 'employees', sicil), { isAdmin: true, notify: true });
      $('#aPw').value = ''; toast('Yönetici eklendi.');
    } catch (err) { toast('Eklenemedi: ' + (err.code || err.message)); }
  };
  renderAdminList();
}
function renderAdminList() {
  const sel = $('#aSel'), el = $('#admList'); if (!sel || !el) return;
  sel.innerHTML = employees.filter(e => !e.isAdmin).map(e => `<option value="${esc(e.sicil)}">${esc(e.ad)} (${esc(e.sicil)})</option>`).join('');
  el.innerHTML = `<table><tr><th>Ad</th><th>Sicil</th><th>Bildirim</th><th></th></tr>${
    employees.filter(e => e.isAdmin).map(e => `<tr><td>${esc(e.ad)}</td><td>${esc(e.sicil)}</td>
    <td><input type="checkbox" data-nt="${esc(e.sicil)}" ${e.notify ? 'checked' : ''} style="width:auto"></td>
    <td>${e.sicil === me.sicil ? '' : `<button class="btn danger small" data-rm="${esc(e.sicil)}">Yetkiyi kaldır</button>`}</td></tr>`).join('')}</table>`;
  el.onclick = async ev => {
    if (ev.target.dataset.rm && confirm('Yönetici yetkisi kaldırılsın mı?'))
      await updateDoc(doc(db, 'employees', ev.target.dataset.rm), { isAdmin: false, notify: false }).catch(x => toast(x.message));
  };
  el.onchange = async ev => {
    if (ev.target.dataset.nt) await updateDoc(doc(db, 'employees', ev.target.dataset.nt), { notify: ev.target.checked }).catch(x => toast(x.message));
  };
}

/* --- Ayarlar --- */
function tabAyar(b) {
  b.innerHTML = `<div class="card"><h2>Ayarlar</h2>
    <p class="hint">Değişiklikler yalnızca bundan sonra yüklenen vardiyalara uygulanır.</p>
    <form class="form" id="frmSet">
      <label>Giriş: kaç dk önce başlasın<input type="number" id="s1" min="0" max="120" value="${S.girisOnce}"></label>
      <label>Giriş: kaç dk sonra bitsin<input type="number" id="s2" min="0" max="120" value="${S.girisSonra}"></label>
      <label>Çıkış: kaç dk önce başlasın<input type="number" id="s3" min="0" max="120" value="${S.cikisOnce}"></label>
      <label>Çıkış: kaç dk sonra bitsin<input type="number" id="s4" min="0" max="120" value="${S.cikisSonra}"></label>
      <label>Hatırlatma aralığı (dk)<input type="number" id="s5" min="1" max="60" value="${S.aralik}"></label>
      <label>Sabah/akşam sınırı (giriş saati)<input type="time" id="s6" value="${S.esik}"></label>
      <button class="btn">Kaydet</button></form></div>`;
  $('#frmSet').onsubmit = async e => {
    e.preventDefault();
    S = { girisOnce: +$('#s1').value, girisSonra: +$('#s2').value, cikisOnce: +$('#s3').value, cikisSonra: +$('#s4').value, aralik: +$('#s5').value, esik: $('#s6').value };
    try { await setDoc(doc(db, 'settings', 'main'), S); toast('Ayarlar kaydedildi.'); } catch (err) { toast(err.message); }
  };
}

/* ---------- Başlat ---------- */
watchRows(); renderHeader(); renderDash();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
