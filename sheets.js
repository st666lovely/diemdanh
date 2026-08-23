'use strict';

/* Đọc sheet báo cáo duyệt rút / duyệt khuyến mãi qua Service Account.
   Chỉ ĐỌC, không ghi — quyền chia sẻ file để mức "Người xem" là đủ.

   Cột nhận diện là "MaNV" (mã nhân viên, ví dụ CS01). KHÔNG dùng mã cá nhân
   ở đây: sheet này cả team cùng xem, để mã cá nhân vào là lộ ngay và mất
   luôn tác dụng chống bấm hộ. */

const { google } = require('googleapis');
const logger = console;

const SHEET_ID  = process.env.REPORT_SHEET_ID  || '';
const SHEET_TAB = process.env.REPORT_SHEET_TAB || 'Nhập liệu';
const RANGE     = `${SHEET_TAB}!A1:Z5000`;
const TTL_MS    = Math.max(1, Number(process.env.REPORT_SHEET_TTL_MIN) || 10) * 60000;

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

function parseAmount(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
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

/* Bộ nhớ đệm: sheet đọc mỗi 10 phút, trừ khi ép làm mới */
let _cache = { at: 0, rows: [], error: null, headers: [] };

async function fetchRows(force = false) {
  if (!force && Date.now() - _cache.at < TTL_MS && !_cache.error) return _cache;
  if (!SHEET_ID) {
    _cache = { at: Date.now(), rows: [], headers: [], error: 'Chưa cấu hình REPORT_SHEET_ID' };
    return _cache;
  }

  try {
    const res = await client().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });

    const grid = res.data.values || [];
    if (!grid.length) {
      _cache = { at: Date.now(), rows: [], headers: [], error: 'Sheet rỗng' };
      return _cache;
    }

    // Dòng tiêu đề: dòng đầu tiên có từ 3 cột nhận diện được trở lên
    let hIdx = 0, best = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const hits = (grid[i] || []).filter((c) => ALIASES[norm(c)]).length;
      if (hits > best) { best = hits; hIdx = i; }
    }
    const headers = grid[hIdx] || [];
    const map = {};
    headers.forEach((h, i) => { const k = ALIASES[norm(h)]; if (k) map[k] = i; });

    const rows = [];
    for (let r = hIdx + 1; r < grid.length; r++) {
      const line = grid[r] || [];
      if (!line.some((c) => String(c ?? '').trim() !== '')) continue;

      const day = parseDay(line[map.date]);
      const emp = String(line[map.emp_code] ?? '').trim().toUpperCase();
      const approver = String(line[map.approver] ?? '').trim();
      if (!day || (!emp && !approver)) continue;      // dòng chưa điền xong thì bỏ qua

      rows.push({
        row: r + 1, day, emp_code: emp, approver,
        kind:   String(line[map.kind] ?? '').trim(),
        result: String(line[map.result] ?? '').trim(),
        brand:  String(line[map.brand] ?? '').trim(),
        reason: String(line[map.reason] ?? '').trim(),
        amount: parseAmount(line[map.amount]),
      });
    }

    _cache = { at: Date.now(), rows, headers, error: null, hasEmpCol: map.emp_code !== undefined };
    return _cache;

  } catch (e) {
    const msg = e.code === 403
      ? 'Service Account chưa được chia sẻ quyền xem file.'
      : e.code === 404 ? 'Không tìm thấy file, kiểm tra REPORT_SHEET_ID.'
      : e.message;
    logger.error('[sheet] đọc lỗi:', msg);
    // Giữ dữ liệu cũ nếu có, để một lần hỏng không chặn nhầm cả team
    _cache = { ..._cache, at: Date.now() - TTL_MS + 60000, error: msg };
    return _cache;
  }
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
    if (!byKey[k]) byKey[k] = { count: 0, amount: 0, approved: 0, rejected: 0 };
    byKey[k].count++;
    byKey[k].amount += r.amount;
    if (/duyệt/i.test(r.result) && !/không/i.test(r.result)) byKey[k].approved++;
    if (/từ chối/i.test(r.result)) byKey[k].rejected++;
  }
  return { byKey, error: c.error, fetched_at: c.at, total: c.rows.length };
}

function status() {
  return {
    configured: !!SHEET_ID,
    sheet_id: SHEET_ID ? SHEET_ID.slice(0, 8) + '…' : null,
    tab: SHEET_TAB,
    fetched_at: _cache.at || null,
    rows: _cache.rows.length,
    error: _cache.error,
    has_emp_col: _cache.hasEmpCol !== false,
    ttl_min: TTL_MS / 60000,
  };
}

module.exports = { fetchRows, countFor, summarize, status, parseDay, SHEET_ID, SHEET_TAB };
