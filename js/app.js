import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, doc, query, where, onSnapshot, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { parseGrid, matchEmployee, parseCell } from "./ocr-parse.js";

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

const DEF = { girisOnce: 14, girisSonra: 15, cikisOnce: 15, cikisSonra: 15, aralik: 5 };
// Sabahçı: yalnızca girişi tam 08:45 olanlar. Diğer tüm girişler (10:45, 11:15, 14:15…) akşamcı sayılır.
const SABAH_GIRIS = '08:45';
const groupOf = t => t === SABAH_GIRIS ? 'sabah' : 'aksam';
let S = { ...DEF };
let rows = [], employees = [], me = null, selDate = todayStr();
let unsubRows = null, unsubEmp = null, adminTab = 'vardiya', parsed = null;
let staff = null, mine = [], weekDoc = null, adminOpen = false, curToday = todayStr(), rosterCache = null, ocrFile = null;
let unsubMine = null, weekSeq = 0;
const ready = { staff: false, auth: false };
const authorized = () => !!(me || staff);
const mySicil = () => me?.sicil || staff?.sicil || null;
const mondayOf = s => { const d = new Date(s + 'T00:00:00Z'), w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10); };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500);
}

/* ---------- Saat ---------- */
function tick() {
  $('#clock').textContent = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
}
setInterval(() => {
  tick();
  if (authorized() && todayStr() !== curToday) { if (selDate === curToday) { selDate = todayStr(); $('#selDate').value = selDate; } startData(); }
  renderDash(); renderHello();
}, 30000); tick();

/* ---------- Pano ---------- */
function watchRows() {
  unsubRows?.();
  unsubRows = onSnapshot(query(collection(db, 'attendance'), where('date', '==', selDate)),
    snap => { rows = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderDash(); },
    err => toast('Veri okunamadı: ' + err.message));
  watchWeek();
}
async function watchWeek() {
  const seq = ++weekSeq; weekDoc = null; renderWeek();
  try { const d = await getDoc(doc(db, 'shiftImages', mondayOf(selDate))); if (seq === weekSeq) { weekDoc = d.exists() ? d.data() : null; renderWeek(); } }
  catch { if (seq === weekSeq) renderWeek(); }
}
function watchMine() {
  unsubMine?.(); unsubMine = null; mine = []; curToday = todayStr();
  const sc = mySicil(); if (!sc) return renderHello();
  unsubMine = onSnapshot(query(collection(db, 'attendance'), where('sicil', '==', sc), where('date', '==', curToday)),
    snap => { mine = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderHello(); }, () => renderHello());
}
function startData() {
  if (!authorized()) { unsubRows?.(); unsubMine?.(); unsubRows = unsubMine = null; rows = []; mine = []; weekDoc = null; return; }
  watchRows(); watchMine();
}

function renderHello() {
  const el = $('#hello'), sc = mySicil();
  if (!sc) { el.hidden = true; return; }
  const ad = me?.ad || staff?.ad || sc, g = mine.find(r => r.type === 'giris'), c = mine.find(r => r.type === 'cikis'), any = g || c;
  const grp = any ? (g ? groupOf(g.planned) : 'aksam') : '';
  const ch = (r, l) => { if (!r) return ''; const st = stateOf(r); return `<span class="chip ${st}">${l} ${r.planned} ${st === 'ok' ? '✓ onaylandı' : st === 'bad' ? '! bekleniyor' : '· zamanı gelmedi'}</span>`; };
  el.hidden = false;
  el.innerHTML = `<div class="hello-top"><div><small>Hoş geldiniz</small><h2>${esc(ad)}</h2></div>${any ? `<span class="badge ${grp}">${grp === 'aksam' ? 'Akşamcı' : 'Sabahçı'}</span>` : ''}</div>` +
    (any ? `<p class="hello-line">Bugünkü vardiyanız: <b>${g?.planned || '–'} – ${c?.planned || '–'}</b></p><div class="chips">${ch(g, 'Giriş')}${ch(c, 'Çıkış')}</div>`
         : '<p class="hello-line muted">Bugün için vardiya kaydınız yok (izinli olabilirsiniz).</p>');
}

function renderWeek() {
  const el = $('#cardWeek'), ws = mondayOf(selDate);
  if (!weekDoc) { el.hidden = !me; el.innerHTML = me ? `<h2>Haftalık Vardiya</h2><p class="empty">Bu hafta için görsel yüklenmemiş (${fmtDate(ws)} haftası).</p>` : ''; return; }
  el.hidden = false;
  el.innerHTML = `<h2>Haftalık Vardiya <small>${fmtDate(ws).slice(0, 5)} – ${fmtDate(addDays(ws, 6)).slice(0, 5)}</small></h2>
    <img class="weekimg" src="${weekDoc.data}" alt="Haftalık vardiya" width="${weekDoc.w || ''}" height="${weekDoc.h || ''}"><p class="hint">Büyütmek için görsele dokunun.</p>`;
  el.querySelector('img').onclick = () => openImg(weekDoc.data);
}
function openImg(src) { $('#imgBig').src = src; $('#dlgImg').showModal(); }

function people() {
  const m = new Map();
  for (const r of rows) {
    let p = m.get(r.sicil);
    if (!p) { p = { sicil: r.sicil, ad: r.ad, giris: null, cikis: null, group: 'aksam' }; m.set(r.sicil, p); }
    p[r.type] = r;
    if (r.type === 'giris') p.group = groupOf(r.planned);
  }
  return [...m.values()].sort((a, b) =>
    ((a.giris?.planned || a.cikis?.planned || '99') + a.ad).localeCompare((b.giris?.planned || b.cikis?.planned || '99') + b.ad, 'tr'));
}

const stateOf = r => !r ? 'none' : r.confirmed ? 'ok' : Date.now() < r.windowStart ? 'wait' : 'bad';
const col = (title, list, fn, cls) => `<div class="col ${cls}"><h3>${title}<span class="cnt">${list.length}</span></h3>${
  list.length ? list.map(fn).join('') : '<p class="empty">Kayıt yok</p>'}</div>`;

function chip(r, label) {
  if (!r) return '';
  const st = stateOf(r);
  const txt = st === 'ok' ? '✓ Yapıldı' : st === 'bad' ? 'Yapılmadı' : 'Bekliyor';
  const info = `${label} ${r.planned}` + (r.reminders ? ` • ${r.reminders} hatırlatma` : '');
  return `<button class="chip ${st} ${me ? 'adm' : ''}" data-id="${esc(r.id)}" title="${esc(info)}"><span class="cl">${label} ${r.planned}</span><span class="cs">${txt}</span></button>`;
}

function renderDash() {
  const isToday = selDate === todayStr();
  $('#ttlWork').textContent = isToday ? 'Bugün Çalışanlar' : `Çalışanlar – ${fmtDate(selDate)}`;
  const ps = people();
  const sabah = ps.filter(p => p.group !== 'aksam'), aksam = ps.filter(p => p.group === 'aksam');
  $('#listWork').innerHTML =
    col('Sabahçılar', sabah, workRow, 'sabah') + col('Akşamcılar', aksam, workRow, 'aksam');
  $('#listStatus').innerHTML =
    col('Sabahçılar', sabah, statRow, 'sabah') + col('Akşamcılar', aksam, statRow, 'aksam');

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
function applyView() {
  const ok = authorized(), r = ready.staff && ready.auth;
  $('#viewLogin').hidden = !r || ok;
  $('#viewDash').hidden = !r || !ok || (!!me && adminOpen);
  $('#viewAdmin').hidden = !r || !(me && adminOpen);
  renderHeader(); renderDash(); renderHello(); renderWeek();
  if (r && me && adminOpen) renderAdmin();
}
function renderHeader() {
  const h = $('#hdrActions');
  if (!(ready.staff && ready.auth)) { h.innerHTML = ''; return; }
  h.innerHTML = me
    ? `<button class="btn light small" id="btnView">${adminOpen ? 'Pano' : 'Yönetim'}</button><button class="btn light small" id="btnOut">Çıkış</button>`
    : staff ? `<button class="btn light small" id="btnAdmin">Yönetici</button><button class="btn light small" id="btnOut">Çıkış</button>`
    : `<button class="btn light small" id="btnAdmin">Yönetici</button>`;
  $('#btnAdmin')?.addEventListener('click', () => { $('#loginErr').textContent = ''; $('#dlgLogin').showModal(); });
  $('#btnOut')?.addEventListener('click', logout);
  $('#btnView')?.addEventListener('click', () => { adminOpen = !adminOpen; applyView(); });
}
async function logout() {
  try { localStorage.removeItem('takip_staff'); } catch { }
  staff = null; adminOpen = false;
  if (auth.currentUser) await signOut(auth); else { startData(); applyView(); }
}

/* Çalışan girişi: yalnızca sicil, kayıtlı değilse giremez */
$('#frmStaff').addEventListener('submit', async e => {
  e.preventDefault();
  const sc = cleanSicil($('#inStaff').value), err = $('#staffErr'); err.textContent = '';
  if (!sc) return;
  $('#btnStaffGo').disabled = true;
  try {
    const r = await getDoc(doc(db, 'roster', sc));
    if (!r.exists()) { $('#inStaff').value = ''; err.textContent = 'Sicil bulunamadı.'; return; }
    staff = { sicil: sc, ad: r.data().ad || sc };
    try { localStorage.setItem('takip_staff', JSON.stringify(staff)); } catch { }
    $('#inStaff').value = ''; startData(); applyView();
  } catch { err.textContent = 'Bağlantı hatası, tekrar deneyin.'; }
  finally { $('#btnStaffGo').disabled = false; }
});
async function restoreStaff() {
  let c = null; try { c = JSON.parse(localStorage.getItem('takip_staff') || 'null'); } catch { }
  if (c?.sicil) {
    try {
      const r = await getDoc(doc(db, 'roster', c.sicil));
      if (r.exists()) staff = { sicil: c.sicil, ad: r.data().ad || c.ad };
      else try { localStorage.removeItem('takip_staff'); } catch { }
    } catch { staff = c; }      // çevrimdışı: kayıtlı oturumla devam
  }
  ready.staff = true; startData(); applyView();
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
  me = null; unsubEmp?.(); employees = []; rosterCache = null;
  if (u) {
    const sicil = (u.email || '').split('@')[0];
    try {
      const sn = await getDoc(doc(db, 'employees', sicil));
      if (sn.exists() && sn.data().isAdmin) {
        me = { sicil, ...sn.data() };
        await loadSettings(); await loadRoster(); watchEmployees(); adminOpen = true;
      } else { await signOut(auth); toast('Bu hesap yönetici değil.'); return; }
    } catch (e) { await signOut(auth); toast('Yetki kontrolü başarısız.'); return; }
  } else adminOpen = false;
  ready.auth = true; startData(); applyView();
});

/* roster: giriş ekranının okuyabildiği herkese açık, yalnızca {ad} içeren liste (telefon/token YOK) */
async function loadRoster() {
  rosterCache = new Map();
  try { (await getDocs(collection(db, 'roster'))).forEach(d => rosterCache.set(d.id, d.data().ad)); } catch (e) { toast('Roster okunamadı: ' + e.message); }
}
async function syncRoster() {
  if (!me || !rosterCache) return;
  const bt = writeBatch(db); let n = 0; const want = new Map();
  for (const e of employees) if (e.aktif !== false && e.ad) want.set(e.sicil, e.ad);
  for (const [sc, ad] of want) if (rosterCache.get(sc) !== ad) { bt.set(doc(db, 'roster', sc), { ad }); n++; }
  for (const sc of rosterCache.keys()) if (!want.has(sc)) { bt.delete(doc(db, 'roster', sc)); n++; }
  if (!n) return;
  try { await bt.commit(); rosterCache = new Map(want); } catch (e) { toast('Roster güncellenemedi: ' + e.message); }
}

async function loadSettings() {
  try { const s = await getDoc(doc(db, 'settings', 'main')); S = { ...DEF, ...(s.exists() ? s.data() : {}) }; } catch { S = { ...DEF }; }
}
function watchEmployees() {
  unsubEmp = onSnapshot(collection(db, 'employees'), snap => {
    employees = snap.docs.map(d => ({ sicil: d.id, ...d.data() })).sort((a, b) => (a.ad || '').localeCompare(b.ad || '', 'tr'));
    renderEmpList(); renderAdminList(); syncRoster();
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


async function saveShifts(list, offs = []) {
  const dates = [...new Set([...list, ...offs].map(r => r.date))];
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
  for (const o of offs) for (const t of (o.types || ['giris', 'cikis'])) ops.push([doc(db, 'attendance', `${o.date}_${o.sicil}_${t}`), null]);
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([ref, data]) => data === null ? b.delete(ref) : b.set(ref, data, { merge: true }));
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
  <div class="card"><h2>Görselden Vardiya Yükle (OCR)</h2>
    <p class="hint">Vardiya tablosunun ekran görüntüsünü seçin. Okunan değerler aşağıda <b>düzenlenebilir tablo</b> olarak gelir; kontrol edip kaydedin. Sarı = şüpheli, kırmızı = okunamadı/hatalı. Boş veya "B" = izinli.</p>
    <div class="rowbtn"><input type="file" id="fileImg" accept="image/*"></div>
    <div id="ocrOut"></div></div>
  <div class="card" id="cardEdit"><h2>Vardiyayı Düzenle</h2>
    <p class="hint">Kaydedilmiş vardiyayı hafta bazında düzeltin. Hücre: <b>08:45-16:45</b>, yalnızca giriş için <b>08:45-</b>, izin için <b>B</b> veya boş. Onaylar korunur.</p>
    <div class="rowbtn"><label class="datebox">Hafta başlangıcı <input type="date" id="edWeek" value="${mondayOf(selDate)}"></label>
      <button class="btn light small" id="btnEdLoad">Yükle</button></div>
    <div id="edOut"></div></div>
  <div class="card"><h2>Vardiya Görselleri</h2>
    <p class="hint">Yüklediğiniz görsel, tüm çalışanlara "Haftalık Vardiya" olarak görünür. OCR ile kaydettiğinizde görsel de otomatik yayınlanır. Aynı haftaya yeniden yüklerseniz eskisinin yerine geçer.</p>
    <div class="form"><label>Hafta başlangıcı (Pazartesi)<input type="date" id="imgWeek" value="${mondayOf(selDate)}"></label>
      <label>Görsel<input type="file" id="imgFile" accept="image/*"></label><button class="btn" id="btnImgPub">Yayınla</button></div>
    <div id="imgList" class="imglist"></div></div>
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
  $('#fileImg').onchange = e => { const f = e.target.files[0]; if (f) runOcr(f); };
  $('#edWeek').onchange = loadEditor; $('#btnEdLoad').onclick = loadEditor; loadEditor();
  $('#btnImgPub').onclick = async ev => {
    const f = $('#imgFile').files[0], w = $('#imgWeek').value;
    if (!f || !w) return toast('Hafta ve görsel seçin.');
    ev.target.disabled = true;
    try { await publishImage(f, w); toast('Görsel yayınlandı.'); $('#imgFile').value = ''; loadImgList(); if (mondayOf(w) === mondayOf(selDate)) watchWeek(); }
    catch (err) { toast('Yüklenemedi: ' + err.message); } finally { ev.target.disabled = false; }
  };
  loadImgList();
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



/* --- Kayıtlı vardiyayı düzenle (hafta tablosu) --- */
async function loadEditor() {
  const out = $('#edOut'); if (!out) return;
  const wkIn = $('#edWeek'); if (!wkIn.value) return;
  const ws = mondayOf(wkIn.value), dates = [...Array(7)].map((_, i) => addDays(ws, i));
  out.innerHTML = '<p class="hint">Yükleniyor…</p>';
  try {
    const snap = await getDocs(query(collection(db, 'attendance'), where('date', 'in', dates)));
    const m = new Map();
    snap.forEach(d => { const r = d.data(); let p = m.get(r.sicil); if (!p) { p = { sicil: r.sicil, ad: r.ad, cells: Array(7).fill(null) }; m.set(r.sicil, p); }
      const i = dates.indexOf(r.date); p.cells[i] ??= {}; p.cells[i][r.type] = r.planned; });
    const list = [...m.values()].sort((a, b) => (a.ad || '').localeCompare(b.ad || '', 'tr'));
    renderEditor(ws, dates, list);
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
const cellTxt = c => !c ? 'B' : `${c.giris || ''}-${c.cikis || ''}`;

function renderEditor(ws, dates, list) {
  const out = $('#edOut'), DN = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const addable = () => employees.filter(e => !list.some(p => p.sicil === e.sicil) && e.aktif !== false);
  const draw = () => {
    out.innerHTML = `<div class="tw ocr"><table><thead><tr><th>Çalışan</th>${DN.map((d, i) => `<th>${d}<br><small>${fmtDate(dates[i]).slice(0, 5)}</small></th>`).join('')}</tr></thead><tbody>${
      list.map((p, ri) => `<tr data-r="${ri}"><td><b>${esc(p.ad)}</b><br><small class="hint">${esc(p.sicil)}</small></td>${
        p.cells.map(c => { const t = cellTxt(c); return `<td><input class="cell ${t === 'B' ? 'off' : ''}" value="${t === 'B' ? '' : esc(t)}" data-orig="${t === 'B' ? '' : esc(t)}" placeholder="B"></td>`; }).join('')}</tr>`).join('') ||
      `<tr><td colspan="8" class="empty">Bu hafta için kayıt yok. Aşağıdan kişi ekleyip saat girebilirsiniz.</td></tr>`}</tbody></table></div>
      <div class="rowbtn"><select id="edAdd" style="max-width:260px"><option value="">+ Kişi ekle…</option>${addable().map(e => `<option value="${esc(e.sicil)}">${esc(e.ad)} (${esc(e.sicil)})</option>`).join('')}</select>
      <button class="btn" id="btnEdSave">Değişiklikleri kaydet</button></div>`;
    $('#edAdd').onchange = ev => { const e = employees.find(x => x.sicil === ev.target.value); if (!e) return;
      keep(); list.push({ sicil: e.sicil, ad: e.ad, cells: Array(7).fill(null) }); draw(); };
    out.querySelectorAll('.cell').forEach(inp => inp.oninput = () => {
      inp.className = 'cell' + (parseCell(inp.value, true) === null ? ' err' : inp.value.trim() !== inp.dataset.orig ? ' chg' : /^b?$/i.test(inp.value.trim()) ? ' off' : ''); });
    $('#btnEdSave').onclick = save;
  };
  const keep = () => out.querySelectorAll('tbody tr[data-r]').forEach(tr => { const p = list[+tr.dataset.r];
    [...tr.querySelectorAll('.cell')].forEach((c, i) => { const v = parseCell(c.value, true); if (v && v !== 'off') p.cells[i] = { giris: v.giris, cikis: v.cikis }; else if (v === 'off') p.cells[i] = null; }); });
  const save = async ev => {
    const upd = [], offs = []; let bad = 0;
    out.querySelectorAll('tbody tr[data-r]').forEach(tr => { const p = list[+tr.dataset.r], emp = employees.find(x => x.sicil === p.sicil);
      tr.querySelectorAll('.cell').forEach((c, i) => {
        if (c.value.trim() === c.dataset.orig) return;
        const v = parseCell(c.value, true), date = dates[i];
        if (v === null) { c.classList.add('err'); bad++; }
        else if (v === 'off') offs.push({ date, sicil: p.sicil });
        else { upd.push({ sicil: p.sicil, ad: p.ad, tel: emp?.telefon || '', date, giris: v.giris, cikis: v.cikis }); if (!v.cikis) offs.push({ date, sicil: p.sicil, types: ['cikis'] }); }
      }); });
    if (bad) return toast(`${bad} hücre hatalı (kırmızı). Düzeltin.`);
    if (!upd.length && !offs.length) return toast('Değişiklik yok.');
    ev.target.disabled = true; ev.target.textContent = 'Kaydediliyor…';
    try { await saveShifts(upd, offs); toast('Vardiya güncellendi.'); selDate = dates.includes(selDate) ? selDate : dates[0]; $('#selDate').value = selDate; watchRows(); loadEditor(); }
    catch (err) { toast('Hata: ' + err.message); ev.target.disabled = false; ev.target.textContent = 'Değişiklikleri kaydet'; }
  };
  draw();
}

/* --- Vardiya görselleri (Firestore'da küçültülmüş JPEG olarak; Storage ücretli olduğu için) --- */
async function compressImage(file) {
  const img = await imgFromFile(file); let maxW = 1800;
  for (let i = 0; i < 6; i++) {
    const k = Math.min(1, maxW / img.width), cv = document.createElement('canvas');
    cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    for (const q of [0.82, 0.7, 0.58]) { const url = cv.toDataURL('image/jpeg', q); if (url.length <= 760000) return { url, w: cv.width, h: cv.height }; }
    maxW = Math.round(maxW * 0.8);
  }
  throw new Error('Görsel çok büyük, daha küçük bir görüntü deneyin.');
}
async function publishImage(file, weekStart) {
  const ws = mondayOf(weekStart), { url, w, h } = await compressImage(file);
  await setDoc(doc(db, 'shiftImages', ws), { weekStart: ws, data: url, w, h, createdAt: serverTimestamp(), by: me?.ad || '' });
  return ws;
}
async function loadImgList() {
  const el = $('#imgList'); if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, 'shiftImages'), orderBy('weekStart', 'desc'), limit(8)));
    if (!el.isConnected) return;
    el.innerHTML = snap.empty ? '<p class="empty">Henüz görsel yüklenmedi.</p>' : snap.docs.map(d => { const x = d.data(); return `<figure>
      <img src="${x.data}" alt="" data-view="${esc(d.id)}"><figcaption><b>${fmtDate(x.weekStart).slice(0, 5)} – ${fmtDate(addDays(x.weekStart, 6)).slice(0, 5)}</b>
      <button class="btn danger small" data-delimg="${esc(d.id)}">Sil</button></figcaption></figure>`; }).join('');
    el.onclick = async ev => {
      const v = ev.target.dataset.view, dl = ev.target.dataset.delimg;
      if (v) openImg(ev.target.src);
      if (dl && confirm('Bu haftanın görseli silinsin mi?')) { await deleteDoc(doc(db, 'shiftImages', dl)).catch(x => toast(x.message)); loadImgList(); if (dl === mondayOf(selDate)) watchWeek(); }
    };
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

/* --- Görselden vardiya (OCR) --- */
let tessP = null;
const loadTess = () => tessP ||= new Promise((res, rej) => {
  if (window.Tesseract) return res(window.Tesseract);
  const sc = document.createElement('script');
  sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  sc.onload = () => res(window.Tesseract); sc.onerror = () => rej(new Error('OCR kütüphanesi yüklenemedi (internet bağlantısını kontrol edin)'));
  document.head.appendChild(sc);
});
const imgFromFile = f => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Görsel açılamadı')); i.src = URL.createObjectURL(f); });

async function runOcr(file) {
  ocrFile = file;
  const out = $('#ocrOut'); out.innerHTML = '<p class="hint" id="ocrMsg">Görsel hazırlanıyor…</p>';
  const msg = t => { const m = $('#ocrMsg'); if (m) m.textContent = t; };
  try {
    const img = await imgFromFile(file), k = Math.min(3, Math.max(1.5, 2400 / Math.max(img.width, img.height)));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, cv.width, cv.height);
    const probe = (x, y) => {
      try { const d = cx.getImageData(Math.round(x) - 3, Math.round(y) - 3, 7, 7).data; let r = 0, b = 0, n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; b += d[i + 2]; } r /= n; b /= n; return (b - r >= 6 && b > 200) ? 'blue' : 'white'; } catch { return null; }
    };
    msg('OCR motoru yükleniyor (ilk seferde biraz sürer)…');
    const T = await loadTess();
    const worker = await T.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') msg(`Okunuyor… %${Math.round(m.progress * 100)}`); } });
    await worker.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '150' });
    const { data } = await worker.recognize(cv);
    await worker.terminate();
    const words = (data.words || []).map(w => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
    const res = parseGrid(words, { probe, year: +todayStr().slice(0, 4) });
    if (!res.rows.length) { out.innerHTML = `<p class="err">${esc(res.warnings.join(' ') || 'Tablo okunamadı.')}</p>`; return; }
    renderOcrPreview(res);
  } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

function renderOcrPreview(res) {
  const out = $('#ocrOut'), dl = [...Array(7)].map(() => '');
  const empOpts = '<option value="">— seç / yeni —</option>' + employees.map(e => `<option value="${esc(e.sicil)}">${esc(e.ad)} (${esc(e.sicil)})</option>`).join('');
  out.innerHTML = `
    ${res.warnings.map(w => `<p class="err">${esc(w)}</p>`).join('')}
    <div class="rowbtn"><label class="datebox">Hafta başlangıcı (Pazartesi) <input type="date" id="wkStart" value="${res.weekStart || ''}"></label></div>
    <div class="tw ocr"><table><thead><tr><th>Ad (OCR)</th><th>Çalışan / Sicil</th><th>Telefon</th>${res.days.map((d, i) => `<th data-d="${i}">${d}<br><small id="dl${i}"></small></th>`).join('')}</tr></thead><tbody>${
      res.rows.map((r, ri) => `<tr data-r="${ri}">
        <td><input class="nm-in" value="${esc(r.nameRaw)}"><small class="hint">${esc(r.tag)}</small></td>
        <td><select class="emp-sel">${empOpts}</select><input class="sic-in" placeholder="Sicil no" inputmode="numeric"></td>
        <td><input class="tel-in" placeholder="05xx…" inputmode="tel"></td>
        ${r.cells.map(c => `<td><input class="cell ${c.flag || (c.text === 'B' ? 'off' : '')}" value="${esc(c.text)}" title="${esc(c.note || '')}" placeholder="B"></td>`).join('')}
      </tr>`).join('')}</tbody></table></div>
    <p class="hint">Sicil/telefon boş bırakılırsa kişi kaydedilmez. Yeni kişiler Çalışanlar listesine otomatik eklenir. Hücre biçimi: <b>08:45-16:45</b>, izin için <b>B</b> veya boş.</p>
    <div class="rowbtn"><button class="btn" id="btnOcrSave">Vardiyayı kaydet</button><button class="btn light" id="btnOcrImg">Sadece görseli yayınla</button></div>`;

  const trs = [...out.querySelectorAll('tbody tr')];
  const fillRow = (tr, e) => { tr.querySelector('.sic-in').value = e?.sicil || ''; tr.querySelector('.tel-in').value = e?.telefon || ''; if (e) tr.querySelector('.nm-in').value = e.ad; };
  trs.forEach((tr, i) => {
    const e = matchEmployee(res.rows[i].nameRaw, employees);
    if (e) { tr.querySelector('.emp-sel').value = e.sicil; fillRow(tr, e); }
    tr.querySelector('.emp-sel').onchange = ev => fillRow(tr, employees.find(x => x.sicil === ev.target.value));
    tr.querySelectorAll('.cell').forEach(inp => inp.oninput = () => { inp.className = 'cell' + (parseCell(inp.value) === null ? ' err' : /^b?$/i.test(inp.value.trim()) ? ' off' : ''); });
  });
  const wk = $('#wkStart'), dayDate = i => { if (!wk.value) return null; const d = new Date(wk.value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
  const upd = () => dl.forEach((_, i) => { const d = dayDate(i); $('#dl' + i).textContent = d ? fmtDate(d).slice(0, 5) : ''; });
  wk.onchange = upd; upd();

  $('#btnOcrImg').onclick = async ev => {
    if (!wk.value) return toast('Hafta başlangıç tarihini seçin.');
    ev.target.disabled = true;
    try { await publishImage(ocrFile, wk.value); toast('Görsel yayınlandı.'); if (mondayOf(wk.value) === mondayOf(selDate)) watchWeek(); loadImgList(); }
    catch (err) { toast('Yüklenemedi: ' + err.message); } finally { ev.target.disabled = false; }
  };
  $('#btnOcrSave').onclick = async ev => {
    if (!wk.value) return toast('Hafta başlangıç tarihini seçin.');
    const list = [], offs = []; let bad = 0, skipped = 0;
    for (const tr of trs) {
      const sicil = cleanSicil(tr.querySelector('.sic-in').value), ad = tr.querySelector('.nm-in').value.trim(), tel = tr.querySelector('.tel-in').value.trim();
      const cells = [...tr.querySelectorAll('.cell')];
      if (!sicil) { if (cells.some(c => parseCell(c.value) && parseCell(c.value) !== 'off')) skipped++; continue; }
      const known = employees.find(x => x.sicil === sicil);
      if (!known && (!ad || !tel)) { tr.querySelector('.tel-in').classList.add('err'); bad++; continue; }
      cells.forEach((c, i) => {
        const p = parseCell(c.value), date = dayDate(i);
        if (p === null) { c.classList.add('err'); bad++; }
        else if (p === 'off') offs.push({ date, sicil });
        else list.push({ sicil, ad, tel, date, ...p });
      });
    }
    if (bad) return toast(`${bad} hücre/alan hatalı (kırmızı). Düzeltin.`);
    if (!list.length && !offs.length) return toast('Kaydedilecek satır yok.');
    if (skipped && !confirm(`${skipped} kişinin sicil numarası boş; bunlar kaydedilmeyecek. Devam edilsin mi?`)) return;
    ev.target.disabled = true; ev.target.textContent = 'Kaydediliyor…';
    try {
      const r = await saveShifts(list, offs);
      let imgOk = true; try { await publishImage(ocrFile, wk.value); } catch (err) { imgOk = false; }
      toast(`${r.count} kayıt işlendi` + (r.newEmp ? `, ${r.newEmp} yeni çalışan` : '') + (imgOk ? ', görsel yayınlandı' : ', görsel yayınlanamadı')); out.innerHTML = ''; watchWeek();
    } catch (err) { toast('Hata: ' + err.message); ev.target.disabled = false; ev.target.textContent = 'Vardiyayı kaydet'; }
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
  <div class="card"><h2>Toplu Ekle</h2>
    <p class="hint">Her satıra bir kişi: <b>sicil;ad soyad;telefon</b> (Excel'den kopyalayıp yapıştırırsanız sekme ayracı da kabul edilir).</p>
    <textarea id="bulk" rows="5" placeholder="1001;Ayşe Yılmaz;05321234567"></textarea>
    <div class="rowbtn"><button class="btn" id="btnBulk">Ekle / Güncelle</button></div></div>
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
  $('#btnBulk').onclick = async () => {
    const lines = $('#bulk').value.split(/\n/).map(l => l.split(/[;\t]/).map(x => x.trim())).filter(a => a[0]);
    if (!lines.length) return toast('Satır yok.');
    const bt = writeBatch(db); let n = 0;
    for (const [sc, ad, tel] of lines) {
      const sicil = cleanSicil(sc); if (!sicil || !ad) continue;
      const cur = employees.find(x => x.sicil === sicil);
      const d = { sicil, ad, telefon: tel || '', tel10: tel10(tel), aktif: true };
      if (!cur) Object.assign(d, { isAdmin: false, notify: false });
      if (!cur?.token) d.token = newToken();
      bt.set(doc(db, 'employees', sicil), d, { merge: true }); n++;
    }
    try { await bt.commit(); $('#bulk').value = ''; toast(`${n} çalışan kaydedildi.`); } catch (err) { toast(err.message); }
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
      <button class="btn">Kaydet</button></form></div>`;
  $('#frmSet').onsubmit = async e => {
    e.preventDefault();
    S = { girisOnce: +$('#s1').value, girisSonra: +$('#s2').value, cikisOnce: +$('#s3').value, cikisSonra: +$('#s4').value, aralik: +$('#s5').value };
    try { await setDoc(doc(db, 'settings', 'main'), S); toast('Ayarlar kaydedildi.'); } catch (err) { toast(err.message); }
  };
}

/* ---------- Başlat ---------- */
restoreStaff(); renderHeader(); renderDash();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
