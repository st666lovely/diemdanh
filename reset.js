'use strict';

/* Xoá dữ liệu Trạm trực.
   Chạy trong Shell của Render:

     node reset.js lichsu     — xoá lịch sử chấm công, điểm danh, rời vị trí, ảnh.
                                GIỮ nhân sự, mã cá nhân, lịch ca, lịch nghỉ.
     node reset.js lich       — xoá thêm lịch ca và lịch nghỉ. Giữ nhân sự và mã.
     node reset.js tatca      — xoá sạch mọi thứ, kể cả nhân sự. Về như mới cài.

   Thêm --yes để bỏ qua bước hỏi lại:
     node reset.js tatca --yes
*/

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'tramtruc.db');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

const MUC = {
  lichsu: {
    ten: 'Xoá lịch sử',
    xoa: ['punches', 'roll_calls', 'activities', 'audit_log'],
    anh: true,
    giu: 'nhân sự, mã cá nhân, mã NV, lịch ca, lịch nghỉ, cấu hình',
  },
  lich: {
    ten: 'Xoá lịch sử + lịch ca',
    xoa: ['punches', 'roll_calls', 'activities', 'audit_log',
          'shift_days', 'day_offs', 'off_locks', 'ot_records', 'report_exempt'],
    anh: true,
    giu: 'nhân sự, mã cá nhân, mã NV, cấu hình',
  },
  tatca: {
    ten: 'Xoá sạch mọi thứ',
    xoa: null,          // xoá luôn file database
    anh: true,
    giu: 'không giữ gì — tài khoản quản trị sẽ được tạo lại từ ADMIN_PASSWORD',
  },
};

function xoaAnh() {
  if (!fs.existsSync(PHOTOS_DIR)) return 0;
  let n = 0;
  for (const thuMuc of fs.readdirSync(PHOTOS_DIR)) {
    const p = path.join(PHOTOS_DIR, thuMuc);
    try {
      const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p) : [];
      n += files.length;
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {}
  }
  return n;
}

async function hoiLai(muc) {
  if (process.argv.includes('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const dap = await new Promise((r) =>
    rl.question(`\nGõ XOA rồi Enter để xác nhận "${muc.ten}": `, r));
  rl.close();
  return String(dap).trim().toUpperCase() === 'XOA';
}

(async () => {
  const key = (process.argv[2] || '').toLowerCase();
  const muc = MUC[key];

  if (!muc) {
    console.log('Cách dùng: node reset.js <lichsu|lich|tatca> [--yes]\n');
    Object.entries(MUC).forEach(([k, m]) =>
      console.log(`  ${k.padEnd(8)} ${m.ten.padEnd(24)} giữ lại: ${m.giu}`));
    process.exit(1);
  }

  console.log(`Thư mục dữ liệu: ${DATA_DIR}`);
  if (!fs.existsSync(DB_FILE)) {
    console.log('Chưa có database, không có gì để xoá.');
    process.exit(0);
  }

  console.log(`Mức: ${muc.ten}`);
  console.log(`Giữ lại: ${muc.giu}`);

  if (!(await hoiLai(muc))) { console.log('Đã huỷ, không xoá gì.'); process.exit(0); }

  const soAnh = muc.anh ? xoaAnh() : 0;

  if (muc.xoa === null) {
    // Xoá cả file database — lần khởi động sau sẽ tạo mới và seed lại quản trị
    for (const f of ['tramtruc.db', 'tramtruc.db-shm', 'tramtruc.db-wal']) {
      const p = path.join(DATA_DIR, f);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    console.log(`\nĐã xoá database và ${soAnh} ảnh.`);
    console.log('Restart service để hệ thống tạo lại từ đầu.');
    process.exit(0);
  }

  const Database = require('better-sqlite3');
  const db = new Database(DB_FILE);

  const co = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((r) => r.name));

  console.log('');
  db.transaction(() => {
    for (const t of muc.xoa) {
      if (!co.has(t)) continue;
      const truoc = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      db.prepare(`DELETE FROM ${t}`).run();
      console.log(`  ${t.padEnd(16)} xoá ${truoc} dòng`);
    }
    // Gỡ khoá bộ phận còn treo, nếu có
    if (co.has('activities')) db.prepare('UPDATE activities SET lock_key=NULL').run();
  })();

  db.prepare('VACUUM').run();
  db.close();

  console.log(`\nĐã xoá xong. Ảnh đã xoá: ${soAnh}.`);
  console.log('Không cần restart — dữ liệu đã sạch ngay.');
})();
