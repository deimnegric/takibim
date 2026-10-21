// Vardiya ekran görüntüsü (personel x gün tablosu) için OCR sonucu çözümleyici.
// Girdi: Tesseract kelime listesi [{text, conf, x0, y0, x1, y1}]. Çıktı: düzenlenebilir tablo.

const DAYS = ['pzt', 'sal', 'car', 'per', 'cum', 'cmt', 'paz'];
const DAY_LONG = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const MONTHS = ['oca', 'sub', 'mar', 'nis', 'may', 'haz', 'tem', 'agu', 'eyl', 'eki', 'kas', 'ara'];

export const norm = s => String(s ?? '').replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i').toLowerCase()
  .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let p = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n];
}

const MAPD = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' };
const TIME_RE = /^([0-9A-Za-z|]{1,2})[:.;,]([0-9A-Za-z|]{2})$/;

// "1:15" -> 11:15 (vardiya saatleri 05-23 arasındadır), "W:15" -> 11:15
export function fixTime(raw) {
  const m = String(raw).trim().match(TIME_RE); if (!m) return null;
  let [, h, mi] = m, fixed = false;
  const mm = [...mi].map(c => { if (/\d/.test(c)) return c; fixed = true; return MAPD[c] ?? '?'; }).join('');
  if (/\?/.test(mm) || +mm > 59) return null;
  let hh;
  if (h.length === 1) {
    if (/\d/.test(h) && h !== '1') hh = '0' + h; else { hh = '11'; fixed = true; }
  } else {
    hh = [...h].map(c => { if (/\d/.test(c)) return c; fixed = true; return MAPD[c] ?? '?'; }).join('');
    if (/\?/.test(hh)) { hh = '11'; fixed = true; }
  }
  if (+hh > 23) return null;
  if (+hh < 5) { hh = String(+hh + 10).padStart(2, '0'); fixed = true; } // 01:15 -> 11:15
  return { val: `${hh}:${mm}`, fixed, odd: !['00', '15', '30', '45'].includes(mm) };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function parseGrid(words, opts = {}) {
  const warnings = [];
  const W = words.map(w => ({ ...w, xc: (w.x0 + w.x1) / 2, yc: (w.y0 + w.y1) / 2, t: String(w.text).trim() })).filter(w => w.t);

  // 1) saat jetonları
  const times = [];
  for (const w of W) { const f = fixTime(w.t); if (f) times.push({ ...w, ...f }); }
  if (times.length < 4) return { rows: [], days: [], weekStart: null, warnings: ['Görselde saat okunamadı. Daha net/büyük bir görüntü deneyin.'] };

  // 2) satır geometrisi
  const byY = [...times].sort((a, b) => a.y0 - b.y0), lines = [];
  for (const t of byY) { const l = lines.at(-1); if (l && Math.abs(t.y0 - l.y) <= 8) { l.n++; l.y = (l.y * (l.n - 1) + t.y0) / l.n; } else lines.push({ y: t.y0, n: 1 }); }
  const ly = lines.map(l => l.y), dif = ly.slice(1).map((v, i) => v - ly[i]).filter(d => d > 12);
  const g = Math.min(...dif);
  const starts = [ly[0]]; for (let i = 1; i < ly.length; i++) if (ly[i] - ly[i - 1] > 1.6 * g) starts.push(ly[i]);
  const sd = starts.slice(1).map((v, i) => v - starts[i]);
  const minSd = Math.min(...sd);
  const P = sd.length ? median(sd.map(d => d / Math.max(1, Math.round(d / minSd)))) : g * 3.3;
  const y0 = median(starts.map(s => s - Math.round((s - starts[0]) / P) * P));
  const rowOf = y => Math.floor((y - y0 + 0.25 * P) / P);

  // 3) sütunlar (gün başlıkları)
  const minTimeX = Math.min(...times.map(t => t.x0));
  const topY = y0 - 0.3 * P;
  const heads = [];
  for (const w of W) {
    if (w.y0 >= topY || w.x0 < minTimeX - 40) continue;
    const n = norm(w.t); if (n.length < 2 || n.length > 4) continue;
    let best = -1, bd = 9;
    DAYS.forEach((d, i) => { const dd = lev(n, d); if (dd < bd) { bd = dd; best = i; } });
    if (bd <= 1) heads.push({ idx: best, xc: w.xc, yc: w.yc, d: bd });
  }
  const colBy = new Map();
  for (const h of heads) { const c = colBy.get(h.idx); if (!c || h.d < c.d) colBy.set(h.idx, h); }
  let cols;
  if (colBy.size === 7) cols = DAYS.map((_, i) => colBy.get(i));
  else {
    // yedek: saat jetonlarının x kümelerinden 7 sütun bul
    const xs = [...times].map(t => t.xc).sort((a, b) => a - b), cl = [];
    for (const x of xs) { const c = cl.at(-1); if (c && x - c.xc < 40) { c.n++; c.xc = (c.xc * (c.n - 1) + x) / c.n; } else cl.push({ xc: x, n: 1 }); }
    if (cl.length !== 7) return { rows: [], days: [], weekStart: null, warnings: [`Gün sütunları bulunamadı (${colBy.size}/7 başlık, ${cl.length} sütun). Görüntüyü haftanın 7 gününü içerecek şekilde kırpın.`] };
    cols = cl.map(c => ({ xc: c.xc })); warnings.push('Gün başlıkları okunamadı; sütunlar sırayla Pzt→Paz varsayıldı.');
  }
  const pitch = Math.min(...cols.slice(1).map((c, i) => c.xc - cols[i].xc));
  const colOf = x => { let bi = -1, bd = 1e9; cols.forEach((c, i) => { const d = Math.abs(x - c.xc); if (d < bd) { bd = d; bi = i; } }); return bd < 0.5 * pitch ? bi : -1; };

  // 4) tarih (ilk sütunun altındaki "5 Eki")
  let weekStart = null;
  const h0 = cols[0];
  if (h0.yc) {
    const near = W.filter(w => Math.abs(w.xc - h0.xc) < 0.45 * pitch && w.yc > h0.yc + 2 && w.y0 < y0 - 0.1 * P);
    const dayTok = near.find(w => /^\d{1,2}$/.test(w.t));
    const monTok = [...near].map(w => ({ w, n: norm(w.t) })).filter(o => o.n.length === 3)
      .map(o => ({ ...o, m: MONTHS.map(mo => lev(o.n, mo)) })).map(o => ({ ...o, i: o.m.indexOf(Math.min(...o.m)), d: Math.min(...o.m) })).filter(o => o.d <= 1)[0];
    if (dayTok && monTok) {
      const now = opts.year || new Date().getFullYear();
      for (const y of [now, now - 1, now + 1]) {
        const d = new Date(Date.UTC(y, monTok.i, +dayTok.t));
        if (d.getUTCDay() === 1) { weekStart = d.toISOString().slice(0, 10); break; }
      }
      if (!weekStart) warnings.push(`"${dayTok.t} ${monTok.w.t}" bir Pazartesi değil; hafta başlangıç tarihini elle seçin.`);
    } else warnings.push('Tarihler okunamadı; hafta başlangıç tarihini (Pazartesi) elle seçin.');
  }

  // 5) isim sütunu
  const nameLimit = cols[0].xc - 0.5 * pitch;
  const nameToks = W.filter(w => w.xc < nameLimit && w.y0 > topY + 0.2 * P && w.t.length >= 2);
  const solid = nameToks.filter(w => w.t.length >= 4 && w.conf >= 60);
  const nx = solid.length ? median(solid.map(w => w.x0)) : 0;
  const nameCol = nameToks.filter(w => w.x0 >= nx - 8 && /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(w.t));

  const nRows = Math.max(...times.map(t => rowOf(t.y0)), ...nameCol.map(w => rowOf(w.y0))) + 1;
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const toks = nameCol.filter(w => rowOf(w.y0) === r).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    if (!toks.length) { warnings.push(`${r + 1}. satırda isim okunamadı.`); }
    const top = toks.length ? toks[0].y0 : 0;
    const nm = toks.filter(w => w.y0 - top < 0.42 * P), tg = toks.filter(w => w.y0 - top >= 0.42 * P);
    const nameRaw = nm.map(w => w.t).join(' ').replace(/[….]+$/g, '').replace(/\s+/g, ' ').trim();
    const rowTop = y0 + r * P;
    const cells = cols.map((c, ci) => {
      const ts = times.filter(t => rowOf(t.y0) === r && colOf(t.xc) === ci).sort((a, b) => a.y0 - b.y0);
      if (ts.length === 0) {
        const pr = opts.probe ? opts.probe(c.xc - 0.3 * pitch, rowTop + 0.24 * P) : null;
        if (pr === 'blue') return { text: 'B', flag: '' };
        return { text: '', flag: 'err', note: pr === 'white' ? 'Okunamadı' : 'B mi?' };
      }
      if (ts.length === 1) return { text: ts[0].val + '-', flag: 'err', note: 'Tek saat okundu' };
      const [a, b] = ts, warn = a.fixed || b.fixed || a.odd || b.odd || a.conf < 80 || b.conf < 80 || ts.length > 2 || b.val <= a.val;
      return { text: `${a.val}-${b.val}`, flag: (b.val <= a.val || ts.length > 2) ? 'err' : warn ? 'warn' : '' };
    });
    if (toks.length || cells.some(c => c.text && c.text !== 'B')) rows.push({ nameRaw, tag: tg.map(w => w.t).join(' '), cells });
  }
  return { rows, days: DAY_LONG, weekStart, warnings };
}

// OCR adını çalışan listesiyle eşleştir (Türkçe karakter ve kısaltılmış soyad toleranslı)
export function matchEmployee(nameRaw, employees) {
  const n = norm(nameRaw); if (!n) return null;
  const toks = n.split(' ');
  let best = null, bs = 1e9;
  for (const e of employees) {
    const en = norm(e.ad), et = en.split(' ');
    let s = 0;
    for (const t of toks) s += Math.min(...et.map(x => lev(t, x.slice(0, Math.max(t.length, 2)))));
    s += Math.abs(toks.length - et.length) * 0.2;
    if (norm(et[0]) !== toks[0]) s += lev(toks[0], et[0]) > 1 ? 3 : 0.5;
    if (s < bs) { bs = s; best = e; }
  }
  const lim = Math.max(2, Math.floor(n.replace(/ /g, '').length / 4));
  return bs <= lim ? best : null;
}

// Hücre metni -> {giris,cikis} | 'off' | null (geçersiz)
export function parseCell(s) {
  const t = String(s ?? '').trim();
  if (!t || /^(b|off|izin|-|–)$/i.test(t)) return 'off';
  const m = t.match(/^(\d{1,2})[:.](\d{2})\s*[-–—\/]\s*(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const p = n => String(n).padStart(2, '0'), h1 = +m[1], m1 = +m[2], h2 = +m[3], m2 = +m[4];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { giris: `${p(h1)}:${m[2]}`, cikis: `${p(h2)}:${m[4]}` };
}
