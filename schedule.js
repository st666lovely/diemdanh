'use strict';

/* Đọc file lịch tháng dạng bảng: 1 dòng/người, mỗi ngày trong tháng 1 cột.
   Giữ nguyên quy tắc của bot Telegram đang chạy để hai bên dùng chung được một file:
     Ma/Ten/KhuVuc | 1 | 2 | 3 | ... | 31
   Ô ghi "HH:mm-HH:mm" (chấp nhận "12h00-22h00") để có đủ giờ vào/kết ca.
   Ô chỉ ghi MỘT mốc giờ (VD "07:00") = giờ vào ca; giờ kết ca suy ra tự động
   theo số giờ ca mặc định của từng người (đặt ở tab Nhân sự, VD 8 hoặc 10 tiếng).
   Để trống hoặc OFF/Nghỉ = ngày nghỉ. */

const XLSX = require('xlsx');

const HEADER_ALIASES = {
  ma: 'key', key: 'key', manv: 'key', mand: 'key', code: 'key',
  ten: 'name', name: 'name', hoten: 'name', tennhanvien: 'name',
  khuvuc: 'location', location: 'location', chinhanh: 'location', quocgia: 'location',
  bophan: 'department', department: 'department', phongban: 'department',
  brand: 'brand', thuonghieu: 'brand',
  // Mã cá nhân lấy từ lương tháng trước, nhập chung file lịch cho gọn
  macanhan: 'personal_key', makhoa: 'personal_key', khoacanhan: 'personal_key',
  personalkey: 'personal_key', pin: 'personal_key',
  thangluong: 'key_month', kyluong: 'key_month', thangapdung: 'key_month',
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

/* Một ô giờ ca -> { off } | { start, end } | { singleStart } | null (lỗi định dạng)
   { singleStart } nghĩa là ô chỉ ghi MỘT mốc giờ vào ca (VD "07:00" = ca 8 tiếng,
   "10:00" = ca 10 tiếng) — giờ kết ca sẽ suy ra sau, theo số giờ ca mặc định của
   từng người (cột shift_hours ở tab Nhân sự), lúc áp lịch vào hệ thống. */
function parseCell(raw) {
  // Excel tự đổi ô "07:00" thành số thập phân (time serial, phần của 1 ngày)
  // khi ô chỉ ghi một mốc giờ, không có dấu gạch nối.
  if (typeof raw === 'number') {
    if (raw < 0 || raw >= 1) return null;   // không phải giờ trong ngày (VD lẫn cả ngày tháng)
    const totalMin = Math.round(raw * 24 * 60) % 1440;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const mm = String(totalMin % 60).padStart(2, '0');
    return { singleStart: `${hh}:${mm}` };
  }

  const str = String(raw ?? '').trim();
  if (!str) return { off: true };
  if (OFF_TOKENS.has(norm(str))) return { off: true };

  const norm2 = str.replace(/h/gi, ':');

  const range = norm2.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (range) {
    const hh = (a, b) => `${a.padStart(2, '0')}:${b}`;
    const start = hh(range[1], range[2]);
    const end = hh(range[3], range[4]);
    if (+range[1] > 23 || +range[3] > 23 || +range[2] > 59 || +range[4] > 59) return null;
    return { start, end };
  }

  // Chỉ ghi 1 mốc giờ vào ca, ví dụ "07:00" hoặc "07h00"
  const single = norm2.match(/^(\d{1,2}):(\d{2})$/);
  if (single) {
    if (+single[1] > 23 || +single[2] > 59) return null;
    return { singleStart: `${single[1].padStart(2, '0')}:${single[2]}` };
  }

  return null;
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

    const rec = { key: '', name: '', location: '', department: '', brand: '',
                  personal_key: '', key_month: '', days: {} };
    Object.entries(colMap).forEach(([i, f]) => { rec[f] = String(row[i] ?? '').trim(); });

    const who = rec.name || rec.key || `dòng ${r + 1}`;
    if (!rec.key && !rec.name) { errors.push(`Dòng ${r + 1}: thiếu cả Mã lẫn Tên, đã bỏ qua.`); continue; }

    // Mã cá nhân do quản lý tự đặt: chữ, số, ký hiệu đều được.
    // Lưu ý Excel tự cắt số 0 đầu nếu ô để dạng số — cột này nên định dạng Text.
    if (rec.personal_key !== '' && rec.personal_key != null) {
      const raw = String(rec.personal_key).trim();
      if (!raw) {
        rec.personal_key = '';
      } else if (/\s/.test(raw)) {
        errors.push(`${who}: mã cá nhân "${raw}" có khoảng trắng, đã bỏ qua.`);
        rec.personal_key = '';
      } else if (raw.length < 4 || raw.length > 32) {
        errors.push(`${who}: mã cá nhân "${raw}" cần 4–32 ký tự, đã bỏ qua.`);
        rec.personal_key = '';
      } else {
        rec.personal_key = raw;
      }
    }
    if (rec.key_month && !/^\d{4}-\d{2}$/.test(String(rec.key_month).trim())) {
      const m = String(rec.key_month).match(/(\d{4})[-/](\d{1,2})/);
      rec.key_month = m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : '';
    }

    dayCols.forEach(({ index, day }) => {
      if (day > daysInMonth) return;   // tháng 30 ngày mà file có cột 31
      const parsed = parseCell(row[index]);
      const dayStr = `${ym}-${String(day).padStart(2, '0')}`;

      if (parsed === null) {
        errors.push(`${who}, ngày ${day}: giờ "${row[index]}" không đọc được, đã coi là nghỉ.`);
        return;
      }
      if (parsed.off) return;   // nghỉ: không ghi dòng nào

      // Chỉ ghi 1 mốc giờ vào ca — giờ kết ca sẽ suy ra theo số giờ ca mặc định
      // của từng người khi áp lịch (applySchedule), vì lúc đọc file chưa biết
      // người này là nhân viên mấy tiếng.
      if (parsed.singleStart) { rec.days[dayStr] = { singleStart: parsed.singleStart }; return; }

      rec.days[dayStr] = { start: parsed.start, end: parsed.end };
    });

    rows.push(rec);
  }

  return { ym, rows, errors, count: rows.length };
}

module.exports = { parseScheduleFile, parseCell, norm };
