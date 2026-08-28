'use strict';

/* Đọc file lịch ca theo đúng định dạng team đang dùng:

   - Mỗi khối là một bộ phận (CS, Risk...), có một dòng tiêu đề chứa các NGÀY
     dạng 01/09, 02/09... Một file có thể có nhiều khối.
   - Mỗi dòng dưới đó là một người: cột MÃ NV, cột tên, rồi mỗi ngày một ô.
   - Ô ghi MỘT mốc giờ = giờ VÀO ca hôm đó. Giờ ra suy ra từ độ dài ca của
     người đó (8 tiếng, 10 tiếng...), khai ở tab Nhân sự.
   - Ô ghi DO / AL / OFF / nghỉ / để trống = hôm đó nghỉ.

   Vẫn đọc được định dạng cũ (cột ngày đánh số 1..31, ô ghi HH:mm-HH:mm). */

const XLSX = require('xlsx');

const norm = (h) => String(h ?? '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/\s+/g, '');

const OFF_TOKENS = new Set(['do', 'al', 'off', 'nghi', 'x', '-', 'nn', 'null', 'p', 'kl']);

/* Ô ngày trong dòng tiêu đề: "01/09", "1/9", hoặc số 1..31 của định dạng cũ */
function headerDay(v, ym) {
  if (v == null || v === '') return null;
  const s = String(v).trim();

  let m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return `${ym.slice(0, 4)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Định dạng cũ: chỉ số ngày
  if (/^\d{1,2}$/.test(s)) {
    const d = +s;
    if (d >= 1 && d <= 31) return `${ym}-${String(d).padStart(2, '0')}`;
  }

  // Ô ngày do Excel lưu dạng số
  const num = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
  if (Number.isFinite(num) && num > 40000 && num < 60000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(num) * 86400000);
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const thẳng = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (thẳng.startsWith(ym)) return thẳng;

    /* Excel định dạng ngày kiểu Mỹ đọc "01/09" thành 9 tháng 1 thay vì 1 tháng 9.
       Hoán đổi ngày và tháng: nếu kết quả rơi đúng tháng đang nhập thì đó mới là ý người viết.
       Chỉ chữa khi cách đọc thẳng nằm NGOÀI tháng, nên không phá file đúng định dạng. */
    if (d >= 1 && d <= 12) {
      const đảo = `${y}-${String(d).padStart(2, '0')}-${String(mo).padStart(2, '0')}`;
      if (đảo.startsWith(ym)) return đảo;
    }
    return thẳng;
  }
  return null;
}


/* Ô giờ: "10:00", "2:00", "7h", số thập phân của Excel, hoặc "08:00-16:00" (kiểu cũ) */
function parseCell(raw, hours) {
  if (raw == null || raw === '') return { off: true };

  // Excel lưu giờ thành phân số của một ngày
  if (typeof raw === 'number') {
    if (raw > 40000) return null;                 // là ngày, không phải giờ
    if (raw >= 0 && raw < 1) {
      const mins = Math.round(raw * 24 * 60);
      return withEnd(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, hours);
    }
    if (raw >= 1 && raw <= 24) return withEnd(`${String(Math.floor(raw)).padStart(2, '0')}:00`, hours);
    return null;
  }

  const s = String(raw).trim();
  if (!s) return { off: true };
  if (OFF_TOKENS.has(norm(s))) return { off: true };

  const cleaned = s.replace(/h/gi, ':').replace(/\s+/g, '');

  // Kiểu cũ: có đủ giờ vào và giờ ra
  let m = cleaned.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = (a, b) => `${a.padStart(2, '0')}:${b}`;
    if (+m[1] > 23 || +m[3] > 23) return null;
    return { off: false, start: hh(m[1], m[2]), end: hh(m[3], m[4]) };
  }

  // Kiểu đang dùng: chỉ một mốc giờ vào
  m = cleaned.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59) return null;
    return withEnd(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, hours);
  }
  return null;
}

function withEnd(start, hours) {
  const [h, m] = start.split(':').map(Number);
  const total = (h * 60 + m + Math.round((hours || 8) * 60)) % (24 * 60);
  return {
    off: false, start,
    end: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`,
  };
}

/* Dòng này có phải dòng tiêu đề ngày không */
/* Dòng tiêu đề vùng ngày.
   Trước đây bắt phải có từ 3 ô ngày trở lên, nên file chỉ theo dõi một hai ngày
   thì không nhận ra tiêu đề. Giờ chấp nhận từ 1 ô, bù lại kiểm tra chặt hơn:
   phải có ô định danh (Ma / MaNV / Ten) đứng trước vùng ngày. */
function dateHeaderOf(row, ym) {
  const cols = [];
  (row || []).forEach((c, i) => {
    const d = headerDay(c, ym);
    if (d) cols.push({ index: i, day: d });
  });
  if (!cols.length) return null;
  if (cols.length >= 3) return cols;

  // Ít ô ngày: chỉ nhận khi phía trước có cột định danh, tránh nhận nhầm dòng dữ liệu
  const first = cols[0].index;
  for (let i = 0; i < first; i++) {
    const n = norm(row[i]);
    if (n === 'ma' || n === 'ten' || n === 'hoten' || n.includes('manv')
        || n.includes('manhanvien') || n.includes('tennhanvien')) return cols;
  }
  return null;
}

/* Trong dòng tiêu đề, tìm cột Mã NV và cột Tên */
function findIdCols(row, dateCols) {
  const first = dateCols[0].index;
  let empCol = null, nameCol = null;
  // Các cột phụ: bộ phận, brand, khu vực, mã cá nhân, tháng lương
  let depCol = null, brandCol = null, locCol = null, keyCol = null, monthCol = null;

  for (let i = 0; i < first; i++) {
    const n = norm(row[i]);
    if (!empCol && (n.includes('manv') || n === 'ma' || n.includes('manhanvien'))) empCol = i;
    if (!nameCol && (n === 'ten' || n === 'hoten' || n.includes('tennhanvien'))) nameCol = i;
    if (!depCol && (n.includes('bophan') || n.includes('phongban') || n === 'department')) depCol = i;
    if (!brandCol && (n === 'brand' || n.includes('thuonghieu'))) brandCol = i;
    if (!locCol && (n.includes('khuvuc') || n === 'location' || n.includes('quocgia')
                    || n.includes('chinhanh'))) locCol = i;
    if (!keyCol && (n.includes('macanhan') || n.includes('makhoa') || n === 'personalkey'
                    || n === 'pin')) keyCol = i;
    if (!monthCol && (n.includes('thangluong') || n.includes('kyluong'))) monthCol = i;
  }
  return { empCol, nameCol, depCol, brandCol, locCol, keyCol, monthCol, firstDateCol: first };
}

/**
 * @param buffer  nội dung file
 * @param ym      'YYYY-MM' tháng áp dụng
 * @param hoursOf hàm (empCode, name) -> độ dài ca của người đó, mặc định 8
 */
function parseScheduleFile(buffer, ym, hoursOf = () => 8) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) {
    return { ym, rows: [], errors: ['Thiếu tháng áp dụng (dạng YYYY-MM).'], count: 0 };
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const errors = [];
  const byPerson = new Map();
  const thangTieuDe = {};   // tháng -> số cột ngày, dùng để phát hiện chọn nhầm tháng

  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });

    let dateCols = null, idCols = null, blockName = sheetName;

    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];

      // Gặp dòng tiêu đề mới -> đổi khối
      const hdr = dateHeaderOf(row, ym);
      if (hdr) {
        hdr.forEach(({ day }) => {
          const m = day.slice(0, 7);
          thangTieuDe[m] = (thangTieuDe[m] || 0) + 1;
        });
        dateCols = hdr;
        idCols = findIdCols(row, hdr);
        if (idCols.empCol === null && idCols.nameCol === null) {
          // Không có tiêu đề rõ ràng: đoán cột đầu tiên có chữ là tên
          idCols.nameCol = 0;
        }
        continue;
      }
      if (!dateCols) continue;

      const emp = idCols.empCol !== null ? String(row[idCols.empCol] ?? '').trim() : '';
      let name = idCols.nameCol !== null ? String(row[idCols.nameCol] ?? '').trim() : '';

      // Tiêu đề cột tên hay ghi tên bộ phận ("CS", "Risk") thay vì chữ "Tên",
      // nên nếu chưa xác định được thì lấy ô chữ đầu tiên trước vùng ngày,
      // bỏ qua số thứ tự và bỏ qua chính ô mã NV.
      if (!name) {
        const bỏQua = new Set([idCols.empCol, idCols.depCol, idCols.brandCol,
                               idCols.locCol, idCols.keyCol, idCols.monthCol]);
        for (let i = 0; i < idCols.firstDateCol; i++) {
          if (bỏQua.has(i)) continue;
          const v = String(row[i] ?? '').trim();
          if (v && !/^\d+([.,]\d+)?$/.test(v)) { name = v; break; }
        }
      }
      if (!emp && !name) continue;                 // dòng trống hoặc dòng phân cách

      // Gộp theo TÊN nếu có tên, vì hai người khác nhau có thể bị điền trùng Mã NV.
      // Trước đây gộp theo mã nên người thứ hai lặng lẽ biến mất khỏi file.
      const key = (name || emp).toUpperCase();
      if (!byPerson.has(key)) {
        byPerson.set(key, {
          key: emp ? emp.toUpperCase() : '', name, emp_code: emp,
          location: '', department: '', brand: '', personal_key: '', key_month: '',
          days: {}, block: blockName,
        });
      }
      const rec = byPerson.get(key);
      if (!rec.name && name) rec.name = name;

      // Cột phụ: chỉ ghi đè khi ô có giá trị, để dòng sau trống không xoá dòng trước
      const lấy = (col) => (col !== null && col !== undefined)
        ? String(row[col] ?? '').trim() : '';
      const dep = lấy(idCols.depCol);
      const br = lấy(idCols.brandCol);
      const loc = lấy(idCols.locCol);
      const pk = lấy(idCols.keyCol);
      const km = lấy(idCols.monthCol);
      if (dep) rec.department = dep;
      if (br) rec.brand = br;
      if (loc) rec.location = loc;
      if (km) rec.key_month = km;
      if (pk) {
        const raw = pk.replace(/\s+/g, '');
        if (raw.length >= 4 && raw.length <= 32) rec.personal_key = raw;
        else errors.push(`${name || emp}: mã cá nhân "${pk}" cần 4–32 ký tự, đã bỏ qua.`);
      }

      const hours = hoursOf(emp, name) || 8;

      for (const { index, day } of dateCols) {
        if (!day.startsWith(ym)) continue;         // ô ngày thuộc tháng khác
        const parsed = parseCell(row[index], hours);
        if (parsed === null) {
          errors.push(`${name || emp}, ngày ${day.slice(8)}: không đọc được "${row[index]}", đã coi là nghỉ.`);
          continue;
        }
        if (parsed.off) continue;
        rec.days[day] = { start: parsed.start, end: parsed.end };
      }
    }
  }

  const rows = [...byPerson.values()].filter((r) => Object.keys(r.days).length > 0 || r.name);
  if (!rows.length) {
    errors.unshift('Không tìm thấy dòng tiêu đề chứa các ngày. '
      + 'Tiêu đề ngày viết dạng 01/09 hoặc 24/08, hoặc chỉ số ngày 1 2 3. '
      + 'Nếu file chỉ có một hai cột ngày thì phải có cột Ma hoặc Ten đứng trước. '
                 + 'Kiểm tra file có dòng ghi ngày ở đầu mỗi khối không.');
  }
  return { ym, rows, errors, count: rows.length, headerMonths: thangTieuDe };
}

module.exports = { parseScheduleFile, parseCell, headerDay, withEnd, norm };
