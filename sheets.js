'use strict';

/* Đọc sheet báo cáo duyệt rút / duyệt khuyến mãi qua Service Account.
   Chỉ ĐỌC, không ghi — quyền chia sẻ file để mức "Người xem" là đủ.

   Cột nhận diện là "MaNV" (mã nhân viên, ví dụ CS01). KHÔNG dùng mã cá nhân
   ở đây: sheet này cả team cùng xem, để mã cá nhân vào là lộ ngay và mất
   luôn tác dụng chống bấm hộ. */

const { google } = require('googleapis');
const logger = console;

const TTL_MS = Math.max(1, Number(process.env.REPORT_SHEET_TTL_MIN) || 10) * 60000;

/* Nhiều file báo cáo cùng lúc. Khai trong REPORT_SHEETS, mỗi dòng một file:
     Tên hiển thị | spreadsheetId | Tên tab
   Có dòng ở BẤT KỲ file nào trong ngày là tính đã điền — vì mỗi ngày RISK
   chỉ phát sinh một hai loại việc, không phải cả ba. */
function parseSheetList() {
  const raw = (process.env.REPORT_SHEETS || '').trim();

  if (raw) {
    return raw.split(/[\n;]+/).map((line) => {
      const p = line.split('|').map((x) => x.trim());
      if (p.length < 2 || !p[1]) return null;
      return { name: p[0] || 'Báo cáo', id: p[1], tab: p[2] || 'Nhập liệu' };
    }).filter(Boolean);
  }

  // Tương thích ngược với cấu hình một file
  const single = process.env.REPORT_SHEET_ID || '';
  return single
    ? [{ name: 'Báo cáo', id: single, tab: process.env.REPORT_SHEET_TAB || 'Nhập liệu' }]
    : [];
}

const SHEETS = parseSheetList();

/* Tên cột chấp nhận nhiều cách viết, bỏ dấu và khoảng trắng trước khi so */
const ALIASES = {
  ngay: 'date', ngaythang: 'date', date: 'date',
  manv: 'emp_code', ma: 'emp_code', manhanvien: 'emp_code', code: 'emp_code',
  nguoiduyet: 'approver', nguoixuly: 'approver', approver: 'approver',
  loai: 'kind', loaiyeucau: 'kind',
  ketqua: 'result', trangthai: 'result',
  sotien: 'amount', giatri: 'amount',
  brand: 'brand', thuonghieu: 'brand',
  lydo: 'reason', username: 'username',
};

const norm = (h) => String(h ?? '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/\s+/g, '');

/* Tên cột mỗi sheet mỗi khác: "Ngày", "Ngày phát hiện", "Ngày xử lý"...
   Nên sau khi dò tên chính xác thì dò tiếp theo tiền tố. */
const PREFIX_RULES = [
  [/^ngay/,                  'date'],       // Ngày, Ngày phát hiện, Ngày xử lý
  [/^(manv|manhanvien)/,     'emp_code'],
  [/^(nguoixuly|nguoiduyet|nguoithuchien)/, 'approver'],
  [/^sotien/,                'amount'],     // Số tiền, Số tiền liên quan
  [/^(ketqua|trangthai)/,    'result'],
  [/^loai/,                  'kind'],       // Loại, Loại gian lận
  [/^lydo/,                  'reason'],
];

function fieldOf(header) {
  const n = norm(header);
  if (ALIASES[n]) return ALIASES[n];
  for (const [re, field] of PREFIX_RULES) if (re.test(n)) return field;
  return null;
}

/* Ô ngày có thể là chuỗi "22/08/2026" hoặc số serial của Sheets */
function parseDay(v) {
  if (v == null || v === '') return null;

  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    // Serial của Google Sheets: ngày 1 = 31/12/1899
    const n = Number(v);
    if (n < 1 || n > 100000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/* Số tiền có thể là "1.266.000" (chấm ngăn nghìn kiểu VN), "1,266,000" (kiểu Anh),
   hoặc "1266000". Đoán theo dấu phân cách cuối cùng. */
function parseAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;

  let s = String(v).replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    // Có cả hai: dấu đứng sau là dấu thập phân
    if (lastDot > lastComma) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    // Chỉ có chấm: 3 số phía sau thì là ngăn nghìn kiểu VN
    s = /\.\d{3}$/.test(s) || /\.\d{3}\./.test(s) ? s.replace(/\./g, '') : s;
  } else if (lastComma >= 0) {
    s = /,\d{3}$/.test(s) || /,\d{3},/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

let _client = null;
function client() {
  if (_client) return _client;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Chưa cấu hình GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');

  const auth = new google.auth.JWT({
    email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  _client = google.sheets({ version: 'v4', auth });
  return _client;
}

/* Bộ nhớ đệm riêng cho từng file */
const _caches = new Map();          // id -> { at, rows, headers, error, name, tab }

function blank(sh, error) {
  return { at: Date.now(), rows: [], headers: [], error, name: sh.name, tab: sh.tab, id: sh.id };
}

async function fetchOne(sh, force = false) {
  const prev = _caches.get(sh.id);
  if (!force && prev && Date.now() - prev.at < TTL_MS && !prev.error) return prev;

  let _cache;
  try {
    const res = await client().spreadsheets.values.get({
      spreadsheetId: sh.id, range: `${sh.tab}!A1:Z5000`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });

    const grid = res.data.values || [];
    if (!grid.length) {
      _cache = blank(sh, 'Tab rỗng');
      _caches.set(sh.id, _cache);
      return _cache;
    }

    // Dòng tiêu đề: dòng đầu tiên có từ 3 cột nhận diện được trở lên
    let hIdx = 0, best = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const hits = (grid[i] || []).filter((c) => fieldOf(c)).length;
      if (hits > best) { best = hits; hIdx = i; }
    }
    const headers = grid[hIdx] || [];
    const map = {};
    // Cột nào khớp trước thì giữ, không để cột sau ghi đè cột đã nhận
    headers.forEach((h, i) => { const k = fieldOf(h); if (k && map[k] === undefined) map[k] = i; });

    if (map.date === undefined) {
      _cache = blank(sh, 'Không tìm thấy cột ngày. Đặt tên cột bắt đầu bằng "Ngày".');
      _caches.set(sh.id, _cache); return _cache;
    }
    if (map.emp_code === undefined) {
      _cache = blank(sh, 'Không tìm thấy cột MaNV. Thêm cột "MaNV" và điền mã vào mỗi dòng.');
      _caches.set(sh.id, _cache); return _cache;
    }

    const rows = [];
    for (let r = hIdx + 1; r < grid.length; r++) {
      const line = grid[r] || [];
      if (!line.some((c) => String(c ?? '').trim() !== '')) continue;

      const day = parseDay(line[map.date]);
      const emp = String(line[map.emp_code] ?? '').trim().toUpperCase();
      const approver = String(line[map.approver] ?? '').trim();
      if (!day || (!emp && !approver)) continue;      // dòng chưa điền xong thì bỏ qua

      rows.push({
        source: sh.name, sheet_id: sh.id,
        row: r + 1, day, emp_code: emp, approver,
        kind:   String(line[map.kind] ?? '').trim(),
        result: String(line[map.result] ?? '').trim(),
        brand:  String(line[map.brand] ?? '').trim(),
        reason: String(line[map.reason] ?? '').trim(),
        amount: parseAmount(line[map.amount]),
      });
    }

    _cache = { at: Date.now(), rows, headers, error: null, name: sh.name, tab: sh.tab, id: sh.id };
    _caches.set(sh.id, _cache);
    return _cache;

  } catch (e) {
    const msg = e.code === 403
      ? 'Chưa chia sẻ quyền xem cho Service Account.'
      : e.code === 404 ? 'Không tìm thấy file, kiểm tra lại ID.'
      : e.message;
    logger.error(`[sheet] "${sh.name}" đọc lỗi:`, msg);
    // Giữ dữ liệu cũ nếu có, để một lần hỏng không chặn nhầm cả team
    const keep = prev && prev.rows.length ? prev.rows : [];
    _cache = { at: Date.now() - TTL_MS + 60000, rows: keep, headers: [],
               error: msg, name: sh.name, tab: sh.tab, id: sh.id };
    _caches.set(sh.id, _cache);
    return _cache;
  }
}

/* Gộp dữ liệu từ mọi file đã khai */
async function fetchRows(force = false) {
  if (!SHEETS.length) {
    return { at: Date.now(), rows: [], sources: [],
             error: 'Chưa khai file nào trong REPORT_SHEETS' };
  }
  const list = await Promise.all(SHEETS.map((sh) => fetchOne(sh, force)));
  const rows = list.flatMap((c) => c.rows);

  // Chỉ báo lỗi tổng khi TOÀN BỘ file đều hỏng — một file lỗi không chặn cả team
  const allBad = list.every((c) => c.error);
  return {
    at: Math.max(...list.map((c) => c.at)),
    rows,
    sources: list.map((c) => ({ name: c.name, tab: c.tab, rows: c.rows.length, error: c.error })),
    error: allBad ? list.map((c) => `${c.name}: ${c.error}`).join(' · ') : null,
  };
}

/* Số dòng của một mã NV trong một ngày */
async function countFor(empCode, day, force = false) {
  const c = await fetchRows(force);
  if (!empCode) return { count: 0, error: c.error, rows: [] };
  const code = String(empCode).trim().toUpperCase();
  const rows = c.rows.filter((r) => r.emp_code === code && r.day === day);
  return { count: rows.length, rows, error: c.error, fetched_at: c.at };
}

/* Tổng hợp theo mã NV cho một khoảng ngày — dùng cho bảng theo dõi */
async function summarize(days, force = false) {
  const c = await fetchRows(force);
  const set = new Set(days);
  const byKey = {};
  for (const r of c.rows) {
    if (!set.has(r.day) || !r.emp_code) continue;
    const k = `${r.emp_code}|${r.day}`;
    if (!byKey[k]) byKey[k] = { count: 0, amount: 0, approved: 0, rejected: 0, sources: {} };
    byKey[k].count++;
    byKey[k].amount += r.amount;
    byKey[k].sources[r.source] = (byKey[k].sources[r.source] || 0) + 1;
    if (/duyệt/i.test(r.result) && !/không/i.test(r.result)) byKey[k].approved++;
    if (/từ chối/i.test(r.result)) byKey[k].rejected++;
  }
  return { byKey, error: c.error, fetched_at: c.at, total: c.rows.length, sources: c.sources };
}

function status() {
  const list = SHEETS.map((sh) => {
    const c = _caches.get(sh.id);
    return {
      name: sh.name, tab: sh.tab, id_short: sh.id.slice(0, 8) + '…',
      rows: c ? c.rows.length : 0,
      error: c ? c.error : 'Chưa đọc lần nào',
      fetched_at: c ? c.at : null,
    };
  });
  return {
    configured: SHEETS.length > 0,
    count: SHEETS.length,
    sheets: list,
    rows: list.reduce((n, x) => n + x.rows, 0),
    fetched_at: list.length ? Math.max(...list.map((x) => x.fetched_at || 0)) || null : null,
    error: SHEETS.length === 0 ? 'Chưa khai file nào trong REPORT_SHEETS'
         : (list.every((x) => x.error) ? 'Không đọc được file nào' : null),
    ttl_min: TTL_MS / 60000,
  };
}

/* Soi xem hệ thống ĐỌC ĐƯỢC gì trong một ngày — để đối chiếu khi nhân viên
   bảo đã điền mà hệ thống báo chưa thấy. */
async function inspectDay(day, force = false) {
  const c = await fetchRows(force);
  const cungNgay = c.rows.filter((r) => r.day === day);

  const theoMa = {};
  cungNgay.forEach((r) => {
    const k = r.emp_code || '(ô MaNV trống)';
    if (!theoMa[k]) theoMa[k] = { count: 0, sources: {} };
    theoMa[k].count++;
    theoMa[k].sources[r.source] = (theoMa[k].sources[r.source] || 0) + 1;
  });

  // Vài ngày gần đó, để biết cột Ngày có bị lệch không
  const cacNgay = {};
  c.rows.forEach((r) => { cacNgay[r.day] = (cacNgay[r.day] || 0) + 1; });

  return {
    day,
    total_rows: c.rows.length,
    rows_today: cungNgay.length,
    codes: Object.entries(theoMa)
      .map(([code, v]) => ({ code, count: v.count, sources: v.sources }))
      .sort((a, b) => b.count - a.count),
    recent_days: Object.entries(cacNgay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 8)
      .map(([d, n]) => ({ day: d, rows: n })),
    sources: c.sources,
    error: c.error,
    fetched_at: c.at,
  };
}

module.exports = { fetchRows, countFor, summarize, status, inspectDay, parseDay, parseAmount, SHEETS };
