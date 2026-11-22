import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, doc, query, where, onSnapshot, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, orderBy, limit, getCountFromServer, increment } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { parseCell } from "./ocr-parse.js";

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

/* ---- Roller: MS (kırmızı), MSY (mor), GT (turuncu), personel (mavi) ---- */
const ROLES = { ms: { t: 'MS', rank: 0 }, msy: { t: 'MSY', rank: 0 }, gt: { t: 'GT', rank: 1 }, per: { t: 'PER', rank: 2 } };
const fold = s => String(s ?? '').replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i').toLowerCase()
  .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/\s+/g, ' ').trim();
const ORDER_NAMES = ['gonul', 'dilara', 'rafi', 'selcuk', 'kubra', 'medine'];     // diğer personelin sırası
function guessRole(ad) {                                                         // rol yazılmamış kişiler için isme göre varsayılan
  const n = fold(ad), first = n.split(' ')[0];
  if (first === 'huseyin') return { rol: 'ms', sira: 0 };
  if (first === 'turgay') return { rol: 'msy', sira: 0 };
  if (n.startsWith('mehmet emin')) return { rol: 'gt', sira: 0 };
  const i = ORDER_NAMES.indexOf(first);
  return { rol: 'per', sira: i >= 0 ? i + 1 : 99 };
}
let metaMap = new Map(), unsubMeta = null;                                       // sicil -> {r: rol, s: sıra}
const setMeta = o => { metaMap = new Map(Object.entries(o || {})); };
const roleOf = sc => (ROLES[metaMap.get(sc)?.r] ? metaMap.get(sc).r : 'per');
const rankOf = sc => ROLES[roleOf(sc)].rank;
const cmpPeople = (a, b) => rankOf(a.sicil) - rankOf(b.sicil) || (metaMap.get(a.sicil)?.s ?? 99) - (metaMap.get(b.sicil)?.s ?? 99) || (a.ad || '').localeCompare(b.ad || '', 'tr');
const roleTag = sc => `<span class="rtag r-${roleOf(sc)}">${ROLES[roleOf(sc)].t}</span>`;

const DEF = { girisOnce: 14, girisSonra: 15, cikisOnce: 15, cikisSonra: 15, aralik: 5, mola1Es: 6, mola1: 0.5, mola2Es: 9, mola2: 1, mola3: 1.5 };
// Sabahçı: yalnızca girişi tam 08:45 olanlar. Diğer tüm girişler (10:45, 11:15, 14:15…) akşamcı sayılır.
const SABAH_GIRIS = '08:45';
const groupOf = t => t === SABAH_GIRIS ? 'sabah' : 'aksam';
let S = { ...DEF };
let rows = [], employees = [], me = null, selDate = todayStr();
let unsubRows = null, unsubEmp = null, adminTab = 'vardiya', parsed = null;
let staff = null, mine = [], weekDoc = null, adminOpen = false, curToday = todayStr(), rosterCache = null, ocrFile = null;
let unsubMine = null, weekSeq = 0, unsubOff = null, offRows = [], mineOff = false;
const ready = { staff: false, auth: false };
const authorized = () => !!(me || staff);
const mySicil = () => me?.sicil || staff?.sicil || null;
/* ---- Mağazalar: magaza alanı boş = Atatürk Cd. (mevcut ekip). Çalışan/yönetici yalnızca kendi mağazasının panosunu görür. ---- */
let STORES = {}, viewStore = '', unsubStores = null;                                  // STORES: {slug: görünen ad}
const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const storeName = id => id ? (STORES[id] || id) : 'Atatürk Cd.';
const scope = () => me ? (me.magaza || viewStore) : staff ? (staff.m || '') : '';
const inScope = r => (r.magaza || '') === scope();
const imgId = ws => scope() ? `${scope()}_${ws}` : ws;
const pwOf = sc => sc.length < 6 ? sc.padEnd(6, '0') : sc;                             // Firebase en az 6 karakter ister: 82740 → 827400
function renderStoreSel() {
  const ids = Object.keys(STORES), show = !!me && !me.magaza && ids.length > 0;
  $$('.storesel').forEach(el => { el.hidden = !show; const lb = el.closest('label'); if (lb) lb.style.display = show ? '' : 'none'; if (show) { el.innerHTML = '<option value="">Atatürk Cd. (mevcut ekip)</option>' + ids.map(i => `<option value="${esc(i)}">${esc(STORES[i])}</option>`).join(''); el.value = viewStore; } });
  const em = $('#eMag'); if (em) { const v = em.value; em.innerHTML = '<option value="">Atatürk Cd. (mevcut ekip)</option>' + ids.map(i => `<option value="${esc(i)}">${esc(STORES[i])}</option>`).join(''); em.value = v; }
}
function setViewStore(v) { viewStore = v; watchRows(); renderStoreSel(); renderDash(); if (me && adminOpen) renderAdmin(); }
document.addEventListener('change', e => { if (e.target.classList?.contains('storesel')) setViewStore(e.target.value); });
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
  const sc = scope(), qw = [where('date', '==', selDate), ...(sc ? [where('magaza', '==', sc)] : [])];
  unsubRows = onSnapshot(query(collection(db, 'attendance'), ...qw),
    snap => { rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(inScope); renderDash(); },
    err => toast('Veri okunamadı: ' + err.message));
  watchMine();                                   // üstteki kişisel vardiya kartı da seçili güne geçer
  unsubOff?.(); offRows = [];
  unsubOff = onSnapshot(query(collection(db, 'offdays'), ...qw),
    snap => { offRows = snap.docs.map(d => d.data()).filter(inScope); renderDash(); }, () => { });
  watchWeek();
}
async function watchWeek() {
  const seq = ++weekSeq; weekDoc = null; renderWeek();
  try { const d = await getDoc(doc(db, 'shiftImages', imgId(mondayOf(selDate)))); if (seq === weekSeq) { weekDoc = d.exists() ? d.data() : null; renderWeek(); } }
  catch { if (seq === weekSeq) renderWeek(); }
}
function watchMine() {
  unsubMine?.(); unsubMine = null; mine = []; mineOff = false; curToday = todayStr();
  const sc = mySicil(), day = selDate; if (!sc) return renderHello();
  getDoc(doc(db, 'offdays', `${day}_${sc}`)).then(d => { if (day === selDate) { mineOff = d.exists(); renderHello(); } }).catch(() => { });
  unsubMine = onSnapshot(query(collection(db, 'attendance'), where('sicil', '==', sc), where('date', '==', day)),
    snap => { mine = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderHello(); }, () => renderHello());
}
function startData() {
  if (!authorized()) { unsubRows?.(); unsubMine?.(); unsubOff?.(); unsubMeta?.(); unsubStores?.(); unsubRows = unsubMine = unsubOff = unsubMeta = unsubStores = null; rows = []; mine = []; offRows = []; weekDoc = null; return; }
  watchRows(); watchMeta();
}
function watchMeta() {
  unsubMeta?.(); unsubMeta = null;
  if (!authorized()) return;
  unsubStores?.(); unsubStores = onSnapshot(doc(db, 'meta', 'stores'), d => { STORES = d.exists() ? (d.data().s || {}) : {}; renderStoreSel(); renderDash(); renderHello(); }, () => { });
  unsubMeta = onSnapshot(doc(db, 'meta', 'people'), d => { if (me) return; setMeta(d.exists() ? d.data().p : {}); renderDash(); renderHello(); }, () => { });
}

function renderHello() {
  const el = $('#hello'), sc = mySicil();
  if (!sc) { el.hidden = true; return; }
  const ad = me?.ad || staff?.ad || sc, g = mine.find(r => r.type === 'giris'), c = mine.find(r => r.type === 'cikis'), any = g || c;
  const full = g?.planned === '08:45' && c?.planned === '21:15', grp = any ? (full ? 'full' : g ? groupOf(g.planned) : 'aksam') : '';
  const ch = (r, l) => { if (!r) return ''; const st = stateOf(r), tap = canTap(r);
    return `<span class="chip ${st}${tap ? ' tap' : ''}" data-id="${esc(r.id)}">${l} ${r.planned} ${st === 'ok' ? '✓ onaylandı' : st === 'bad' ? '! bekleniyor' : '· zamanı gelmedi'}${tap ? ' · dokun' : ''}</span>`; };
  const canSelf = !me && [g, c].some(r => r && canTap(r));
  const isTd = selDate === todayStr(), dayLbl = isTd ? 'Bugünkü' : fmtDate(selDate);
  el.hidden = false;
  el.innerHTML = `<div class="hello-top"><div><small>Hoş geldiniz${scope() ? ' · ' + esc(storeName(scope())) : ''}</small><h2>${esc(ad)} ${roleTag(sc)}</h2></div>${any ? `<span class="badge ${grp}">${grp === 'full' ? 'Tam gün' : grp === 'aksam' ? 'Akşamcı' : 'Sabahçı'}</span>` : mineOff ? '<span class="izin-pill">İzinli</span>' : ''}</div>` +
    (any ? `<p class="hello-line">${dayLbl} vardiyanız: <b>${g?.planned || '–'} – ${c?.planned || '–'}</b></p><div class="chips">${ch(g, 'Giriş')}${ch(c, 'Çıkış')}</div>${canSelf ? '<p class="hint">Kalbim\'den işleminizi yaptıysanız saate dokunarak onaylayabilirsiniz.</p>' : ''}`
         : mineOff ? `<p class="hello-line">${isTd ? 'Bugün' : dayLbl} izinlisiniz.</p>` : `<p class="hello-line muted">${isTd ? 'Bugün' : dayLbl} için vardiya kaydınız yok (izinli olabilirsiniz).</p>`);
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
  return [...m.values()].sort(cmpPeople);          // MS/MSY, GT, sonra belirlenen personel sırası
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

const isFull = p => p.giris?.planned === '08:45' && p.cikis?.planned === '21:15';
function rowClass(p) {
  const now = Date.now(), missed = r => r && !r.confirmed && now >= (r.windowEnd || Infinity);
  if (p.cikis?.confirmed) return 'st-done';                       // çıkış yapıldı: renksiz
  if (missed(p.cikis) || missed(p.giris)) return 'st-bad';        // unutuldu: tamamen kırmızı
  if (p.giris?.confirmed) return 'st-ok';                         // giriş yapıldı: yeşil
  return '';
}
function renderDash() {
  const isToday = selDate === todayStr();
  $('#ttlWork').textContent = (isToday ? 'Bugün Çalışanlar' : `Çalışanlar – ${fmtDate(selDate)}`) + (scope() ? ' · ' + storeName(scope()) : '');
  const ps = people();
  const sabah = ps.filter(p => p.group !== 'aksam'), aksam = ps.filter(p => p.group === 'aksam' || isFull(p));   // 08:45-21:15 olanlar iki listede
  const izin = offRows.filter(o => !ps.some(p => p.sicil === o.sicil)).sort(cmpPeople);
  $('#listWork').innerHTML = col('Sabahçılar', sabah, workRow, 'sabah') + col('Akşamcılar', aksam, workRow, 'aksam') +
    (izin.length ? col('İzinliler', izin, izinRow, 'izin') : '');

  const g = rows.filter(r => r.type === 'giris'), c = rows.filter(r => r.type === 'cikis');
  const missed = rows.filter(r => !r.confirmed && Date.now() >= r.windowEnd).length;
  $('#stats').innerHTML =
    `<span class="pill">${ps.length} çalışan</span>` + (izin.length ? `<span class="pill blue">${izin.length} izinli</span>` : '') +
    `<span class="pill ok">Giriş ${g.filter(r => r.confirmed).length}/${g.length}</span>` +
    `<span class="pill ok">Çıkış ${c.filter(r => r.confirmed).length}/${c.length}</span>` +
    (missed ? `<span class="pill bad">${missed} eksik</span>` : '');
}
/* Dokunma yetkisi: yönetici herkese, çalışan yalnızca bugünkü kendi onaylanmamış kaydına */
const canTap = r => !!me || (!!staff?.sicil && r.sicil === staff.sicil && r.date === todayStr() && !r.confirmed);
const seg = (r, cls) => {
  if (!r) return `<span class="${cls}">–</span>`;
  const tap = canTap(r);
  const info = `${r.type === 'giris' ? 'Giriş' : 'Çıkış'} ${r.planned}: ${r.confirmed ? 'yapıldı' : 'bekleniyor'}` + (r.reminders ? ` • ${r.reminders} hatırlatma` : '') + (me ? ' — dokunarak onayla/geri al' : tap ? ' — dokunarak onayla' : '');
  return `<span class="${cls}${tap ? ' tap' : ''}" data-id="${esc(r.id)}" title="${esc(info)}">${r.planned}</span>`;
};
const workRow = p => `<div class="row ${rowClass(p)} rl-${roleOf(p.sicil)}"><span class="nm">${roleTag(p.sicil)}${esc(p.ad)}</span><span class="tm">${seg(p.giris, 'tg')}<i class="sep">–</i>${seg(p.cikis, 'tc')}</span></div>`;
const izinRow = o => `<div class="row rl-${roleOf(o.sicil)}"><span class="nm">${roleTag(o.sicil)}${esc(o.ad)}</span><span class="izin-pill">İzinli</span></div>`;

/* Saate dokunarak onay: yönetici herkesi onaylar/geri alır; çalışan yalnızca kendini onaylar */
async function onTapTime(e) {
  const b = e.target.closest('.tap[data-id]'); if (!b) return;
  const r = [...rows, ...mine].find(x => x.id === b.dataset.id); if (!r || !canTap(r)) return;
  const lbl = r.type === 'giris' ? 'giriş' : 'çıkış';
  if (me) {
    if (!confirm(r.confirmed ? `${r.ad} – ${lbl} onayı geri alınsın mı?` : `${r.ad} – ${lbl} manuel olarak onaylansın mı?`)) return;
    try {
      await updateDoc(doc(db, 'attendance', r.id), r.confirmed
        ? { confirmed: false, confirmedAt: null, confirmedBy: null }
        : { confirmed: true, confirmedAt: serverTimestamp(), confirmedBy: 'yonetici' });
    } catch (err) { toast('Kaydedilemedi: ' + err.message); }
    return;
  }
  if (!staff?.token) return toast('Onay için yöneticinin bir kez giriş yapıp listeyi güncellemesi gerekiyor.');
  if (!confirm(`${r.planned} ${lbl === 'giriş' ? 'girişinizi' : 'çıkışınızı'} kalbim uygulamasından yaptığınızı onaylıyor musunuz?`)) return;
  try {
    const bt = writeBatch(db);
    bt.set(doc(db, 'confirms', r.id), { ctoken: staff.token });
    bt.update(doc(db, 'attendance', r.id), { confirmed: true, confirmedAt: serverTimestamp(), confirmedBy: 'calisan' });
    await bt.commit();
    toast(`${lbl === 'giriş' ? 'Giriş' : 'Çıkış'} onaylandı, teşekkürler.`);
  } catch (err) { toast('Onaylanamadı. Bağlantınızı kontrol edin ya da yöneticinize bildirin.'); }
}
$('#listWork').addEventListener('click', onTapTime);
$('#hello').addEventListener('click', onTapTime);

$('#selDate').value = selDate;
$('#selDate').onchange = e => { if (e.target.value) { selDate = e.target.value; watchRows(); } };
$('#btnToday').onclick = () => { selDate = todayStr(); $('#selDate').value = selDate; watchRows(); };
$('#btnNext').onclick = () => { selDate = addDays(selDate, 1); $('#selDate').value = selDate; watchRows(); };

/* ---------- Giriş / başlık ---------- */
function applyView() {
  const ok = authorized(), r = ready.staff && ready.auth;
  $('#viewLogin').hidden = !r || ok;
  $('#viewDash').hidden = !r || !ok || (!!me && adminOpen);
  $('#viewAdmin').hidden = !r || !(me && adminOpen);
  renderStoreSel(); renderHeader(); renderDash(); renderHello(); renderWeek();
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
    staff = { sicil: sc, ad: r.data().ad || sc, token: r.data().token || '', m: r.data().m || '' };
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
      if (r.exists()) staff = { sicil: c.sicil, ad: r.data().ad || c.ad, token: r.data().token || '', m: r.data().m || '' };
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
    await signInWithEmailAndPassword(auth, emailOf(sicil), pwOf(pw));
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
        viewStore = ''; await loadSettings(); if (!me.magaza) await loadRoster(); watchEmployees(); adminOpen = false;   // önce pano açılır, yönetim 'Yönetim' butonuyla
      } else { await signOut(auth); toast('Bu hesap yönetici değil.'); return; }
    } catch (e) { await signOut(auth); toast('Yetki kontrolü başarısız.'); return; }
  } else adminOpen = false;
  ready.auth = true; startData(); applyView();
});

/* roster: giriş ekranının okuyabildiği herkese açık, yalnızca {ad} içeren liste (telefon/token YOK) */
async function loadRoster() {
  rosterCache = new Map();
  try { (await getDocs(collection(db, 'roster'))).forEach(d => rosterCache.set(d.id, { ad: d.data().ad, token: d.data().token || '', m: d.data().m || '' })); } catch (e) { toast('Roster okunamadı: ' + e.message); }
}
let rosterBusy = false, rosterAgain = false, metaCache = '';
async function syncRoster() {
  if (!me || me.magaza || !rosterCache) return;
  if (rosterBusy) { rosterAgain = true; return; }
  rosterBusy = true;
  try {
    const bt = writeBatch(db); let n = 0; const want = new Map(), meta = {};
    for (const e of employees) {
      if (e.aktif === false || !e.ad) continue;
      let token = e.token; const upd = {}, g = guessRole(e.ad);
      if (!token) { token = newToken(); upd.token = token; }                    // tokensız çalışanlara anahtar üret
      if (!e.rol) { upd.rol = g.rol; upd.sira = g.sira; }                       // rolü yazılmamışlara isme göre varsayılan
      if (Object.keys(upd).length) { bt.update(doc(db, 'employees', e.sicil), upd); n++; }
      want.set(e.sicil, { ad: e.ad, token, m: e.magaza || '' });
      meta[e.sicil] = { r: e.rol || g.rol, s: e.sira ?? g.sira };
    }
    const metaJson = JSON.stringify(Object.fromEntries(Object.keys(meta).sort().map(k => [k, meta[k]])));
    if (metaJson !== metaCache) { bt.set(doc(db, 'meta', 'people'), { p: JSON.parse(metaJson) }); n++; }
    for (const [sc, v] of want) { const c = rosterCache.get(sc); if (!c || c.ad !== v.ad || c.token !== v.token || (c.m || '') !== v.m) { bt.set(doc(db, 'roster', sc), v); n++; } }
    for (const sc of rosterCache.keys()) if (!want.has(sc)) { bt.delete(doc(db, 'roster', sc)); n++; }
    if (n) { await bt.commit(); rosterCache = new Map(want); metaCache = metaJson; }
  } catch (e) { toast('Roster güncellenemedi: ' + e.message); }
  finally { rosterBusy = false; if (rosterAgain) { rosterAgain = false; syncRoster(); } }
}

async function loadSettings() {
  try { const s = await getDoc(doc(db, 'settings', 'main')); S = { ...DEF, ...(s.exists() ? s.data() : {}) }; } catch { S = { ...DEF }; }
}
function watchEmployees() {
  unsubEmp = onSnapshot(me.magaza ? query(collection(db, 'employees'), where('magaza', '==', me.magaza)) : collection(db, 'employees'), snap => {
    const raw = snap.docs.map(d => ({ sicil: d.id, ...d.data() }));
    metaMap = new Map(raw.map(e => { const g = guessRole(e.ad); return [e.sicil, { r: e.rol || g.rol, s: e.sira ?? g.sira }]; }));
    employees = raw.sort(cmpPeople);
    renderEmpList(); renderAdminList(); renderDash(); renderHello(); syncRoster();
  }, err => toast('Çalışanlar okunamadı: ' + err.message));
}

/* ---------- Yönetim ---------- */
$$('.tab').forEach(t => t.onclick = () => { adminTab = t.dataset.tab; renderAdmin(); });
function renderAdmin() {
  if (me.magaza) adminTab = 'vardiya';                                                   // mağaza yöneticisi yalnızca Vardiya sekmesini görür
  $$('.tab').forEach(t => { t.hidden = !!me.magaza && t.dataset.tab !== 'vardiya'; t.classList.toggle('on', t.dataset.tab === adminTab); });
  $('#adminStore').innerHTML = !me.magaza && adminTab === 'vardiya' ? '<div class="bar"><label class="datebox">Mağaza <select class="storesel"></select></label></div>' : '';
  renderStoreSel();
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

async function saveShifts(list, offs = []) {
  const dates = [...new Set([...list, ...offs].map(r => r.date))];
  const existing = new Set();
  for (let i = 0; i < dates.length; i += 30) {
    const snap = await getDocs(query(collection(db, 'attendance'), where('date', 'in', dates.slice(i, i + 30))));
    snap.forEach(d => existing.add(d.id));
  }
  const ops = [];
  const empMap = new Map(employees.map(e => [e.sicil, e]));
  const seen = new Set(); let newEmp = 0, noTel = 0; const mgOf = sc => empMap.get(sc)?.magaza || '', mgTag = sc => ({ magaza: mgOf(sc), magazaAd: mgOf(sc) ? storeName(mgOf(sc)) : '' });
  for (const r of list) {
    if (seen.has(r.sicil)) continue; seen.add(r.sicil);
    const e = empMap.get(r.sicil), upd = {};
    if (me.magaza) { /* mağaza yöneticisi çalışan kaydını değiştirmez */ }
    else if (!e) { Object.assign(upd, { sicil: r.sicil, ad: r.ad, telefon: r.tel, tel10: tel10(r.tel), aktif: true, isAdmin: false, notify: false, token: newToken() }); newEmp++; }
    else {
      if (r.tel && r.tel !== e.telefon) Object.assign(upd, { telefon: r.tel, tel10: tel10(r.tel) });
      if (!e.token) upd.token = newToken();
    }
    if (!me.magaza && Object.keys(upd).length) ops.push([doc(db, 'employees', r.sicil), upd]);
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
        windowStart: base - o * 60000, windowEnd: base + s * 60000, aralik: S.aralik, group: groupOf(r.giris), ...mgTag(r.sicil) };
      if (!existing.has(id)) Object.assign(data, { confirmed: false, reminders: 0, lastReminderAt: 0, alertSent: false });
      ops.push([doc(db, 'attendance', id), data]); count++;
    }
  }
  for (const r of list) ops.push([doc(db, 'offdays', `${r.date}_${r.sicil}`), null]);                  // çalışıyorsa izin kaydı kalmasın
  for (const o of offs) if (!o.types) ops.push([doc(db, 'offdays', `${o.date}_${o.sicil}`), { date: o.date, sicil: o.sicil, ad: o.ad || '', ...mgTag(o.sicil) }]);
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
  <div class="card" id="cardEdit"><h2>Vardiyayı Düzenle${scope() ? ' · ' + esc(storeName(scope())) : ''}</h2>
    <p class="hint">Her hücrede üstte giriş, altta çıkış saati var; <b>08</b> yazınca otomatik dakikaya geçer. Boş hücre = izin (B). Üstteki hazır butonlarla tek dokunuşta doldurup sonraki güne geçebilirsiniz. Yalnızca giriş için üst satırı doldurun. Onaylar korunur.</p>
    <div class="rowbtn"><label class="datebox">Hafta başlangıcı <input type="date" id="edWeek" value="${mondayOf(selDate)}"></label>
      <button class="btn light small" id="btnEdLoad">Yükle</button>
      <button class="btn light small" id="btnEdXlsx">Excel'e indir</button></div>
    <p class="hint">Yeni hafta için tarihi seçip <b>Yükle</b>'ye basın, <b>Tümünü ekle</b> ile çalışanları getirin ve saatleri yazın. Excel'e indir yalnızca yedek/rapor içindir.</p>
    <div id="edOut"></div></div>
  <div class="card"><h2>Vardiya Görselleri</h2>
    <p class="hint">Yüklediğiniz görsel, tüm çalışanlara "Haftalık Vardiya" olarak görünür. Aynı haftaya yeniden yüklerseniz eskisinin yerine geçer.</p>
    <div class="form"><label>Hafta başlangıcı (Pazartesi)<input type="date" id="imgWeek" value="${mondayOf(selDate)}"></label>
      <label>Görsel<input type="file" id="imgFile" accept="image/*"></label><button class="btn" id="btnImgPub">Yayınla</button></div>
    <div id="imgList" class="imglist"></div></div>
  <div class="card"><h2>Seçili gün: ${fmtDate(selDate)}</h2>
    <div class="rowbtn"><button class="btn" id="btnExp">Excel'e aktar</button><button class="btn danger" id="btnDelDay">Bu günün vardiyasını sil</button></div></div>`;

  $('#edWeek').onchange = loadEditor; $('#btnEdLoad').onclick = loadEditor; loadEditor();
  $('#btnEdXlsx').onclick = exportWeekXlsx;
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
    if (!rows.length && !offRows.length) return toast('Bu günde kayıt yok.');
    if (!confirm(`${fmtDate(selDate)} tarihli ${rows.length} kayıt ve ${offRows.length} izin silinsin mi?`)) return;
    const bt = writeBatch(db); rows.forEach(r => bt.delete(doc(db, 'attendance', r.id))); offRows.forEach(o => bt.delete(doc(db, 'offdays', `${selDate}_${o.sicil}`)));
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
    snap.forEach(d => { const r = d.data(); if (!inScope(r)) return; let p = m.get(r.sicil); if (!p) { p = { sicil: r.sicil, ad: r.ad, cells: Array(7).fill(null) }; m.set(r.sicil, p); }
      const i = dates.indexOf(r.date); p.cells[i] ??= {}; p.cells[i][r.type] = r.planned; });
    const list = [...m.values()].sort(cmpPeople);
    renderEditor(ws, dates, list, await loadMesai(ws));
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
const cellTxt = c => !c ? 'B' : `${c.giris || ''}-${c.cikis || ''}`;

/* --- Mesai hesabı: brüt süreden mola düşülür (kurallar Ayarlar'da). Varsayılan: brüt ≤6 sa → 30 dk, 6–9 sa → 1 sa, ≥9 sa → 1,5 sa --- */
const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
function grossOf(v) {                                                        // "08:45-16:45" -> brüt saat; yalnızca giriş / izin -> null
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(v || ''); if (!m) return null;
  const a = toMin(m[1]); let b = toMin(m[2]); if (a === null || b === null) return null;
  if (b <= a) b += 1440; return (b - a) / 60;
}
const breakOf = g => g <= S.mola1Es ? S.mola1 : g < S.mola2Es ? S.mola2 : S.mola3;
const autoNet = v => { const g = grossOf(v); return g === null ? null : Math.max(0, g - breakOf(g)); };
const fmtH = h => String(Math.round(h * 100) / 100).replace('.', ',');
const numH = s => { const x = parseFloat(String(s).replace(',', '.')); return isFinite(x) && x >= 0 && x <= 24 ? x : null; };
function weekSum(vals, dates, ovDoc) {                                       // elle girilen (aynı vardiya için) değer, otomatiğin önüne geçer
  let sum = 0, n = 0, man = false;
  vals.forEach((v, i) => { const o = ovDoc?.d?.[dates[i]], a = autoNet(v);
    if (o && o.p === v && typeof o.h === 'number' && a !== null) { sum += o.h; n++; man = true; } else if (a !== null) { sum += a; n++; } });
  return { sum, n, man };
}
async function loadMesai(ws) {                                               // hafta için elle düzeltmeler: sicil -> {d:{tarih:{h,p}}}
  const m = new Map();
  try {
    const sn = await getDocs(query(collection(db, 'mesai'), where('week', '==', ws), ...(scope() ? [where('magaza', '==', scope())] : [])));
    sn.forEach(d => { const x = d.data(); if (inScope(x)) m.set(x.sicil, x); });
  } catch { }
  return m;
}

/* --- Saat hücresi: üstte giriş, altta çıkış (xx.xx); 2 hane yazınca sonraki kutuya geçer; üstte hazır vardiya butonları --- */
const QUICK = [['08.45-16.45', '08:45-16:45'], ['11.15-21.15', '11:15-21:15'], ['14.15-21.15', '14:15-21:15']];
const tFields = v => { const m = String(v ?? '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(?:(\d{1,2})[:.](\d{2}))?/);
  return m ? [pad(m[1]), m[2], m[3] != null ? pad(m[3]) : '', m[4] || ''] : ['', '', '', '']; };
const tJoin = f => { const l = f[0] || f[1] ? `${f[0]}:${f[1]}` : '', r = f[2] || f[3] ? `${f[2]}:${f[3]}` : ''; return l || r ? `${l}-${r}` : ''; };
function tcell(val, cls = '', attrs = '', isb = false) {
  const f = tFields(val), tp = i => `<input class="tp" data-i="${i}" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="xx" value="${f[i]}" aria-label="${i < 2 ? 'Giriş' : 'Çıkış'} ${i % 2 ? 'dakika' : 'saat'}">`;
  return `<div class="tcw${isb ? ' isb' : ''}${tJoin(f) === '08:45-21:15' ? ' full' : ''}"><span class="bmark" title="Düzenlemek için dokunun">B</span><input type="hidden" class="cell ${cls}" value="${esc(tJoin(f))}" ${attrs}><div class="tl">${tp(0)}<i>.</i>${tp(1)}</div><div class="tl">${tp(2)}<i>.</i>${tp(3)}</div></div>`;
}
const qbarHTML = () => `<div class="qbar"><span class="qlbl">Bir hücreye dokunun</span><div class="qbtns">${QUICK.map(([l, v]) => `<button type="button" class="qbtn" data-q="${v}">${l}</button>`).join('')}<button type="button" class="qbtn qoff" data-q="">B · izin</button></div></div>`;
function wireTime(box) {
  if (box._tw) return; box._tw = true;
  const isTp = el => el?.classList?.contains('tp');
  const tps = () => [...box.querySelectorAll('.tp')];
  const focusAt = el => { if (el) { el.focus(); try { el.select(); } catch { } } };
  const next = el => { const a = tps(); focusAt(a[a.indexOf(el) + 1]); };
  const prev = el => { const a = tps(); focusAt(a[a.indexOf(el) - 1]); };
  const sync = w => { const h = w.querySelector('.cell'); h.value = tJoin([...w.querySelectorAll('.tp')].map(x => x.value)); if (h.value) w.classList.remove('isb'); w.classList.toggle('full', h.value === '08:45-21:15'); h.dispatchEvent(new Event('input')); };
  const setLabel = t => {
    const td = t.closest('td'), tr = td.parentElement, idx = [...tr.children].indexOf(td), th = box.querySelectorAll('thead th')[idx];
    const name = tr.querySelector('b')?.textContent || tr.querySelector('.nm-in')?.value || '';
    box.querySelector('.qlbl').textContent = `${name} · ${(th?.innerText || '').replace(/\s+/g, ' ')}`;
  };
  box.addEventListener('focusin', e => { if (!isTp(e.target)) return; box._active = e.target.closest('.tcw'); try { e.target.select(); } catch { } setLabel(e.target); });
  box.addEventListener('focusout', e => { const t = e.target; if (isTp(t) && t.value.length === 1) { t.value = '0' + t.value; sync(t.closest('.tcw')); } });
  box.addEventListener('input', e => {
    const t = e.target; if (!isTp(t)) return;
    let v = t.value.replace(/\D/g, '').slice(0, 2); const isH = +t.dataset.i % 2 === 0;
    if (v.length === 1) { if (+v > (isH ? 2 : 5)) v = '0' + v; }                                 // 8 → 08, 7 → 07
    else if (v.length === 2) v = String(Math.min(+v, isH ? 23 : 59)).padStart(2, '0');
    t.value = v; sync(t.closest('.tcw'));
    if (v.length === 2) next(t);
  });
  box.addEventListener('keydown', e => {
    const t = e.target; if (!isTp(t)) return;
    if (e.key === 'Backspace' && t.value === '') { e.preventDefault(); prev(t); return; }
    if (['.', ':', ',', ' ', '-', 'Enter'].includes(e.key)) { e.preventDefault(); if (t.value === '' && e.key !== 'Enter') return; if (t.value.length === 1) { t.value = '0' + t.value; sync(t.closest('.tcw')); } next(t); }
  });
  box.addEventListener('mousedown', e => { if (e.target.closest('.qbtn')) e.preventDefault(); });   // klavye kapanmasın
  box.addEventListener('click', e => {
    const bm = e.target.closest('.bmark'); if (bm) { const w = bm.closest('.tcw'); w.classList.remove('isb'); focusAt(w.querySelector('.tp')); return; }
    const b = e.target.closest('.qbtn'); if (!b) return;
    const w = box._active; if (!w || !w.isConnected) return toast('Önce bir saat hücresine dokunun.');
    const f = tFields(b.dataset.q);
    w.querySelectorAll('.tp').forEach((x, i) => { x.value = f[i]; }); sync(w);
    if (!b.dataset.q) w.classList.add('isb');                                                    // izin: hücrede yalnızca B görünür
    const a = [...box.querySelectorAll('.tcw')]; focusAt(a[a.indexOf(w) + 1]?.querySelector('.tp'));   // sonraki güne geç
  });
}


function renderEditor(ws, dates, list, ovs = new Map()) {
  const out = $('#edOut'), DN = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  list.forEach(p => { p.orig ??= p.cells.map(cellTxt); });          // ilk yüklenen değerler sabit kalsın (değişiklik tespiti için)
  const addable = () => employees.filter(e => !list.some(p => p.sicil === e.sicil) && e.aktif !== false && (e.magaza || '') === scope());
  const draw = () => {
    list.forEach(p => { p.orig ??= p.cells.map(cellTxt); });
    out.innerHTML = `${qbarHTML()}<div class="tw ocr"><table><thead><tr><th>Çalışan</th>${DN.map((d, i) => `<th>${d}<br><small>${fmtDate(dates[i]).slice(0, 5)}</small></th>`).join('')}<th>Toplam<br><small>saat</small></th></tr></thead><tbody>${
      list.map((p, ri) => `<tr data-r="${ri}"><td><b>${esc(p.ad)}</b><br><small class="hint">${esc(p.sicil)}</small></td>${
        p.cells.map((c, ci) => { const t = cellTxt(c), v = t === 'B' ? '' : t, ov = p.orig[ci] === 'B' ? '' : p.orig[ci];
          return `<td>${tcell(v, v === '' ? 'off' : v !== ov ? 'chg' : '', `data-orig="${esc(ov)}"`, v === '' && (!p.fresh || p.bm?.[ci]))}</td>`; }).join('')}<td class="tot"><button type="button" class="totbtn" data-tot="${ri}" title="Mola ve süreleri göster / elle düzelt"><b>–</b></button></td></tr>`).join('') ||
      `<tr><td colspan="9" class="empty">Bu hafta için kayıt yok. Aşağıdan kişi ekleyip saat girebilirsiniz.</td></tr>`}</tbody></table></div>
      <div class="rowbtn"><select id="edAdd" style="max-width:260px"><option value="">+ Kişi ekle…</option>${addable().map(e => `<option value="${esc(e.sicil)}">${esc(e.ad)} (${esc(e.sicil)})</option>`).join('')}</select>
      <button class="btn light" id="edAddAll">Tümünü ekle</button>
      <button class="btn" id="btnEdSave">Değişiklikleri kaydet</button></div>`;
    $('#edAdd').onchange = ev => { const e = employees.find(x => x.sicil === ev.target.value); if (!e) return;
      keep(); list.push({ sicil: e.sicil, ad: e.ad, fresh: true, cells: Array(7).fill(null) }); list.sort(cmpPeople); draw(); };
    $('#edAddAll').onclick = () => { const a = addable(); if (!a.length) return toast('Eklenecek çalışan kalmadı.');
      keep(); a.forEach(e => list.push({ sicil: e.sicil, ad: e.ad, fresh: true, cells: Array(7).fill(null) })); list.sort(cmpPeople); draw(); };
    out.querySelectorAll('.cell').forEach(inp => inp.oninput = () => {
      inp.className = 'cell' + (parseCell(inp.value, true) === null ? ' err' : inp.value.trim() !== inp.dataset.orig ? ' chg' : /^b?$/i.test(inp.value.trim()) ? ' off' : ''); });
    $('#btnEdSave').onclick = save;
    out.querySelectorAll('.cell').forEach(inp => inp.addEventListener('input', () => updTot(inp.closest('tr'))));
    out.querySelectorAll('.totbtn').forEach(b => b.onclick = () => openMesai(+b.dataset.tot));
    out.querySelectorAll('tbody tr[data-r]').forEach(updTot);
    out._active = null; wireTime(out);
  };
  const cellVals = tr => [...tr.querySelectorAll('.cell')].map(c => c.value.trim());
  const updTot = tr => { if (!tr) return; const p = list[+tr.dataset.r], t = weekSum(cellVals(tr), dates, ovs.get(p.sicil)), b = tr.querySelector('.totbtn');
    b.querySelector('b').textContent = t.n ? fmtH(t.sum) : '–'; b.classList.toggle('man', t.man); };
  function openMesai(ri) {
    const p = list[ri], tr = out.querySelector(`tbody tr[data-r="${ri}"]`), vals = cellVals(tr), od = ovs.get(p.sicil)?.d || {};
    let dlg = $('#dlgMesai'); if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlgMesai'; document.body.appendChild(dlg); }
    const rowsH = dates.map((d, i) => { const v = vals[i], g = grossOf(v), br = g === null ? null : breakOf(g), a = autoNet(v), o = od[d] && od[d].p === v ? od[d].h : '';
      return `<tr><td>${DN[i]} ${fmtDate(d).slice(0, 5)}</td><td>${v ? esc(v.replace(/:/g, '.')) : 'B'}</td><td>${g === null ? '–' : fmtH(g)}</td><td>${br === null ? '–' : fmtH(br)}</td><td>${a === null ? '–' : fmtH(a)}</td>
        <td><input class="mh" data-d="${d}" data-p="${esc(v)}" data-a="${a === null ? '' : a}" inputmode="decimal" placeholder="${a === null ? '' : fmtH(a)}" value="${o === '' ? '' : fmtH(o)}"${a === null ? ' disabled' : ''}></td></tr>`; }).join('');
    dlg.innerHTML = `<form method="dialog" class="mesai" onsubmit="return false"><h2>${esc(p.ad)} · haftalık mesai</h2>
      <p class="hint">Mola otomatik düşülür. "Elle" kutusunu doldurursanız o gün için yazdığınız değer geçerli olur; boş bırakırsanız otomatik hesap kullanılır. Vardiya saati değişirse elle değer silinir.</p>
      <div class="tw"><table><tr><th>Gün</th><th>Vardiya</th><th>Brüt</th><th>Mola</th><th>Otomatik</th><th>Elle</th></tr>${rowsH}</table></div>
      <p class="mtot">Toplam: <b id="mTot">–</b> saat</p>
      <div class="rowbtn"><button type="button" class="btn light" id="mClose">Kapat</button><button type="button" class="btn light" id="mReset">Otomatiğe dön</button><button type="button" class="btn" id="mSave">Kaydet</button></div></form>`;
    const inputs = [...dlg.querySelectorAll('.mh')];
    const recalc = () => { let sum = 0, n = 0; inputs.forEach(inp => { if (inp.disabled) return; const m = inp.value.trim() === '' ? null : numH(inp.value), a = +inp.dataset.a; sum += m ?? a; n++; }); dlg.querySelector('#mTot').textContent = n ? fmtH(sum) : '–'; };
    inputs.forEach(inp => inp.oninput = recalc); recalc();
    dlg.querySelector('#mClose').onclick = () => dlg.close();
    dlg.querySelector('#mReset').onclick = () => { inputs.forEach(inp => inp.value = ''); recalc(); };
    dlg.querySelector('#mSave').onclick = async ev => {
      const d = {}; let bad = 0;
      inputs.forEach(inp => { if (inp.disabled || inp.value.trim() === '') return; const h = numH(inp.value); if (h === null) { bad++; return; } if (Math.abs(h - +inp.dataset.a) > 1e-9) d[inp.dataset.d] = { h, p: inp.dataset.p }; });
      if (bad) return toast('Elle yazılan değerler 0–24 arası sayı olmalı (örn. 7,5).');
      ev.target.disabled = true;
      try {
        const id = `${ws}_${p.sicil}`, mg = employees.find(x => x.sicil === p.sicil)?.magaza || '';
        if (Object.keys(d).length) { await setDoc(doc(db, 'mesai', id), { week: ws, sicil: p.sicil, magaza: mg, d }); ovs.set(p.sicil, { week: ws, sicil: p.sicil, magaza: mg, d }); }
        else { await deleteDoc(doc(db, 'mesai', id)); ovs.delete(p.sicil); }
        updTot(tr); dlg.close(); toast('Mesai kaydedildi.');
      } catch (err) { toast('Kaydedilemedi: ' + err.message); } finally { ev.target.disabled = false; }
    };
    dlg.showModal();
  }
  const keep = () => out.querySelectorAll('tbody tr[data-r]').forEach(tr => { const p = list[+tr.dataset.r]; p.bm = [...tr.querySelectorAll('.tcw')].map(w => w.classList.contains('isb'));
    [...tr.querySelectorAll('.cell')].forEach((c, i) => { const v = parseCell(c.value, true); if (v && v !== 'off') p.cells[i] = { giris: v.giris, cikis: v.cikis }; else if (v === 'off') p.cells[i] = null; }); });
  const save = async ev => {
    const upd = [], offs = []; let bad = 0;
    out.querySelectorAll('tbody tr[data-r]').forEach(tr => { const p = list[+tr.dataset.r], emp = employees.find(x => x.sicil === p.sicil);
      tr.querySelectorAll('.cell').forEach((c, i) => {
        if (c.value.trim() === c.dataset.orig) return;
        const v = parseCell(c.value, true), date = dates[i];
        if (v === null) { c.classList.add('err'); bad++; }
        else if (v === 'off') offs.push({ date, sicil: p.sicil, ad: p.ad });
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

/* --- Haftalık vardiyayı Excel'e indir (yalnızca indirme; yükleme yok) --- */
const DN3 = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
async function fetchWeekMap(dates) {
  const cur = new Map();                       // "tarih|sicil" -> {giris, cikis, ad}
  for (let i = 0; i < dates.length; i += 30) {
    const snap = await getDocs(query(collection(db, 'attendance'), where('date', 'in', dates.slice(i, i + 30))));
    snap.forEach(d => { const r = d.data(); if (!inScope(r)) return; const k = r.date + '|' + r.sicil; const c = cur.get(k) || { ad: r.ad }; c[r.type] = r.planned; cur.set(k, c); });
    const so = await getDocs(query(collection(db, 'offdays'), where('date', 'in', dates.slice(i, i + 30))));
    so.forEach(d => { const r = d.data(); if (!inScope(r)) return; const k = r.date + '|' + r.sicil; const c = cur.get(k) || { ad: r.ad }; c.off = true; cur.set(k, c); });
  }
  return cur;
}
async function exportWeekXlsx() {
  const wk = $('#edWeek').value; if (!wk) return toast('Hafta seçin.');
  try {
    const ws = mondayOf(wk), dates = [...Array(7)].map((_, i) => addDays(ws, i)), X = await loadXLSX(), cur = await fetchWeekMap(dates);
    const bySic = new Map(); employees.filter(e => e.aktif !== false && (e.magaza || '') === scope()).forEach(e => bySic.set(e.sicil, { ad: e.ad, tel: e.telefon || '' }));
    for (const k of cur.keys()) { const sc = k.split('|')[1]; if (!bySic.has(sc)) bySic.set(sc, { ad: cur.get(k).ad, tel: '' }); }
    const list = [...bySic].sort((a, b) => cmpPeople({ sicil: a[0], ad: a[1].ad }, { sicil: b[0], ad: b[1].ad }));
    const mes = await loadMesai(ws), aoa = [['Sicil', 'Ad Soyad', 'Telefon', ...dates.map((d, i) => `${DN3[i]} ${fmtDate(d)}`), 'Toplam (saat)']];
    for (const [sc, e] of list) { const vv = dates.map(d => { const c = cur.get(d + '|' + sc); return c && c.giris && c.cikis ? `${c.giris}-${c.cikis}` : ''; });
      aoa.push([sc, e.ad, e.tel, ...dates.map(d => { const c = cur.get(d + '|' + sc); return c && (c.giris || c.cikis) ? `${c.giris || ''}-${c.cikis || ''}` : 'B'; }), weekSum(vv, dates, mes.get(sc)).sum]); }
    const sheet = X.utils.aoa_to_sheet(aoa); sheet['!cols'] = [{ wch: 9 }, { wch: 24 }, { wch: 14 }, ...dates.map(() => { return { wch: 14 }; }), { wch: 13 }];
    const help = X.utils.aoa_to_sheet([['Nasıl düzenlenir?'], ['Hücre biçimi: 08:45-16:45  (giriş-çıkış)'], ['Yalnızca giriş: 08:45-'], ['İzin: B yazın veya boş bırakın'],
      ['Yeni kişi eklemek için Sicil, Ad Soyad ve Telefon yazın.'], ['İlk satırdaki tarih başlıklarını değiştirmeyin.'], ['Düzenlediğiniz dosyayı panelden "Düzenlenmiş Excel\'i yükle" ile geri yükleyin.']]);
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, sheet, 'Vardiya'); X.utils.book_append_sheet(wb, help, 'Yardım');
    X.writeFile(wb, `vardiya-${ws}.xlsx`);
  } catch (e) { toast('İndirilemedi: ' + e.message); }
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
  await setDoc(doc(db, 'shiftImages', imgId(ws)), { weekStart: ws, store: scope(), data: url, w, h, createdAt: serverTimestamp(), by: me?.ad || '' });
  return ws;
}
async function loadImgList() {
  const el = $('#imgList'); if (!el) return;
  try {
    const sc = scope();
    const snap0 = await getDocs(sc ? query(collection(db, 'shiftImages'), where('store', '==', sc)) : query(collection(db, 'shiftImages'), orderBy('weekStart', 'desc'), limit(40)));
    if (!el.isConnected) return;
    const snap = { docs: snap0.docs.filter(d => (d.data().store || '') === sc).sort((a, b) => b.data().weekStart.localeCompare(a.data().weekStart)).slice(0, 8) }; snap.empty = !snap.docs.length;
    el.innerHTML = snap.empty ? '<p class="empty">Henüz görsel yüklenmedi.</p>' : snap.docs.map(d => { const x = d.data(); return `<figure>
      <img src="${x.data}" alt="" data-view="${esc(d.id)}"><figcaption><b>${fmtDate(x.weekStart).slice(0, 5)} – ${fmtDate(addDays(x.weekStart, 6)).slice(0, 5)}</b>
      <button class="btn danger small" data-delimg="${esc(d.id)}">Sil</button></figcaption></figure>`; }).join('');
    el.onclick = async ev => {
      const v = ev.target.dataset.view, dl = ev.target.dataset.delimg;
      if (v) openImg(ev.target.src);
      if (dl && confirm('Bu haftanın görseli silinsin mi?')) { await deleteDoc(doc(db, 'shiftImages', dl)).catch(x => toast(x.message)); loadImgList(); if (dl === imgId(mondayOf(selDate))) watchWeek(); }
    };
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

const imgFromFile = f => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Görsel açılamadı')); i.src = URL.createObjectURL(f); });

/* --- Çalışanlar --- */
function tabCalisan(b) {
  b.innerHTML = `
  <div class="card"><h2>Çalışan Ekle / Güncelle</h2>
    <form class="form" id="frmEmp">
      <label>Sicil No<input id="eSicil" required></label>
      <label>Ad Soyad<input id="eAd" required></label>
      <label>Telefon<input id="eTel" inputmode="tel" placeholder="05xx xxx xx xx"></label>
      <label>Rol<select id="eRol"><option value="">Otomatik (isme göre)</option><option value="ms">MS</option><option value="msy">MSY</option><option value="gt">GT</option><option value="per">Personel</option></select></label>
      <label>Sıra (personel için)<input id="eSira" type="number" min="0" max="99" placeholder="1, 2, 3…"></label>
      <label>Mağaza<select id="eMag"></select></label>
      <button class="btn">Kaydet</button>
    </form></div>
  <div class="card"><h2>Mağazalar</h2>
    <p class="hint">Mağaza eklediğinizde, o mağazanın çalışanları yalnızca kendi mağazalarının panosunu görür. Mevcut ekibiniz "Atatürk Cd." ekibidir ve karışmaz.</p>
    <form class="form" id="frmStore"><label>Yeni mağaza adı<input id="stName" placeholder="Örn. Larende"></label><button class="btn light">Mağaza ekle</button></form></div>
  <div class="card"><h2>Toplu Ekle</h2>
    <p class="hint">Her satıra bir kişi: <b>sicil;ad soyad;telefon;rol;mağaza</b> (rol: ms, msy, gt veya per; mağaza boşsa Atatürk Cd. ekibine eklenir, yeni mağaza adı otomatik oluşturulur). Excel'den kopyalayıp yapıştırırsanız sekme ayracı da kabul edilir.</p>
    <textarea id="bulk" rows="5" placeholder="1001;Ayşe Yılmaz;05321234567"></textarea>
    <div class="rowbtn"><button class="btn" id="btnBulk">Ekle / Güncelle</button></div></div>
  <div class="card"><h2>Çalışanlar</h2><input id="eSearch" placeholder="Ara…"><div class="tw" id="empList"></div>
    <p class="hint">"Bot" sütunu, çalışanın Telegram botuna telefonunu paylaşıp paylaşmadığını gösterir. Bağlı olmayana mesaj gitmez.</p></div>`;
  $('#frmEmp').onsubmit = async e => {
    e.preventDefault();
    const sicil = cleanSicil($('#eSicil').value), cur = employees.find(x => x.sicil === sicil);
    const data = { sicil, ad: $('#eAd').value.trim(), telefon: $('#eTel').value.trim(), tel10: tel10($('#eTel').value), aktif: true };
    if (!cur) Object.assign(data, { isAdmin: false, notify: false });
    data.magaza = $('#eMag').value;
    if (!cur?.token) data.token = newToken();
    if ($('#eRol').value) data.rol = $('#eRol').value;
    if ($('#eSira').value !== '') data.sira = Math.max(0, Math.min(99, +$('#eSira').value || 0));
    if (data.rol && data.sira === undefined && !cur?.rol) data.sira = guessRole(data.ad).sira;
    try { await setDoc(doc(db, 'employees', sicil), data, { merge: true }); e.target.reset(); toast('Kaydedildi.'); } catch (err) { toast(err.message); }
  };
  $('#btnBulk').onclick = async () => {
    const lines = $('#bulk').value.split(/\n/).map(l => l.split(/[;\t]/).map(x => x.trim())).filter(a => a[0]);
    if (!lines.length) return toast('Satır yok.');
    const bt = writeBatch(db); let n = 0; const stNew = {}, cnt = {};
    for (const [sc, ad, tel, rl, mg] of lines) {
      const sicil = cleanSicil(sc); if (!sicil || !ad) continue;
      const cur = employees.find(x => x.sicil === sicil), r = fold(rl), mgName = (mg || '').trim(), mgId = slug(mgName);
      const d = { sicil, ad, telefon: tel || '', tel10: tel10(tel), aktif: true };
      if (mgId) { d.magaza = mgId; stNew[mgId] = mgName; }
      if (!cur) Object.assign(d, { isAdmin: false, notify: !!mgId && (r === 'ms' || r === 'msy') });       // mağazada MS/MSY bildirim alır
      if (!cur?.token) d.token = newToken();
      if (ROLES[r]) { d.rol = r; if (mgId) d.sira = r === 'ms' ? 0 : r === 'msy' ? 1 : 1 + (cnt[mgId] = (cnt[mgId] || 0) + 1); else if (!cur?.rol) d.sira = guessRole(ad).sira; }
      bt.set(doc(db, 'employees', sicil), d, { merge: true }); n++;
    }
    try {
      if (Object.keys(stNew).length) bt.set(doc(db, 'meta', 'stores'), { s: { ...STORES, ...stNew } }, { merge: true });
      await bt.commit(); $('#bulk').value = ''; toast(`${n} çalışan kaydedildi.`);
    } catch (err) { toast(err.message); }
  };
  $('#frmStore').onsubmit = async e => {
    e.preventDefault(); const nm = $('#stName').value.trim(), id = slug(nm); if (!id) return;
    try { await setDoc(doc(db, 'meta', 'stores'), { s: { ...STORES, [id]: nm } }, { merge: true }); $('#stName').value = ''; toast('Mağaza eklendi.'); } catch (err) { toast(err.message); }
  };
  $('#eSearch').oninput = renderEmpList;
  renderStoreSel(); renderEmpList();
}
function renderEmpList() {
  const el = $('#empList'); if (!el) return;
  const q = norm($('#eSearch')?.value || '');
  const list = employees.filter(e => !q || norm(e.ad + e.sicil + e.telefon + storeName(e.magaza)).includes(q));
  const rsel = e => `<select class="rsel r-${roleOf(e.sicil)}" data-rol="${esc(e.sicil)}">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}"${roleOf(e.sicil) === k ? ' selected' : ''}>${v.t}</option>`).join('')}</select>`;
  const groups = new Map(); for (const e of list) { const k = e.magaza || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const keys = ['', ...Object.keys(STORES), ...[...groups.keys()].filter(k => k && !(k in STORES))].filter(k => groups.has(k));
  const rowH = e => `<tr><td>${esc(e.sicil)}</td><td>${roleTag(e.sicil)}${esc(e.ad)}${e.isAdmin ? ' <span class="tag">yönetici</span>' : ''}</td><td>${rsel(e)}</td>
    <td><input class="sira-in" type="number" min="0" max="99" value="${metaMap.get(e.sicil)?.s ?? 99}" data-sira="${esc(e.sicil)}"></td><td>${esc(e.telefon)}</td>
    <td>${e.telegramChatId ? '<span class="tag ok">bağlı</span>' : '<span class="tag">yok</span>'}</td>
    <td><input type="checkbox" data-nt="${esc(e.sicil)}" ${e.notify ? 'checked' : ''} style="width:auto" title="Eksik giriş/çıkış uyarısı alsın"></td>
    <td><button class="btn light small" data-ed="${esc(e.sicil)}">Düzenle</button> <button class="btn danger small" data-del="${esc(e.sicil)}">Sil</button></td></tr>`;
  el.innerHTML = `<table><tr><th>Sicil</th><th>Ad</th><th>Rol</th><th>Sıra</th><th>Telefon</th><th>Bot</th><th>Uyarı</th><th></th></tr>${
    keys.map(k => `<tr class="grp"><td colspan="8">${k ? esc(storeName(k)) : 'Atatürk Cd. (mevcut ekip)'} · ${groups.get(k).length} kişi</td></tr>` + groups.get(k).map(rowH).join('')).join('')}</table>`;
  el.onchange = async ev => {
    const t = ev.target;
    if (t.dataset.rol) await updateDoc(doc(db, 'employees', t.dataset.rol), { rol: t.value }).catch(x => toast(x.message));
    if (t.dataset.nt) await updateDoc(doc(db, 'employees', t.dataset.nt), { notify: t.checked }).catch(x => toast(x.message));
    if (t.dataset.sira) await updateDoc(doc(db, 'employees', t.dataset.sira), { sira: Math.max(0, Math.min(99, +t.value || 0)) }).catch(x => toast(x.message));
  };
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
    <p class="hint">Çalışanlar listesinden seçin. Şifre boş bırakılırsa <b>sicil no</b> olur (5 haneli sicil için sonuna 0 eklenir, girişte yine yalnızca sicili yazmanız yeter). Mağaza çalışanı yönetici olursa yalnızca kendi mağazasının vardiyasını yönetir.</p>
    <form class="form" id="frmAdm"><label>Çalışan<select id="aSel" required></select></label>
      <label>Şifre (isteğe bağlı)<input id="aPw" type="text" placeholder="boş = sicil no"></label><button class="btn">Yönetici yap</button></form>
    <div class="rowbtn"><button class="btn light" id="btnAdmStores">Tüm mağaza MS / MSY'lerini yönetici yap (şifre = sicil)</button></div></div>
  <div class="card"><h2>Yöneticiler</h2><div class="tw" id="admList"></div>
    <p class="hint">"Bildirim" açık olan yöneticilere, giriş/çıkış yapılmadığında Telegram'dan uyarı gider.</p></div>`;
  $('#frmAdm').onsubmit = async e => {
    e.preventDefault();
    const sicil = $('#aSel').value, pw = $('#aPw').value.trim() || pwOf(sicil), emp = employees.find(x => x.sicil === sicil);
    if (pw.length < 6) return toast('Şifre en az 6 karakter olmalı.');
    try {
      const st = await makeAdmin(sicil, pw, emp);
      $('#aPw').value = ''; toast(st === 'var' ? 'Bu sicil için hesap zaten var; yetki verildi, şifre değişmedi.' : 'Yönetici eklendi.');
    } catch (err) { toast('Eklenemedi: ' + (err.code || err.message)); }
  };
  $('#btnAdmStores').onclick = async ev => {
    const hasMgr = new Set(employees.filter(e => e.magaza && ['ms', 'msy'].includes(roleOf(e.sicil))).map(e => e.magaza));
    const todo = employees.filter(e => e.magaza && !e.isAdmin && (['ms', 'msy'].includes(roleOf(e.sicil)) || !hasMgr.has(e.magaza)));
    if (!todo.length) return toast('Yönetici yapılacak mağaza çalışanı yok.');
    if (!confirm(`${todo.length} kişi yönetici yapılsın mı? Şifreleri sicil numaralarıdır.`)) return;
    ev.target.disabled = true; let ok = 0, fail = 0;
    for (const e of todo) { try { await makeAdmin(e.sicil, pwOf(e.sicil), e); ok++; } catch { fail++; } }
    ev.target.disabled = false; toast(`${ok} kişi yönetici yapıldı` + (fail ? `, ${fail} kişide hata oldu.` : '.'));
  };
  renderAdminList();
}
async function makeAdmin(sicil, pw, emp) {
  let st = 'yeni';
  try {
    const sec = initializeApp(firebaseConfig, 'sec' + Date.now() + sicil), a = getAuth(sec);
    try { await createUserWithEmailAndPassword(a, emailOf(sicil), pw); }
    finally { await signOut(a).catch(() => { }); await deleteApp(sec); }
  } catch (err) { if (err.code !== 'auth/email-already-in-use') throw err; st = 'var'; }
  await updateDoc(doc(db, 'employees', sicil), emp?.magaza ? { isAdmin: true } : { isAdmin: true, notify: true });
  return st;
}
function renderAdminList() {
  const sel = $('#aSel'), el = $('#admList'); if (!sel || !el) return;
  sel.innerHTML = employees.filter(e => !e.isAdmin).map(e => `<option value="${esc(e.sicil)}">${esc(e.ad)} (${esc(e.sicil)})${e.magaza ? ' · ' + esc(storeName(e.magaza)) : ''}</option>`).join('');
  el.innerHTML = `<table><tr><th>Ad</th><th>Sicil</th><th>Mağaza</th><th>Bildirim</th><th></th></tr>${
    employees.filter(e => e.isAdmin).map(e => `<tr><td>${esc(e.ad)}</td><td>${esc(e.sicil)}</td><td>${esc(storeName(e.magaza))}</td>
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
    <p class="hint">Giriş/çıkış pencereleri ve hatırlatma değişiklikleri yalnızca bundan sonra yüklenen vardiyalara uygulanır.</p>
    <form class="form" id="frmSet">
      <label>Giriş: kaç dk önce başlasın<input type="number" id="s1" min="0" max="120" value="${S.girisOnce}"></label>
      <label>Giriş: kaç dk sonra bitsin<input type="number" id="s2" min="0" max="120" value="${S.girisSonra}"></label>
      <label>Çıkış: kaç dk önce başlasın<input type="number" id="s3" min="0" max="120" value="${S.cikisOnce}"></label>
      <label>Çıkış: kaç dk sonra bitsin<input type="number" id="s4" min="0" max="120" value="${S.cikisSonra}"></label>
      <label>Hatırlatma aralığı (dk)<input type="number" id="s5" min="1" max="60" value="${S.aralik}"></label>
      <h3 class="sub">Mola kuralları (mesai hesabı)</h3>
      <label>Brüt süre şu saate kadar (dahil)<input type="number" id="m1e" step="0.25" min="0" max="24" value="${S.mola1Es}"></label>
      <label>…mola (saat)<input type="number" id="m1" step="0.25" min="0" max="5" value="${S.mola1}"></label>
      <label>Brüt süre şu saatten kısa<input type="number" id="m2e" step="0.25" min="0" max="24" value="${S.mola2Es}"></label>
      <label>…mola (saat)<input type="number" id="m2" step="0.25" min="0" max="5" value="${S.mola2}"></label>
      <label>Daha uzun vardiyalarda mola (saat)<input type="number" id="m3" step="0.25" min="0" max="5" value="${S.mola3}"></label>
      <p class="hint">Örnek (varsayılan): 16.45–21.15 → brüt 4,5, mola 0,5, mesai 4. 13.15–21.15 → brüt 8, mola 1, mesai 7. 11.15–21.15 → brüt 10, mola 1,5, mesai 8,5. Mola kuralları anında geçerlidir.</p>
      <button class="btn">Kaydet</button></form></div>`;
  $('#frmSet').onsubmit = async e => {
    e.preventDefault();
    S = { girisOnce: +$('#s1').value, girisSonra: +$('#s2').value, cikisOnce: +$('#s3').value, cikisSonra: +$('#s4').value, aralik: +$('#s5').value,
      mola1Es: +$('#m1e').value, mola1: +$('#m1').value, mola2Es: +$('#m2e').value, mola2: +$('#m2').value, mola3: +$('#m3').value };
    try { await setDoc(doc(db, 'settings', 'main'), S); toast('Ayarlar kaydedildi.'); } catch (err) { toast(err.message); }
  };
}

/* ---------- Canlı sayaç (çevrimiçi) ve ziyaretçi sayısı ---------- */
// Her cihaz tek belge yazar (presence/{cid}); son 5 dk içinde nabız atanlar "çevrimiçi" sayılır. Cihaz ilk kez geldiğinde ziyaretçi sayacı 1 artar.
let cid = null, firstVisit = false;
try { cid = localStorage.getItem('takip_cid'); if (!cid) { cid = newToken().slice(0, 20); localStorage.setItem('takip_cid', cid); firstVisit = true; } }
catch { cid = newToken().slice(0, 20); }
async function pulse() {
  if (document.hidden) return;
  try { await setDoc(doc(db, 'presence', cid), { ms: Date.now() }); } catch { }
  try {
    const n = await getCountFromServer(query(collection(db, 'presence'), where('ms', '>', Date.now() - 300000)));
    const v = await getDoc(doc(db, 'meta', 'sayac'));
    $('#footLive').textContent = Math.max(1, n.data().count);
    $('#footVis').textContent = (v.exists() ? v.data().toplam || 0 : 0).toLocaleString('tr-TR');
  } catch { }
}
if (firstVisit) setDoc(doc(db, 'meta', 'sayac'), { toplam: increment(1) }, { merge: true }).catch(() => { }).finally(pulse); else pulse();
setInterval(pulse, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pulse(); });

/* ---------- Başlat ---------- */
restoreStaff(); renderHeader(); renderDash();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
