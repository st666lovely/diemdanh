'use strict';

/* Đọc file lịch tháng dạng bảng: 1 dòng/người, mỗi ngày trong tháng 1 cột.
   Giữ nguyên quy tắc của bot Telegram đang chạy để hai bên dùng chung được một file:
     Ma/Ten/KhuVuc | 1 | 2 | 3 | ... | 31
   Ô ghi "HH:mm-HH:mm" (chấp nhận "12h00-22h00"), để trống hoặc OFF/Nghỉ = ngày nghỉ. */

const XLSX = require('xlsx');

const HEADER_ALIASES = {
  ma: 'key', key: 'key', manv: 'key', mand: 'key', code: 'key',
  ten: 'name', name: 'name', hoten: 'name', tennhanvien: 'name',
  khuvuc: 'location', location: 'location', chinhanh: 'location', quocgia: 'location',
  bophan: 'department', department: 'department', phongban: 'department',
  brand: 'brand', thuonghieu: 'brand',
};

const OFF_TOKENS = new Set(['off', 'nghi', 'x', '-', 'nn', 'null']);

function norm(h) {
  return String(h ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // bỏ dấu tiếng Việt
    .replace(/đ/g, 'd')
    .replace(/\s+/g, '');
}

/* Một ô giờ ca -> { off } | { start, end } | null (lỗi định dạng) */
function parseCell(raw) {
  // Excel tự đổi ô "12:00" thành số thập phân khi thiếu dấu gạch nối
  if (typeof raw === 'number') return { singleTimeOnly: true };

  const str = String(raw ?? '').trim();
  if (!str) return { off: true };
  if (OFF_TOKENS.has(norm(str))) return { off: true };

  const m = str.replace(/h/gi, ':').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hh = (a, b) => `${a.padStart(2, '0')}:${b}`;
  const start = hh(m[1], m[2]);
  const end = hh(m[3], m[4]);
  if (+m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) return null;
  return { start, end };
}

/**
 * @param buffer  nội dung file .xlsx / .xls / .csv
 * @param ym      'YYYY-MM' tháng áp dụng
 * @returns { ym, rows, errors, count }
 *          rows = [{ key, name, location, department, brand, days: { 'YYYY-MM-DD': {start,end} } }]
 */
function parseScheduleFile(buffer, ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) {
    return { ym, rows: [], errors: ['Thiếu tháng áp dụng (dạng YYYY-MM).'], count: 0 };
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const errors = [];
  if (grid.length < 2) return { ym, rows: [], errors: ['File rỗng hoặc chỉ có dòng tiêu đề.'], count: 0 };

  const [y, mo] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();

  const colMap = {};      // index -> tên trường
  const dayCols = [];     // { index, day }

  grid[0].forEach((h, i) => {
    const n = norm(h);
    if (HEADER_ALIASES[n]) { colMap[i] = HEADER_ALIASES[n]; return; }
    const d = parseInt(String(h).trim(), 10);
    if (!isNaN(d) && d >= 1 && d <= 31 && String(d) === String(h).trim()) dayCols.push({ index: i, day: d });
  });

  const fields = Object.values(colMap);
  if (!fields.includes('key') && !fields.includes('name')) {
    return { ym, rows: [], errors: ['Không tìm thấy cột "Ma" hoặc "Ten" để nhận diện nhân viên.'], count: 0 };
  }
  if (!dayCols.length) {
    return { ym, rows: [], errors: ['Không tìm thấy cột ngày nào (1, 2, 3, ... 31).'], count: 0 };
  }

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every((c) => String(c).trim() === '')) continue;

    const rec = { key: '', name: '', location: '', department: '', brand: '', days: {} };
    Object.entries(colMap).forEach(([i, f]) => { rec[f] = String(row[i] ?? '').trim(); });

    const who = rec.name || rec.key || `dòng ${r + 1}`;
    if (!rec.key && !rec.name) { errors.push(`Dòng ${r + 1}: thiếu cả Mã lẫn Tên, đã bỏ qua.`); continue; }

    dayCols.forEach(({ index, day }) => {
      if (day > daysInMonth) return;   // tháng 30 ngày mà file có cột 31
      const parsed = parseCell(row[index]);
      const dayStr = `${ym}-${String(day).padStart(2, '0')}`;

      if (parsed === null) {
        errors.push(`${who}, ngày ${day}: giờ "${row[index]}" không đọc được, đã coi là nghỉ.`);
        return;
      }
      if (parsed.singleTimeOnly) {
        errors.push(`${who}, ngày ${day}: ô chỉ có 1 mốc giờ (Excel tự đổi định dạng) — cần dạng "HH:mm-HH:mm", đã coi là nghỉ.`);
        return;
      }
      if (parsed.off) return;   // nghỉ: không ghi dòng nào

      rec.days[dayStr] = { start: parsed.start, end: parsed.end };
    });

    rows.push(rec);
  }

  return { ym, rows, errors, count: rows.length };
}

module.exports = { parseScheduleFile, parseCell, norm };
