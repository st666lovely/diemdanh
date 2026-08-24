'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tramtruc.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const DEPTS = ['CS', 'CS ONL', 'VIP', 'RISK', 'RISK ONL'];
const BRANDS = ['AE', 'ST'];
const AUTO_CLOSE_GRACE_MIN = 30;

/* ============================================================
   SCHEMA
   Nhân viên KHÔNG có mật khẩu — vào bằng link chứa key định danh.
   Chỉ quản trị mới có password_hash.
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  key            TEXT    NOT NULL UNIQUE,   -- link vào ca: /k/<key>
  department     TEXT,
  brand          TEXT,
  role           TEXT    NOT NULL DEFAULT 'staff',   -- staff | admin (theo brand) | super (cả hai)
  password_hash  TEXT,                      -- chỉ admin
  username       TEXT UNIQUE,               -- chỉ admin
  device_id      TEXT,                      -- gắn với thiết bị đầu tiên mở link
  device_seen_at INTEGER,
  device_ua      TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  limit_minutes INTEGER NOT NULL,
  counts_toward_limit INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_code     TEXT    NOT NULL,
  brand         TEXT,
  department    TEXT,
  limit_minutes INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  duration_sec  INTEGER,
  is_over_limit INTEGER NOT NULL DEFAULT 0,
  closed_by     TEXT,
  -- Chốt chặn khóa bộ phận: "AE|CS" khi ca đang mở và loại chiếm khóa, NULL khi đóng.
  -- SQLite coi các NULL là khác nhau trong UNIQUE nên nhiều bản ghi đã đóng cùng tồn tại,
  -- còn mỗi cặp brand+bộ phận chỉ có đúng 1 ca đang mở. Hai người bấm lệch 10ms không lọt.
  lock_key      TEXT UNIQUE,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_user ON activities(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_act_dep  ON activities(brand, department, started_at);
CREATE INDEX IF NOT EXISTS idx_act_open ON activities(ended_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, actor_name TEXT,
  action TEXT NOT NULL, detail TEXT, ip TEXT, at INTEGER NOT NULL
);

-- Chấm công ca: lên ca / xuống ca / chấm công lẻ
CREATE TABLE IF NOT EXISTS punches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,          -- in | out | log
  brand        TEXT, department TEXT,
  scheduled_at INTEGER,                   -- NULL với loại 'log'
  actual_at    INTEGER NOT NULL,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  late_level   TEXT,                      -- in5 | in30 | out60
  ip TEXT, user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_p_user ON punches(user_id, actual_at);
CREATE INDEX IF NOT EXISTS idx_p_late ON punches(late_level, actual_at);

-- Lịch off: mỗi dòng là một ngày nghỉ đã đăng ký
CREATE TABLE IF NOT EXISTS day_offs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,            -- YYYY-MM-DD
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, day)
);

-- Quản trị khóa tháng để nhân viên không sửa được nữa
CREATE TABLE IF NOT EXISTS off_locks (
  ym        TEXT PRIMARY KEY,             -- YYYY-MM
  locked_at INTEGER NOT NULL
);

-- Lịch ca theo TỪNG NGÀY, nhập từ file Excel/CSV tháng.
-- Không có dòng cho ngày nào = ngày đó nghỉ, không tính trễ.
CREATE TABLE IF NOT EXISTS shift_days (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,            -- YYYY-MM-DD
  start_hm   TEXT    NOT NULL,            -- HH:MM giờ địa phương của nhân viên
  end_hm     TEXT    NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_shift_day ON shift_days(day);

-- Điểm danh ngẫu nhiên trong ca.
-- Đang rời vị trí (đi vệ sinh, lấy đồ...) thì KHÔNG tính vắng: lượt đó chuyển
-- sang chờ, khi bấm Dừng lại xong mới bắn lượt bù.
CREATE TABLE IF NOT EXISTS roll_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand         TEXT, department TEXT,
  day           TEXT    NOT NULL,          -- ngày của ca, theo giờ địa phương
  due_at        INTEGER,                   -- thời điểm phải điểm danh (NULL khi đang chờ)
  deadline_at   INTEGER,                   -- quá mốc này là vắng
  status        TEXT    NOT NULL,          -- pending | done | missed | deferred | waiting
  answered_at   INTEGER,
  is_makeup     INTEGER NOT NULL DEFAULT 0,-- lượt bù sau khi rời vị trí
  defer_reason  TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rc_user   ON roll_calls(user_id, day);
CREATE INDEX IF NOT EXISTS idx_rc_status ON roll_calls(status, due_at);

-- Miễn báo cáo cho một ca cụ thể: ca không phát sinh việc, hoặc quản lý cho phép.
-- Làm thêm giờ: kéo dài ca hôm đó, để xuống ca muộn không bị tính trễ
-- và điểm danh vẫn chạy tới hết giờ OT.
CREATE TABLE IF NOT EXISTS ot_records (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,
  hours      REAL    NOT NULL,
  reason     TEXT,
  by_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS report_exempt (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,
  reason     TEXT,
  by_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
`);

// Cột giờ ca — thêm sau nên dùng ALTER có kiểm tra, tránh lỗi khi chạy lại
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('shift_start')) db.exec("ALTER TABLE users ADD COLUMN shift_start TEXT NOT NULL DEFAULT '09:00'");
  if (!cols.includes('shift_end'))   db.exec("ALTER TABLE users ADD COLUMN shift_end   TEXT NOT NULL DEFAULT '18:00'");

  if (!cols.includes('location')) db.exec("ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT 'VN'");
  // Mã cá nhân lấy từ lương tháng trước. Lưu dạng băm, KHÔNG bao giờ lưu số gốc.
  if (!cols.includes('key_hash'))  db.exec('ALTER TABLE users ADD COLUMN key_hash TEXT');
  if (!cols.includes('key_month')) db.exec('ALTER TABLE users ADD COLUMN key_month TEXT');
  if (!cols.includes('key_set_at'))db.exec('ALTER TABLE users ADD COLUMN key_set_at INTEGER');
  // Mã nhân viên dùng để khớp dòng trong sheet báo cáo. KHÔNG bí mật —
  // cố ý tách khỏi mã cá nhân, vì sheet cả team cùng xem.
  if (!cols.includes('emp_code')) db.exec('ALTER TABLE users ADD COLUMN emp_code TEXT');
  // Giờ ca mặc định — đặt một lần, dùng cho mọi ngày không có dòng trong lịch tháng.
  // Nhờ vậy không phải nhập file lịch hằng tháng nữa.
  if (!cols.includes('default_start')) db.exec('ALTER TABLE users ADD COLUMN default_start TEXT');
  if (!cols.includes('default_end'))   db.exec('ALTER TABLE users ADD COLUMN default_end TEXT');
  // Độ dài ca của từng người — file lịch chỉ ghi GIỜ VÀO, giờ ra = giờ vào + số này
  if (!cols.includes('shift_hours')) db.exec('ALTER TABLE users ADD COLUMN shift_hours REAL NOT NULL DEFAULT 8');

  const oc = db.prepare('PRAGMA table_info(day_offs)').all().map((c) => c.name);
  if (!oc.includes('brand'))      db.exec('ALTER TABLE day_offs ADD COLUMN brand TEXT');
  if (!oc.includes('department')) db.exec('ALTER TABLE day_offs ADD COLUMN department TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_off_slot ON day_offs(brand, department, day)');
}

/* ============================================================
   SEED
   ============================================================ */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // bỏ 0 1 I O cho dễ đọc/đọc qua điện thoại
function newKey(len = 8) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

if (db.prepare('SELECT COUNT(*) n FROM activity_types').get().n === 0) {
  const ins = db.prepare(
    'INSERT INTO activity_types (code,name,limit_minutes,counts_toward_limit,sort_order) VALUES (?,?,?,?,?)'
  );
  db.transaction(() => [
    ['smoke', 'Đi hút thuốc', 10, 1, 1],
    ['wc1', 'Đi vệ sinh nhẹ', 10, 1, 2],
    ['wc2', 'Đi vệ sinh nặng', 15, 1, 3],
    ['pick', 'Lấy đồ', 15, 1, 4],
    ['net', 'Lỗi mạng', 15, 0, 5],
  ].forEach((t) => ins.run(...t)))();
}

if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASSWORD || 'doi-mat-khau-ngay';
  db.prepare(
    `INSERT INTO users (name,key,username,password_hash,role,department,created_at)
     VALUES (?,?,?,?,'super','RISK',?)`
  ).run('Quản trị tổng', newKey(), u, bcrypt.hashSync(p, 10), Date.now());
  console.log(`[seed] Quản trị: ${u} / ${p} — đổi mật khẩu ngay sau khi đăng nhập.`);
}

/* ============================================================
   TIỆN ÍCH
   ============================================================ */
const lockKey = (brand, dept) => `${brand || '-'}|${dept || '-'}`;
const now = () => Date.now();

const types = () =>
  db.prepare('SELECT * FROM activity_types WHERE is_active=1 ORDER BY sort_order')
    .all().map((t) => ({ ...t, counts_toward_limit: !!t.counts_toward_limit }));

function typeByCode(code) {
  const t = db.prepare('SELECT * FROM activity_types WHERE code=? AND is_active=1').get(code);
  return t ? { ...t, counts_toward_limit: !!t.counts_toward_limit } : null;
}

/* Đóng ca bị bỏ quên — chạy trước mọi lần đọc trạng thái.
   Không có cái này thì một người quên bấm sẽ khóa bộ phận vĩnh viễn. */
function sweepStale() {
  const open = db.prepare('SELECT * FROM activities WHERE ended_at IS NULL').all();
  const upd = db.prepare(`UPDATE activities
    SET ended_at=?, duration_sec=?, is_over_limit=1, closed_by='auto', lock_key=NULL WHERE id=?`);
  let n = 0;
  db.transaction(() => {
    for (const a of open) {
      const deadline = a.started_at + (a.limit_minutes + AUTO_CLOSE_GRACE_MIN) * 60000;
      if (now() > deadline) {
        upd.run(deadline, Math.round((deadline - a.started_at) / 1000), a.id);
        n++;
      }
    }
  })();
  return n;
}

const openFor = (uid) =>
  db.prepare('SELECT * FROM activities WHERE user_id=? AND ended_at IS NULL').get(uid);

const holderOf = (brand, dept) =>
  db.prepare(`SELECT a.*, u.name user_name FROM activities a JOIN users u ON u.id=a.user_id
              WHERE a.lock_key=? AND a.ended_at IS NULL`).get(lockKey(brand, dept));

const openInDept = (brand, dept) =>
  db.prepare(`SELECT a.*, u.name user_name FROM activities a JOIN users u ON u.id=a.user_id
              WHERE a.ended_at IS NULL AND IFNULL(a.brand,'-')=? AND IFNULL(a.department,'-')=?
              ORDER BY a.started_at`).all(brand || '-', dept || '-');

function present(a) {
  const left = Math.round((a.started_at + a.limit_minutes * 60000 - now()) / 1000);
  return {
    id: a.id, user_id: a.user_id, user_name: a.user_name,
    type_code: a.type_code, type_name: (typeByCode(a.type_code) || {}).name || a.type_code,
    brand: a.brand, department: a.department,
    started_at: a.started_at, limit_minutes: a.limit_minutes,
    remaining_seconds: left, over_limit: left < 0,
  };
}

function lanes(scope = null) {
  return db.prepare(
    `SELECT brand, department, COUNT(*) headcount FROM users
     WHERE is_active=1 AND role='staff' AND department IS NOT NULL
       AND (? IS NULL OR brand=?)
     GROUP BY brand, department ORDER BY department, brand`
  ).all(scope, scope).map((p) => {
    const h = holderOf(p.brand, p.department);
    return { ...p, holder: h ? present(h) : null };
  });
}

/* ============================================================
   NGHIỆP VỤ
   ============================================================ */
function startActivity(user, code, ip, ua) {
  const t = typeByCode(code);
  if (!t) return { ok: false, message: 'Loại hoạt động không tồn tại.' };
  if (openFor(user.id)) return { ok: false, message: 'Bạn đang có một hoạt động chưa kết thúc.' };

  const needsLock = t.counts_toward_limit;

  // Kiểm tra trước chỉ để có thông báo dễ hiểu. Chốt chặn thật là UNIQUE bên dưới.
  if (needsLock) {
    const h = holderOf(user.brand, user.department);
    if (h) return {
      ok: false,
      message: `${h.user_name} đang "${(typeByCode(h.type_code) || {}).name}". Bộ phận chỉ cho 1 người rời chỗ cùng lúc.`,
    };
  }

  try {
    db.prepare(`INSERT INTO activities
      (user_id,type_code,brand,department,limit_minutes,started_at,lock_key,ip,user_agent)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      user.id, t.code, user.brand, user.department, t.limit_minutes, now(),
      needsLock ? lockKey(user.brand, user.department) : null, ip, (ua || '').slice(0, 400)
    );
    return { ok: true, message: `Đã bắt đầu "${t.name}" · ${t.limit_minutes} phút.` };
  } catch (e) {
    if (String(e.code).includes('SQLITE_CONSTRAINT')) {
      return { ok: false, message: 'Vừa có người khác trong bộ phận bắt đầu trước. Chờ chút rồi bấm lại.' };
    }
    throw e;
  }
}

function stopActivity(user, closedBy = 'staff', id = null) {
  const a = id
    ? db.prepare('SELECT * FROM activities WHERE id=? AND ended_at IS NULL').get(id)
    : openFor(user.id);
  if (!a) return { ok: false, message: 'Không có hoạt động nào đang chạy.' };

  const end = now();
  const sec = Math.round((end - a.started_at) / 1000);
  const over = sec > a.limit_minutes * 60;

  db.prepare(`UPDATE activities SET ended_at=?,duration_sec=?,is_over_limit=?,closed_by=?,lock_key=NULL
              WHERE id=?`).run(end, sec, over ? 1 : 0, closedBy, a.id);

  return {
    ok: true, over_limit: over,
    message: over
      ? `Đã kết thúc — quá giờ ${Math.ceil(sec / 60 - a.limit_minutes)} phút.`
      : 'Đã kết thúc đúng giờ.',
  };
}

function stateFor(user) {
  sweepStale();
  const mine = openFor(user.id);
  const h = holderOf(user.brand, user.department);
  const locked = h && (!mine || h.id !== mine.id);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);

  const todayRows = db.prepare(
    `SELECT * FROM activities WHERE user_id=? AND started_at>=? ORDER BY started_at DESC`
  ).all(user.id, today0.getTime());

  return {
    server_time: now(),
    me: { id: user.id, name: user.name, department: user.department, brand: user.brand, role: user.role },
    current: mine ? present({ ...mine, user_name: user.name }) : null,
    locked_by: locked ? present(h) : null,
    lane: {
      brand: user.brand, department: user.department,
      headcount: db.prepare(
        `SELECT COUNT(*) n FROM users WHERE is_active=1 AND role='staff'
         AND IFNULL(brand,'-')=? AND IFNULL(department,'-')=?`
      ).get(user.brand || '-', user.department || '-').n,
      open: openInDept(user.brand, user.department).map(present),
    },
    today: {
      count: todayRows.length,
      minutes: Math.round(todayRows.reduce((s, r) => s + (r.duration_sec || 0), 0) / 60),
      over: todayRows.filter((r) => r.is_over_limit).length,
      rows: todayRows.slice(0, 6).map((r) => ({
        type_name: (typeByCode(r.type_code) || {}).name || r.type_code,
        started_at: r.started_at, duration_sec: r.duration_sec,
        is_over_limit: !!r.is_over_limit, closed_by: r.closed_by,
      })),
    },
    types: types().map((t) => ({
      code: t.code, name: t.name, limit_minutes: t.limit_minutes,
      counts_toward_limit: t.counts_toward_limit,
      disabled: !!mine || (locked && t.counts_toward_limit),
    })),
  };
}

/* ============================================================
   QUẢN TRỊ
   ============================================================ */
function history(f = {}, scope = null) {
  const w = [], p = [];
  if (scope !== null) { w.push('a.brand=?'); p.push(scope); }
  if (f.user_id)    { w.push('a.user_id=?');    p.push(f.user_id); }
  if (f.type_code)  { w.push('a.type_code=?');  p.push(f.type_code); }
  if (f.brand)      { w.push('a.brand=?');      p.push(f.brand); }
  if (f.department) { w.push('a.department=?'); p.push(f.department); }
  if (f.from)       { w.push('a.started_at>=?'); p.push(new Date(f.from + 'T00:00:00').getTime()); }
  if (f.to)         { w.push('a.started_at<=?'); p.push(new Date(f.to + 'T23:59:59').getTime()); }
  if (f.only === 'over')   w.push('a.is_over_limit=1');
  if (f.only === 'forgot') w.push("a.closed_by='auto'");

  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const limit = Math.min(+f.limit || 200, 100000);

  const rows = db.prepare(
    `SELECT a.*, u.name user_name FROM activities a JOIN users u ON u.id=a.user_id
     ${where} ORDER BY a.started_at DESC LIMIT ?`).all(...p, limit);

  const s = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN a.is_over_limit=1 THEN 1 ELSE 0 END) ov,
            SUM(CASE WHEN a.closed_by='auto' THEN 1 ELSE 0 END) fg,
            SUM(CASE WHEN a.ended_at IS NULL THEN 1 ELSE 0 END) rn
     FROM activities a ${where}`).get(...p);

  return {
    rows: rows.map((r) => ({
      ...present(r), ended_at: r.ended_at, duration_sec: r.duration_sec,
      is_over_limit: !!r.is_over_limit, closed_by: r.closed_by, ip: r.ip,
    })),
    stats: { total: s.total || 0, over: s.ov || 0, forgot: s.fg || 0, running: s.rn || 0 },
  };
}

/* ============================================================
   CHẤM CÔNG CA — Lên ca / Xuống ca / Chấm công
   ============================================================ */
// 'log' giữ lại để đọc bản ghi cũ, nhưng không cho bấm mới nữa —
// việc xác nhận có mặt giữa ca đã do điểm danh ngẫu nhiên đảm nhiệm.
const PUNCH_KINDS = { in: 'Lên ca', out: 'Xuống ca', log: 'Chấm công (đã bỏ)' };
const PUNCH_ACTIVE = ['in', 'out'];

/* Yêu cầu lên ca SỚM trước giờ ca bấy nhiêu phút.
   Mốc chuẩn = giờ ca − SHIFT_EARLY_MIN. Quá mốc đó dù 1 phút cũng là trễ. */
const SHIFT_EARLY_MIN = Math.max(0,
  process.env.SHIFT_EARLY_MIN === undefined ? 10 : (Number(process.env.SHIFT_EARLY_MIN) || 0));

// Ngưỡng phân mức, chỉnh được qua biến môi trường
const LATE_IN_1  = Math.max(1, Number(process.env.LATE_IN_MIN1) || 1);    // trễ nhẹ từ 1 phút
const LATE_IN_2  = Math.max(2, Number(process.env.LATE_IN_MIN2) || 30);   // trễ nặng từ 30 phút
const LATE_OUT_1 = Math.max(1, Number(process.env.LATE_OUT_MIN) || 60);   // xuống ca trễ từ 60 phút

const LATE_LEVELS = {
  in5:   { label: `Trễ lên ca ~${LATE_IN_1}p`,    kind: 'in',  min: LATE_IN_1 },
  in30:  { label: `Trễ lên ca ~${LATE_IN_2}p`,   kind: 'in',  min: LATE_IN_2 },
  out60: { label: `Trễ xuống ca ~${LATE_OUT_1}p`, kind: 'out', min: LATE_OUT_1 },
};
/* ============================================================
   MÚI GIỜ THEO KHU VỰC
   Team trải VN và Armenia, lệch 3 tiếng. Mỗi nhân viên có khu vực riêng,
   giờ ca trong file luôn là giờ ĐỊA PHƯƠNG của người đó.
   ============================================================ */
const LOCATION_TZ = {
  VN: 'Asia/Ho_Chi_Minh', VIETNAM: 'Asia/Ho_Chi_Minh', VIET: 'Asia/Ho_Chi_Minh',
  ARM: 'Asia/Yerevan', ARMENIA: 'Asia/Yerevan', AM: 'Asia/Yerevan',
};
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'Asia/Ho_Chi_Minh';
const LOCATIONS = ['VN', 'ARM'];

/* Phạm vi của một tài khoản quản trị.
   'super' -> null = thấy tất cả. 'admin' -> đúng brand của họ.
   Mọi truy vấn quản trị đều phải đi qua đây, không có ngoại lệ. */
function scopeOf(user) {
  if (!user) return '__none__';
  if (user.role === 'super') return null;
  if (user.role === 'admin') return user.brand || '__none__';   // admin chưa gán brand thì không thấy gì
  return '__none__';
}
const isSuper = (u) => !!u && u.role === 'super';
const inScope = (scope, brand) => scope === null || brand === scope;

const tzOf = (loc) => LOCATION_TZ[String(loc || '').trim().toUpperCase()] || DEFAULT_TZ;

/* Đổi "ngày + giờ địa phương" sang mốc thời gian tuyệt đối.
   Cùng cách bot Telegram đang dùng, đã chạy thật nên giữ nguyên. */
function zonedToUtc(dateStr, timeStr, timeZone) {
  const guess = new Date(`${dateStr}T${timeStr}:00.000Z`);
  const asLocal = new Date(guess.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (asUtc.getTime() - asLocal.getTime()));
}

const dayInTz = (at, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
const shiftTz = ymd => { const d = new Date(ymd + 'T00:00:00Z'); return d; };
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const MAX_OFF_PER_MONTH = Math.max(1, Number(process.env.MAX_OFF_PER_MONTH) || 15);
// Cùng một ngày, mỗi bộ phận (theo cặp brand + bộ phận) cho tối đa bấy nhiêu người nghỉ.
const MAX_OFF_PER_DAY_DEPT = Math.max(1, Number(process.env.MAX_OFF_PER_DAY_DEPT) || 1);

/* Ca của nhân viên quanh thời điểm `at`, đọc từ lịch tháng đã nhập.
   Xét cả ngày hôm trước để bắt ca qua đêm (vd 22:00–06:00 giờ địa phương). */
/* Tháng này đã nhập lịch file cho người đó chưa.
   Có file thì file là chuẩn: ngày nào không có dòng nghĩa là nghỉ.
   Không có file thì dùng giờ ca mặc định, trừ ngày đã đăng ký nghỉ. */
function monthHasSchedule(userId, ym) {
  return !!db.prepare('SELECT 1 FROM shift_days WHERE user_id=? AND day LIKE ? LIMIT 1')
    .get(userId, ym + '%');
}

const otOf = (userId, day) =>
  db.prepare('SELECT * FROM ot_records WHERE user_id=? AND day=?').get(userId, day);

function shiftWindow(user, at = now()) {
  const tz = tzOf(user.location);
  const today = dayInTz(at, tz);
  const cands = [];

  for (const d of [addDays(today, -1), today]) {
    const row = db.prepare('SELECT * FROM shift_days WHERE user_id=? AND day=?').get(user.id, d);

    let startHm, endHm, source;
    if (row) {
      startHm = row.start_hm; endHm = row.end_hm; source = 'file';
    } else {
      continue;   // hôm đó nghỉ
    }

    const startUtc = zonedToUtc(d, startHm, tz).getTime();
    let endUtc = zonedToUtc(d, endHm, tz).getTime();
    if (endUtc <= startUtc) endUtc += 24 * 3600000;   // ca qua đêm

    // Có OT thì kéo dài giờ kết ca
    const ot = otOf(user.id, d);
    if (ot) endUtc += ot.hours * 3600000;

    cands.push({
      day: d, start: startUtc, end: endUtc,
      start_hm: startHm, end_hm: endHm, tz, source,
      ot_hours: ot ? ot.hours : 0,
    });
  }
  return cands;
}

/* Mốc giờ theo lịch cho một lần chấm.
   Trả về null nếu hôm đó nghỉ hoặc chưa nhập lịch — khi đó không tính trễ. */
function scheduledFor(user, kind, at = now()) {
  if (kind === 'log') return null;
  const cands = shiftWindow(user, at);
  if (!cands.length) return null;

  // Chọn ca có mốc gần thời điểm bấm nhất
  const pick = cands.reduce((best, c) => {
    const t = kind === 'in' ? c.start : c.end;
    const bt = kind === 'in' ? best.start : best.end;
    return Math.abs(at - t) < Math.abs(at - bt) ? c : best;
  });

  // Lên ca phải có mặt trước giờ ca SHIFT_EARLY_MIN phút, nên mốc chuẩn lùi lại bấy nhiêu
  return kind === 'in'
    ? pick.start - SHIFT_EARLY_MIN * 60000
    : pick.end;
}

function lateOf(kind, diffMin) {
  if (diffMin <= 0) return null;
  if (kind === 'in')  return diffMin >= LATE_IN_2 ? 'in30' : (diffMin >= LATE_IN_1 ? 'in5' : null);
  if (kind === 'out') return diffMin >= LATE_OUT_1 ? 'out60' : null;
  return null;
}

function punch(user, kind, ip, ua) {
  if (!PUNCH_ACTIVE.includes(kind)) return { ok: false, message: 'Loại chấm công không hợp lệ.' };

  const st = shiftToday(user);

  // Bấm nhầm Xuống ca khi chưa lên ca
  if (kind === 'out' && !st.on_shift) {
    return {
      ok: false, not_on_shift: true,
      message: st.checked_out_at
        ? `Bạn đã xuống ca lúc ${new Date(st.checked_out_at).toLocaleTimeString('vi-VN',
            { hour12: false, timeZone: tzOf(user.location) })} rồi.`
        : 'Bạn chưa lên ca.',
    };
  }

  // Bấm Lên ca hai lần liên tiếp
  if (kind === 'in' && st.on_shift) {
    return {
      ok: false, already_in: true,
      message: `Bạn đã lên ca lúc ${new Date(st.checked_in_at).toLocaleTimeString('vi-VN',
        { hour12: false, timeZone: tzOf(user.location) })} rồi.`,
    };
  }

  const at = now();
  const tz = tzOf(user.location);
  const sched = scheduledFor(user, kind, at);
  const diff = sched ? Math.round((at - sched) / 60000) : 0;
  const level = lateOf(kind, diff);
  const hhmm = new Date(at).toLocaleTimeString('vi-VN', { hour12: false, timeZone: tz });

  db.prepare(`INSERT INTO punches
    (user_id,kind,brand,department,scheduled_at,actual_at,late_minutes,late_level,ip,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, kind, user.brand, user.department, sched, at,
    Math.max(0, diff), level, ip, (ua || '').slice(0, 400));

  const gioLich = sched
    ? new Date(sched).toLocaleTimeString('vi-VN', { hour12: false, timeZone: tz }).slice(0, 5)
    : null;

  let message;
  const moTaMoc = kind === 'in' && SHIFT_EARLY_MIN > 0
    ? `phải có mặt trước ${gioLich}`      // đã trừ sẵn 10 phút
    : `lịch ${gioLich}`;

  if (level) {
    message = `${PUNCH_KINDS[kind]} lúc ${hhmm} — ${LATE_LEVELS[level].label}: `
            + `trễ ${diff} phút, ${moTaMoc}.`;
  } else if (!sched) {
    message = `${PUNCH_KINDS[kind]} lúc ${hhmm} — hôm nay chưa có lịch ca nên không tính trễ.`;
  } else if (diff > 0) {
    message = `${PUNCH_KINDS[kind]} lúc ${hhmm} — trễ ${diff} phút, ${moTaMoc}.`;
  } else {
    message = `${PUNCH_KINDS[kind]} lúc ${hhmm} — đúng giờ, ${moTaMoc}`
            + (kind === 'in' && diff < 0 ? ` (sớm ${-diff} phút).` : '.');
  }

  return { ok: true, late_level: level, late_minutes: Math.max(0, diff), scheduled_at: sched, message };
}

/* Trạng thái ca hôm nay */
function shiftToday(user) {
  const tz = tzOf(user.location);
  const today = dayInTz(now(), tz);
  const row = db.prepare('SELECT * FROM shift_days WHERE user_id=? AND day=?').get(user.id, today);
  const from = zonedToUtc(today, '00:00', tz).getTime();

  const rows = db.prepare('SELECT * FROM punches WHERE user_id=? AND actual_at>=? ORDER BY actual_at')
    .all(user.id, from - 12 * 3600000);   // lùi 12h để bắt ca đêm

  const lastIn = [...rows].reverse().find((r) => r.kind === 'in');
  const lastOut = [...rows].reverse().find((r) => r.kind === 'out');

  const w = shiftWindow(user, now()).filter((c) => c.day === today)[0] || null;
  const ot = otOf(user.id, today);

  return {
    on_shift: !!(lastIn && (!lastOut || lastOut.actual_at < lastIn.actual_at)),
    checked_in_at: lastIn ? lastIn.actual_at : null,
    checked_out_at: lastOut ? lastOut.actual_at : null,
    day: today,
    location: user.location,
    timezone: tz,
    has_shift: !!w,
    shift_source: w ? w.source : null,          // 'file' hay 'default'
    shift_start: w ? w.start_hm : null,
    shift_end: w ? w.end_hm : null,
    must_be_in_by: w ? w.start - SHIFT_EARLY_MIN * 60000 : null,
    shift_end_at: w ? w.end : null,
    ot: ot ? { hours: ot.hours, reason: ot.reason } : null,
    rows: rows.map((r) => ({
      kind: r.kind, kind_label: PUNCH_KINDS[r.kind], actual_at: r.actual_at,
      late_minutes: r.late_minutes, late_level: r.late_level,
      late_label: r.late_level ? LATE_LEVELS[r.late_level].label : null,
    })),
  };
}

/* Lịch sử chấm công — quản trị xem hết, nhân viên chỉ thấy của mình */
function punchHistory(f = {}, viewer = null) {
  const w = [], p = [];
  if (viewer && viewer.role === 'staff') { w.push('p.user_id=?'); p.push(viewer.id); }
  else {
    const scope = scopeOf(viewer);
    if (scope !== null) { w.push('p.brand=?'); p.push(scope); }
    if (f.user_id) { w.push('p.user_id=?'); p.push(f.user_id); }
  }
  if (f.kind)       { w.push('p.kind=?');       p.push(f.kind); }
  if (f.department) { w.push('p.department=?'); p.push(f.department); }
  if (f.brand)      { w.push('p.brand=?');      p.push(f.brand); }
  if (f.from)       { w.push('p.actual_at>=?'); p.push(new Date(f.from + 'T00:00:00').getTime()); }
  if (f.to)         { w.push('p.actual_at<=?'); p.push(new Date(f.to + 'T23:59:59').getTime()); }
  if (f.late_level) { w.push('p.late_level=?'); p.push(f.late_level); }
  if (f.only_late)  w.push('p.late_level IS NOT NULL');

  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT p.*, u.name user_name FROM punches p JOIN users u ON u.id=p.user_id
     ${where} ORDER BY p.actual_at DESC LIMIT ?`).all(...p, Math.min(+f.limit || 300, 100000));

  const s = db.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN p.late_level='in5'   THEN 1 ELSE 0 END) a,
            SUM(CASE WHEN p.late_level='in30'  THEN 1 ELSE 0 END) b,
            SUM(CASE WHEN p.late_level='out60' THEN 1 ELSE 0 END) c,
            SUM(CASE WHEN p.kind='in'  THEN 1 ELSE 0 END) k_in,
            SUM(CASE WHEN p.kind='out' THEN 1 ELSE 0 END) k_out,
            SUM(CASE WHEN p.kind='log' THEN 1 ELSE 0 END) k_log
     FROM punches p ${where}`).get(...p);

  return {
    rows: rows.map((r) => ({
      id: r.id, user_name: r.user_name, user_id: r.user_id,
      kind: r.kind, kind_label: PUNCH_KINDS[r.kind],
      brand: r.brand, department: r.department,
      scheduled_at: r.scheduled_at, actual_at: r.actual_at,
      late_minutes: r.late_minutes, late_level: r.late_level,
      late_label: r.late_level ? LATE_LEVELS[r.late_level].label : null, ip: r.ip,
    })),
    stats: {
      total: s.total || 0, in5: s.a || 0, in30: s.b || 0, out60: s.c || 0,
      late: (s.a || 0) + (s.b || 0) + (s.c || 0),
      kind_in: s.k_in || 0, kind_out: s.k_out || 0, kind_log: s.k_log || 0,
    },
  };
}

/* Nhật ký VÀO/RA CA — gộp cặp lên ca + xuống ca của cùng một ngày một người.
   Đây là thứ quản lý cần khi hỏi "hôm qua ai vào lúc mấy giờ, ra lúc mấy giờ". */
function shiftLog(f = {}, scope = null) {
  const w = [], p = [];
  if (scope !== null) { w.push('p.brand=?');       p.push(scope); }
  if (f.user_id)      { w.push('p.user_id=?');     p.push(f.user_id); }
  if (f.department)   { w.push('p.department=?');  p.push(f.department); }
  if (f.brand)        { w.push('p.brand=?');       p.push(f.brand); }
  if (f.from)         { w.push('p.actual_at>=?');  p.push(new Date(f.from + 'T00:00:00').getTime()); }
  if (f.to)           { w.push('p.actual_at<=?');  p.push(new Date(f.to + 'T23:59:59').getTime()); }
  w.push("p.kind IN ('in','out')");

  const rows = db.prepare(
    `SELECT p.*, u.name user_name, u.emp_code, u.location
     FROM punches p JOIN users u ON u.id=p.user_id
     WHERE ${w.join(' AND ')} ORDER BY p.actual_at DESC LIMIT 2000`).all(...p);

  // Gộp theo người + ngày (theo giờ địa phương của người đó)
  const byKey = new Map();
  for (const r of rows) {
    const tz = tzOf(r.location || 'VN');
    const day = dayInTz(r.actual_at, tz);
    const k = `${r.user_id}|${day}`;
    if (!byKey.has(k)) {
      byKey.set(k, {
        user_id: r.user_id, user_name: r.user_name, emp_code: r.emp_code,
        department: r.department, brand: r.brand, day,
        in_at: null, out_at: null, in_late: null, in_late_min: 0,
        out_late: null, out_late_min: 0, in_sched: null, out_sched: null,
      });
    }
    const o = byKey.get(k);
    if (r.kind === 'in' && (!o.in_at || r.actual_at < o.in_at)) {
      o.in_at = r.actual_at; o.in_sched = r.scheduled_at;
      o.in_late = r.late_level; o.in_late_min = r.late_minutes;
    }
    if (r.kind === 'out' && (!o.out_at || r.actual_at > o.out_at)) {
      o.out_at = r.actual_at; o.out_sched = r.scheduled_at;
      o.out_late = r.late_level; o.out_late_min = r.late_minutes;
    }
  }

  const list = [...byKey.values()].map((o) => ({
    ...o,
    ot: (otOf(o.user_id, o.day) || {}).hours || 0,
    duration_min: o.in_at && o.out_at ? Math.round((o.out_at - o.in_at) / 60000) : null,
    missing_out: !!(o.in_at && !o.out_at),
  })).sort((a, b) => (b.in_at || 0) - (a.in_at || 0));

  return {
    rows: list,
    stats: {
      total: list.length,
      late_in: list.filter((x) => x.in_late).length,
      late_out: list.filter((x) => x.out_late).length,
      missing_out: list.filter((x) => x.missing_out).length,
      ot_days: list.filter((x) => x.ot > 0).length,
    },
  };
}

/* Chi tiết theo NGÀY cho một người — dùng cho nút "Xem lượt" ở tab Điểm danh */
function rollCallByDay(userId, f = {}) {
  const w = ['r.user_id=?'], p = [userId];
  if (f.from) { w.push('r.day>=?'); p.push(f.from); }
  if (f.to)   { w.push('r.day<=?'); p.push(f.to); }

  const rows = db.prepare(
    `SELECT r.day,
            COUNT(*) tong,
            SUM(CASE WHEN r.status='done'      THEN 1 ELSE 0 END) da_diem_danh,
            SUM(CASE WHEN r.status='missed'    THEN 1 ELSE 0 END) vang,
            SUM(CASE WHEN r.is_makeup=1        THEN 1 ELSE 0 END) luot_bu,
            SUM(CASE WHEN r.status='cancelled' THEN 1 ELSE 0 END) da_huy
     FROM roll_calls r WHERE ${w.join(' AND ')}
     GROUP BY r.day ORDER BY r.day DESC LIMIT 60`).all(...p);

  const chiTiet = db.prepare(
    `SELECT id, day, due_at, deadline_at, answered_at, status, is_makeup, defer_reason
     FROM roll_calls WHERE ${w.join(' AND ')} ORDER BY day DESC, due_at DESC LIMIT 300`).all(...p);

  return { byDay: rows, items: chiTiet };
}

/* Chi tiết hoạt động rời vị trí theo NGÀY của một người — cho nút "Xem lượt" ở tab Theo dõi */
function activityByDay(userId, f = {}) {
  const w = ['a.user_id=?'], p = [userId];
  if (f.from) { w.push("date(a.started_at/1000,'unixepoch','+7 hours')>=?"); p.push(f.from); }
  if (f.to)   { w.push("date(a.started_at/1000,'unixepoch','+7 hours')<=?"); p.push(f.to); }

  const rows = db.prepare(
    `SELECT date(a.started_at/1000,'unixepoch','+7 hours') ngay,
            COUNT(*) so_luot,
            SUM(IFNULL(a.duration_sec,0)) tong_giay,
            SUM(CASE WHEN a.is_over_limit=1 THEN 1 ELSE 0 END) qua_gio,
            SUM(CASE WHEN a.closed_by='auto' THEN 1 ELSE 0 END) quen_bam,
            SUM(CASE WHEN a.is_over_limit=1
                THEN MAX(0, IFNULL(a.duration_sec,0) - a.limit_minutes*60) ELSE 0 END) giay_lo
     FROM activities a WHERE ${w.join(' AND ')}
     GROUP BY ngay ORDER BY ngay DESC LIMIT 60`).all(...p);

  const items = db.prepare(
    `SELECT a.*, date(a.started_at/1000,'unixepoch','+7 hours') ngay
     FROM activities a WHERE ${w.join(' AND ')}
     ORDER BY a.started_at DESC LIMIT 300`).all(...p);

  return {
    byDay: rows.map((r) => ({
      ...r,
      tong_phut: Math.round(r.tong_giay / 60),
      phut_lo: Math.round(r.giay_lo / 60),
    })),
    items: items.map((a) => ({
      ...present({ ...a, user_name: null }),
      ngay: a.ngay, ended_at: a.ended_at, duration_sec: a.duration_sec,
      is_over_limit: !!a.is_over_limit, closed_by: a.closed_by,
      over_sec: a.is_over_limit ? Math.max(0, (a.duration_sec || 0) - a.limit_minutes * 60) : 0,
    })),
  };
}

/* Tổng hợp trễ THEO NGƯỜI — thứ quản lý cần ở mục này, thay vì nhật ký từng lượt.
   Xếp theo mức nghiêm trọng: trễ nặng trước, rồi tới tổng số phút. */
function lateByUser(f = {}, scope = null) {
  const w = ['p.late_level IS NOT NULL'], p = [];
  if (scope !== null)  { w.push('p.brand=?');       p.push(scope); }
  if (f.user_id)       { w.push('p.user_id=?');     p.push(f.user_id); }
  if (f.department)    { w.push('p.department=?');  p.push(f.department); }
  if (f.brand)         { w.push('p.brand=?');       p.push(f.brand); }
  if (f.late_level)    { w.push('p.late_level=?');  p.push(f.late_level); }
  if (f.from)          { w.push('p.actual_at>=?');  p.push(new Date(f.from + 'T00:00:00').getTime()); }
  if (f.to)            { w.push('p.actual_at<=?');  p.push(new Date(f.to + 'T23:59:59').getTime()); }

  const where = 'WHERE ' + w.join(' AND ');
  const rows = db.prepare(
    `SELECT u.id, u.name user_name, p.department, p.brand,
            COUNT(*) times,
            SUM(p.late_minutes) total_minutes,
            MAX(p.late_minutes) worst_minutes,
            MAX(p.actual_at) last_at,
            SUM(CASE WHEN p.late_level='in5'   THEN 1 ELSE 0 END) in5,
            SUM(CASE WHEN p.late_level='in30'  THEN 1 ELSE 0 END) in30,
            SUM(CASE WHEN p.late_level='out60' THEN 1 ELSE 0 END) out60
     FROM punches p JOIN users u ON u.id=p.user_id
     ${where}
     GROUP BY u.id, p.department, p.brand
     ORDER BY (SUM(CASE WHEN p.late_level='in30' THEN 1 ELSE 0 END)
             + SUM(CASE WHEN p.late_level='out60' THEN 1 ELSE 0 END)) DESC,
              SUM(p.late_minutes) DESC`).all(...p);

  return {
    rows,
    stats: {
      people: rows.length,
      times: rows.reduce((n, r) => n + r.times, 0),
      minutes: rows.reduce((n, r) => n + r.total_minutes, 0),
      heavy: rows.reduce((n, r) => n + r.in30 + r.out60, 0),
    },
  };
}

/* ============================================================
   LỊCH OFF
   ============================================================ */
const isOffDay = (userId, day) =>
  !!db.prepare('SELECT 1 FROM day_offs WHERE user_id=? AND day=?').get(userId, day);

const ymOf = (day) => String(day).slice(0, 7);
const isLocked = (ym) => !!db.prepare('SELECT 1 FROM off_locks WHERE ym=?').get(ym);

/* Những ai trong cùng bộ phận đã nhận ngày đó */
function whoOff(brand, dept, day, exceptUserId = null) {
  return db.prepare(
    `SELECT u.id, u.name FROM day_offs d JOIN users u ON u.id=d.user_id
     WHERE d.day=? AND IFNULL(u.brand,'-')=? AND IFNULL(u.department,'-')=?
       AND u.is_active=1 AND u.role='staff' AND (? IS NULL OR u.id<>?)`
  ).all(day, brand || '-', dept || '-', exceptUserId, exceptUserId);
}

function myOffs(user, ym) {
  const days = db.prepare('SELECT day FROM day_offs WHERE user_id=? AND day LIKE ? ORDER BY day')
    .all(user.id, ym + '%').map((r) => r.day);

  // Ngày đã đủ người nghỉ trong bộ phận -> làm mờ trên lịch thay vì để bấm rồi báo lỗi
  const rows = db.prepare(
    `SELECT d.day, u.name, COUNT(*) OVER (PARTITION BY d.day) n
     FROM day_offs d JOIN users u ON u.id=d.user_id
     WHERE d.day LIKE ? AND IFNULL(u.brand,'-')=? AND IFNULL(u.department,'-')=?
       AND u.is_active=1 AND u.role='staff' AND u.id<>?`
  ).all(ym + '%', user.brand || '-', user.department || '-', user.id);

  const byDay = {};
  rows.forEach((r) => { (byDay[r.day] = byDay[r.day] || []).push(r.name); });
  const taken = Object.entries(byDay)
    .filter(([, names]) => names.length >= MAX_OFF_PER_DAY_DEPT)
    .map(([day, names]) => ({ day, names }));

  // Lịch chính thức tháng đó — dùng để đối chiếu nguyện vọng đã được duyệt hay chưa
  const workDays = db.prepare('SELECT day FROM shift_days WHERE user_id=? AND day LIKE ? ORDER BY day')
    .all(user.id, ym + '%').map((r) => r.day);
  const workSet = new Set(workDays);

  const approved = days.filter((d) => !workSet.has(d));   // xin nghỉ, lịch cũng cho nghỉ
  const rejected = days.filter((d) => workSet.has(d));    // xin nghỉ nhưng lịch vẫn xếp ca

  return {
    ym, days, used: days.length, max: MAX_OFF_PER_MONTH,
    locked: isLocked(ym), taken, per_day: MAX_OFF_PER_DAY_DEPT,
    has_schedule: workDays.length > 0,
    work_days: workDays,
    approved: approved.length,
    rejected: rejected.length,
  };
}

function toggleOff(user, day, byAdmin = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, message: 'Ngày không hợp lệ.' };
  const ym = ymOf(day);
  if (isLocked(ym) && !byAdmin) {
    return { ok: false, message: `Tháng ${ym} đã bị khóa. Liên hệ quản lý nếu cần đổi.` };
  }

  const has = db.prepare('SELECT id FROM day_offs WHERE user_id=? AND day=?').get(user.id, day);
  const dm = day.split('-').reverse().join('/');
  if (has) {
    db.prepare('DELETE FROM day_offs WHERE id=?').run(has.id);
    return { ok: true, message: `Đã bỏ ngày nghỉ ${dm}.`, off: myOffs(user, ym) };
  }

  const used = db.prepare('SELECT COUNT(*) n FROM day_offs WHERE user_id=? AND day LIKE ?')
    .get(user.id, ym + '%').n;
  if (used >= MAX_OFF_PER_MONTH && !byAdmin) {
    return { ok: false, message: `Tháng này đã đủ ${MAX_OFF_PER_MONTH} ngày. Bỏ bớt ngày khác rồi chọn lại.` };
  }

  // Trùng ngày trong cùng bộ phận. Node chạy một luồng và better-sqlite3 chạy đồng bộ,
  // nên đoạn đếm rồi ghi này không bị chen ngang giữa chừng.
  const others = whoOff(user.brand, user.department, day, user.id);
  if (others.length >= MAX_OFF_PER_DAY_DEPT && !byAdmin) {
    return {
      ok: false,
      message: MAX_OFF_PER_DAY_DEPT === 1
        ? `${others[0].name} đã nhận nghỉ ngày ${dm}. Mỗi bộ phận chỉ 1 người nghỉ mỗi ngày.`
        : `Ngày ${dm} đã đủ ${MAX_OFF_PER_DAY_DEPT} người nghỉ (${others.map((o) => o.name).join(', ')}).`,
    };
  }

  db.prepare('INSERT INTO day_offs (user_id,day,brand,department,created_at) VALUES (?,?,?,?,?)')
    .run(user.id, day, user.brand, user.department, now());
  return { ok: true, message: `Đã đăng ký nghỉ ${dm}.`, off: myOffs(user, ym) };
}

/* Tổng hợp cho quản trị: Tất cả / Chưa đăng ký / 1 / 2 / 3 / 4 ngày */
function offSummary(ym, f = {}, scope = null) {
  const filter = String(f.filter || '');
  const rows = db.prepare(
    `SELECT u.id, u.name, u.department, u.brand,
            (SELECT COUNT(*) FROM day_offs d WHERE d.user_id=u.id AND d.day LIKE ?) n,
            (SELECT GROUP_CONCAT(d.day) FROM day_offs d WHERE d.user_id=u.id AND d.day LIKE ?) days
     FROM users u WHERE u.role='staff' AND u.is_active=1
     ORDER BY u.department, u.name`).all(ym + '%', ym + '%')
    .filter((r) => inScope(scope, r.brand)
                && (!f.user_id || r.id === +f.user_id)
                && (!f.department || r.department === f.department)
                && (!f.brand || r.brand === f.brand));

  const workStmt = db.prepare('SELECT day FROM shift_days WHERE user_id=? AND day LIKE ?');
  const shaped = rows.map((r) => {
    const reqDays = r.days ? r.days.split(',').sort() : [];
    const workSet = new Set(workStmt.all(r.id, ym + '%').map((x) => x.day));
    return {
      ...r,
      days: reqDays,
      has_schedule: workSet.size > 0,
      // Nguyện vọng được duyệt = ngày xin nghỉ mà lịch chính thức cũng cho nghỉ
      approved: reqDays.filter((d) => !workSet.has(d)),
      rejected: reqDays.filter((d) => workSet.has(d)),
      work_days: workSet.size,
    };
  });

  return {
    ym, locked: isLocked(ym), max: MAX_OFF_PER_MONTH,
    rows: shaped.filter((r) => {
      if (filter === 'none')    return r.n === 0;
      if (filter === 'partial') return r.n > 0 && r.n < MAX_OFF_PER_MONTH;
      if (filter === 'full')    return r.n >= MAX_OFF_PER_MONTH;
      if (filter === 'conflict') return r.rejected.length > 0;
      if (/^\d{1,2}$/.test(filter)) return r.n === +filter;
      return true;
    }),
    has_schedule: shaped.some((r) => r.has_schedule),
    counts: {
      all: rows.length,
      none: rows.filter((r) => r.n === 0).length,
      partial: rows.filter((r) => r.n > 0 && r.n < MAX_OFF_PER_MONTH).length,
      full: rows.filter((r) => r.n >= MAX_OFF_PER_MONTH).length,
      // Người có nguyện vọng bị lịch xếp đè lên
      conflict: shaped.filter((r) => r.rejected.length > 0).length,
      // Số người theo từng mức cụ thể, dùng cho ô chọn chi tiết
      byDays: Array.from({ length: MAX_OFF_PER_MONTH }, (_, i) =>
        rows.filter((r) => r.n === i + 1).length),
    },
  };
}

function setLock(ym, locked) {
  if (locked) db.prepare('INSERT OR REPLACE INTO off_locks (ym,locked_at) VALUES (?,?)').run(ym, now());
  else db.prepare('DELETE FROM off_locks WHERE ym=?').run(ym);
  return { ok: true, message: locked ? `Đã khóa lịch off tháng ${ym}.` : `Đã mở lịch off tháng ${ym}.` };
}

/* ============================================================
   ÁP LỊCH THÁNG
   mode 'merge'   : chỉ đụng tới người có trong file, người khác giữ nguyên
   mode 'replace' : xoá sạch lịch tháng đó của MỌI người rồi ghi lại theo file
   ============================================================ */
function applySchedule(parsed, mode = 'merge', scope = null) {
  const { ym, rows } = parsed;
  const matched = [], missing = [], outside = [], keySet = [];

  const byKey = db.prepare("SELECT * FROM users WHERE key=? AND role='staff'");
  const byName = db.prepare("SELECT * FROM users WHERE name=? AND role='staff'");

  const resolved = rows.map((r) => {
    const u = (r.key && byKey.get(r.key.toUpperCase())) || (r.name && byName.get(r.name)) || null;
    if (!u) { missing.push(r.name || r.key); return null; }
    // Admin của brand này không được đụng vào người của brand kia
    if (!inScope(scope, u.brand)) { outside.push(u.name); return null; }
    matched.push(u.name);
    return { user: u, rec: r };
  }).filter(Boolean);

  const delMonth = db.prepare("DELETE FROM shift_days WHERE day LIKE ?");
  const delUser = db.prepare("DELETE FROM shift_days WHERE user_id=? AND day LIKE ?");
  const ins = db.prepare('INSERT OR REPLACE INTO shift_days (user_id,day,start_hm,end_hm) VALUES (?,?,?,?)');
  const updMeta = db.prepare('UPDATE users SET location=?, department=?, brand=? WHERE id=?');

  let dayCount = 0;
  db.transaction(() => {
    if (mode === 'replace') {
      // Ghi đè chỉ xoá lịch của người trong phạm vi, không đụng brand khác
      if (scope === null) delMonth.run(ym + '%');
      else db.prepare(
        `DELETE FROM shift_days WHERE day LIKE ?
         AND user_id IN (SELECT id FROM users WHERE brand=?)`).run(ym + '%', scope);
    }

    for (const { user, rec } of resolved) {
      if (mode !== 'replace') delUser.run(user.id, ym + '%');

      // File cũng là nguồn cập nhật khu vực / bộ phận / brand nếu có ghi
      const loc = LOCATIONS.includes(String(rec.location).toUpperCase())
        ? String(rec.location).toUpperCase() : user.location;
      const dep = DEPTS.includes(String(rec.department).toUpperCase())
        ? String(rec.department).toUpperCase() : user.department;
      let br = BRANDS.includes(String(rec.brand).toUpperCase())
        ? String(rec.brand).toUpperCase() : user.brand;
      if (scope !== null) br = user.brand;   // admin theo brand không được chuyển người sang brand khác
      updMeta.run(loc, dep, br, user.id);

      // Mã cá nhân đi kèm trong file: băm rồi lưu, số gốc không giữ lại đâu cả
      if (rec.personal_key && KEY_RE.test(rec.personal_key)) {
        db.prepare('UPDATE users SET key_hash=?, key_month=?, key_set_at=? WHERE id=?')
          .run(bcryptLib.hashSync(rec.personal_key, 10),
               rec.key_month || null, now(), user.id);
        keySet.push(user.name);
      }

      for (const [day, t] of Object.entries(rec.days)) {
        ins.run(user.id, day, t.start, t.end);
        dayCount++;
      }
    }
  })();

  return { ym, mode, matched, missing, outside, keySet, dayCount, errors: parsed.errors };
}

/* Lịch tháng của một người, để hiển thị */
function scheduleOf(userId, ym) {
  return db.prepare('SELECT day, start_hm, end_hm FROM shift_days WHERE user_id=? AND day LIKE ? ORDER BY day')
    .all(userId, ym + '%');
}

/* Tổng quan lịch tháng cho quản trị */
function scheduleSummary(ym, scope = null) {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.location, u.department, u.brand,
            (SELECT COUNT(*) FROM shift_days s WHERE s.user_id=u.id AND s.day LIKE ?) work_days
     FROM users u WHERE u.role='staff' AND u.is_active=1 AND (? IS NULL OR u.brand=?)
     ORDER BY u.location, u.department, u.name`
  ).all(ym + '%', scope, scope);

  const [y, mo] = ym.split('-').map(Number);
  const dim = new Date(y, mo, 0).getDate();

  return {
    ym, days_in_month: dim,
    rows: rows.map((r) => ({ ...r, off_days: dim - r.work_days, timezone: tzOf(r.location) })),
    no_schedule: rows.filter((r) => r.work_days === 0).length,
  };
}

/* ============================================================
   MÃ CÁ NHÂN — lấy từ lương tháng trước, dạng 5 chữ số
   Quản lý nhập giúp từng người, hệ thống chỉ lưu bản băm.
   ============================================================ */
const bcryptLib = require("bcryptjs");
// Quản lý tự quyết nội dung mã: chữ, số, ký hiệu đều được. Chỉ chặn khoảng trắng
// và mã quá ngắn. Ví dụ "x2560", "HA-0825", "52560" đều hợp lệ.
const KEY_RE = /^\S{4,32}$/;

function setPersonalKey(userId, key, month) {
  if (!KEY_RE.test(String(key || ""))) {
    return { ok: false, message: "Mã cá nhân cần 4–32 ký tự, không chứa khoảng trắng." };
  }
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!u) return { ok: false, message: "Không tìm thấy nhân viên." };

  db.prepare("UPDATE users SET key_hash=?, key_month=?, key_set_at=? WHERE id=?")
    .run(bcryptLib.hashSync(String(key), 10), month || null, now(), userId);

  return { ok: true, message: `Đã đặt mã cá nhân cho ${u.name}.` };
}

function hasPersonalKey(user) {
  return !!(user && user.key_hash);
}

/* Kiểm tra mã. Chưa đặt mã thì cho qua để không kẹt lúc mới triển khai. */
function checkPersonalKey(user, key) {
  if (!user.key_hash) return { ok: true, skipped: true };
  if (!KEY_RE.test(String(key || ""))) {
    return { ok: false, message: "Nhập mã cá nhân của bạn." };
  }
  if (!bcryptLib.compareSync(String(key), user.key_hash)) {
    return { ok: false, message: "Mã cá nhân không đúng." };
  }
  return { ok: true };
}

/* ============================================================
   ĐIỂM DANH NGẪU NHIÊN TRONG CA
   ============================================================ */
const RC_PER_SHIFT   = Math.max(1, Number(process.env.ROLL_CALLS_PER_SHIFT) || 4);
const RC_WINDOW_MIN  = Math.max(1, Number(process.env.ROLL_CALL_WINDOW_MIN) || 5);
const RC_MAKEUP_MIN  = Math.max(1, Number(process.env.ROLL_CALL_MAKEUP_MIN) || 3);

/* Sinh lịch điểm danh cho một ca: N mốc ngẫu nhiên, cách đầu và cuối ca 20 phút,
   và cách nhau tối thiểu 25 phút để không dồn cục. */
/* Đã xuống ca hôm nay chưa */
function hasCheckedOut(user) {
  const st = shiftToday(user);
  return !!(st.checked_out_at && (!st.checked_in_at || st.checked_out_at > st.checked_in_at));
}

/* Huỷ các lượt điểm danh còn treo — gọi khi bấm Xuống ca */
function cancelPendingRollCalls(userId) {
  const r = db.prepare(
    "UPDATE roll_calls SET status='cancelled', defer_reason='Đã xuống ca' " +
    "WHERE user_id=? AND status IN ('pending','waiting')"
  ).run(userId);
  return r.changes;
}

function planRollCalls(user, day, startUtc, endUtc) {
  const existed = db.prepare(
    "SELECT COUNT(*) n FROM roll_calls WHERE user_id=? AND day=? AND is_makeup=0"
  ).get(user.id, day).n;
  if (existed > 0) return 0;

  const pad = 20 * 60000, minGap = 25 * 60000;
  const from = startUtc + pad, to = endUtc - pad;
  if (to <= from) return 0;

  const picks = [];
  for (let i = 0; i < RC_PER_SHIFT * 6 && picks.length < RC_PER_SHIFT; i++) {
    const t = from + Math.floor(Math.random() * (to - from));
    if (picks.every((p) => Math.abs(p - t) >= minGap)) picks.push(t);
  }
  picks.sort((a, b) => a - b);

  const ins = db.prepare(`INSERT INTO roll_calls
    (user_id,brand,department,day,due_at,deadline_at,status,created_at)
    VALUES (?,?,?,?,?,?, 'pending', ?)`);
  db.transaction(() => {
    picks.forEach((t) => ins.run(user.id, user.brand, user.department, day,
                                 t, t + RC_WINDOW_MIN * 60000, now()));
  })();
  return picks.length;
}

/* Quét mỗi phút: sinh lịch cho ca đang diễn ra, và chốt các lượt quá hạn.
   Lượt đến hạn khi người đó ĐANG rời vị trí thì hoãn, không tính vắng. */
function sweepRollCalls() {
  const t = now();
  let planned = 0, missed = 0, deferred = 0;

  const staff = db.prepare("SELECT * FROM users WHERE role='staff' AND is_active=1").all();
  for (const u of staff) {
    if (hasCheckedOut(u)) continue;                 // đã xuống ca thì không sinh thêm
    const w = shiftWindow(u, t);
    for (const c of w) {
      // Sinh ngay khi biết ca, kể cả ca chưa bắt đầu — nhờ vậy quản trị xem
      // được trước cả ngày ai sẽ bị điểm danh lúc mấy giờ.
      if (t <= c.end) planned += planRollCalls(u, c.day, c.start, c.end);
    }
  }

  // Lượt ĐÃ TỚI GIỜ mà người đó đang rời vị trí -> hoãn ngay, không chờ hết hạn
  const dueNow = db.prepare(
    "SELECT * FROM roll_calls WHERE status='pending' AND due_at IS NOT NULL AND due_at <= ? AND deadline_at >= ?"
  ).all(t, t);
  for (const rc of dueNow) {
    const open = openFor(rc.user_id);
    if (open) { deferRollCall(rc, open); deferred++; }
  }

  const due = db.prepare(
    "SELECT * FROM roll_calls WHERE status='pending' AND deadline_at IS NOT NULL AND deadline_at < ?"
  ).all(t);

  const userOf = db.prepare('SELECT * FROM users WHERE id=?');

  for (const rc of due) {
    const u = userOf.get(rc.user_id);

    // Đã xuống ca trước khi lượt tới hạn -> huỷ, không tính vắng
    if (u && hasCheckedOut(u)) {
      db.prepare("UPDATE roll_calls SET status='cancelled', defer_reason='Đã xuống ca' WHERE id=?")
        .run(rc.id);
      continue;
    }

    const open = openFor(rc.user_id);
    if (open) {
      deferRollCall(rc, open);
      deferred++;
    } else {
      db.prepare("UPDATE roll_calls SET status='missed' WHERE id=?").run(rc.id);
      missed++;
    }
  }
  return { planned, missed, deferred };
}

/* Gọi sau khi nhân viên bấm Dừng lại: kích hoạt các lượt bù đang chờ. */
function releaseMakeups(userId) {
  const waiting = db.prepare("SELECT * FROM roll_calls WHERE user_id=? AND status='waiting'").all(userId);
  if (!waiting.length) return 0;
  const due = now() + RC_MAKEUP_MIN * 60000;
  const upd = db.prepare("UPDATE roll_calls SET status='pending', due_at=?, deadline_at=? WHERE id=?");
  db.transaction(() => waiting.forEach((rc) => upd.run(due, due + RC_WINDOW_MIN * 60000, rc.id)))();
  return waiting.length;
}

/* Hoãn một lượt vì nhân viên đang rời vị trí, và tạo sẵn lượt bù. */
function deferRollCall(rc, openActivity) {
  const tên = (typeByCode(openActivity.type_code) || {}).name || 'hoạt động';
  db.prepare("UPDATE roll_calls SET status='deferred', defer_reason=? WHERE id=?")
    .run('Đang rời vị trí: ' + tên, rc.id);

  // Chưa có lượt bù nào đang chờ thì tạo, tránh chồng nhiều lượt bù
  const đãCó = db.prepare(
    "SELECT 1 FROM roll_calls WHERE user_id=? AND status='waiting' AND is_makeup=1"
  ).get(rc.user_id);

  if (!đãCó) {
    db.prepare(`INSERT INTO roll_calls
      (user_id,brand,department,day,due_at,deadline_at,status,is_makeup,defer_reason,created_at)
      VALUES (?,?,?,?,NULL,NULL,'waiting',1,?,?)`)
      .run(rc.user_id, rc.brand, rc.department, rc.day,
           'Chờ kết thúc hoạt động rồi điểm danh bù', now());
  }
  return true;
}

/* Lượt điểm danh đang cần trả lời của một người (đã tới giờ, chưa quá hạn).
   Nếu người đó ĐANG rời vị trí thì hoãn NGAY, không để thẻ hiện ra rồi đếm ngược —
   họ đang ở ngoài, có đòi cũng không xác nhận được. */
function activeRollCall(userId) {
  const t = now();
  const rc = db.prepare(
    `SELECT * FROM roll_calls WHERE user_id=? AND status='pending'
     AND due_at IS NOT NULL AND due_at<=? AND deadline_at>=? ORDER BY due_at LIMIT 1`
  ).get(userId, t, t);
  if (!rc) return null;

  const open = openFor(userId);
  if (open) { deferRollCall(rc, open); return null; }

  return rc;
}

function answerRollCall(user, key, ip) {
  const rc = activeRollCall(user.id);
  if (!rc) return { ok: false, message: "Không có lượt điểm danh nào đang chờ." };

  const chk = checkPersonalKey(user, key);
  if (!chk.ok) return chk;

  db.prepare("UPDATE roll_calls SET status='done', answered_at=?, ip=? WHERE id=?")
    .run(now(), ip, rc.id);
  return {
    ok: true,
    message: rc.is_makeup ? "Đã điểm danh bù xong." : "Đã điểm danh.",
  };
}

/* Bắn điểm danh thủ công ngay lập tức — dùng khi cần kiểm tra đột xuất.
   Chỉ bắn cho người ĐANG TRONG CA, vì bắn cho người nghỉ là tính vắng oan. */
function fireRollCall({ who = 'all', windowMin = RC_WINDOW_MIN, scope = null } = {}) {
  const t = now();
  let list = db.prepare("SELECT * FROM users WHERE role='staff' AND is_active=1").all();

  if (scope !== null) list = list.filter((u) => u.brand === scope);
  if (String(who).startsWith('dept:')) {
    const dep = String(who).slice(5);
    list = list.filter((u) => u.department === dep);
  } else if (String(who).startsWith('user:')) {
    const id = +String(who).slice(5);
    list = list.filter((u) => u.id === id);
  }

  const ins = db.prepare(`INSERT INTO roll_calls
    (user_id,brand,department,day,due_at,deadline_at,status,is_makeup,defer_reason,created_at)
    VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`);

  const fired = [], skipped = [];
  db.transaction(() => {
    for (const u of list) {
      const w = shiftWindow(u, t).filter((c) => t >= c.start && t <= c.end);
      if (!w.length) { skipped.push(u.name); continue; }        // không trong ca
      if (hasCheckedOut(u)) { skipped.push(u.name + ' (đã xuống ca)'); continue; }
      const đangĐi = openFor(u.id);
      if (đangĐi) {
        skipped.push(u.name + ' (đang ' + ((typeByCode(đangĐi.type_code) || {}).name || 'rời vị trí') + ')');
        continue;
      }
      // Đang có lượt chờ rồi thì thôi, khỏi chồng lượt
      const đangCó = db.prepare(
        "SELECT 1 FROM roll_calls WHERE user_id=? AND status='pending' AND deadline_at>=?"
      ).get(u.id, t);
      if (đangCó) { skipped.push(u.name + ' (đang có lượt chờ)'); continue; }

      ins.run(u.id, u.brand, u.department, w[0].day, t, t + windowMin * 60000,
              'Quản trị bắn thủ công', t);
      fired.push(u.name);
    }
  })();

  return {
    ok: fired.length > 0,
    fired, skipped,
    message: fired.length
      ? `Đã bắn cho ${fired.length} người: ${fired.slice(0, 6).join(', ')}`
        + (fired.length > 6 ? '…' : '') + `. Phải xác nhận trong ${windowMin} phút.`
      : 'Không có ai đang trong ca theo lịch. Kiểm tra đã nhập lịch ca tháng này chưa.',
  };
}

/* Các lượt điểm danh CHƯA tới hạn hoặc ĐANG chờ trả lời.
   Quản trị nhìn vào biết sắp tới lượt ai, khỏi phải ngồi đoán. */
function upcomingRollCalls(scope = null, limit = 40) {
  const t = now();
  const rows = db.prepare(
    `SELECT r.*, u.name user_name, u.emp_code
     FROM roll_calls r JOIN users u ON u.id=r.user_id
     WHERE r.status IN ('pending','waiting')
       AND (? IS NULL OR r.brand=?)
     ORDER BY (r.due_at IS NULL), r.due_at
     LIMIT ?`
  ).all(scope, scope, limit);

  return rows.map((r) => {
    let state = 'scheduled';                       // còn lâu mới tới
    if (r.status === 'waiting') state = 'waiting'; // chờ nhân viên bấm Dừng lại
    else if (r.due_at && t >= r.due_at && t <= r.deadline_at) state = 'active';   // đang phải trả lời
    else if (r.due_at && t < r.due_at && r.due_at - t <= 10 * 60000) state = 'soon'; // sắp tới trong 10 phút

    return {
      id: r.id, user_id: r.user_id, user_name: r.user_name, emp_code: r.emp_code,
      department: r.department, brand: r.brand, day: r.day,
      due_at: r.due_at, deadline_at: r.deadline_at,
      is_makeup: !!r.is_makeup, defer_reason: r.defer_reason,
      state,
      in_seconds: r.due_at ? Math.round((r.due_at - t) / 1000) : null,
    };
  });
}

/* Thống kê điểm danh cho quản trị */
function rollCallReport(f = {}, scope = null) {
  const w = [], p = [];
  if (scope !== null) { w.push("r.brand=?"); p.push(scope); }
  if (f.user_id)      { w.push("r.user_id=?"); p.push(f.user_id); }
  if (f.department)   { w.push("r.department=?"); p.push(f.department); }
  if (f.brand)        { w.push("r.brand=?"); p.push(f.brand); }
  if (f.from)         { w.push("r.day>=?"); p.push(f.from); }
  if (f.to)           { w.push("r.day<=?"); p.push(f.to); }
  const where = w.length ? "WHERE " + w.join(" AND ") : "";

  const rows = db.prepare(
    `SELECT u.id, u.name user_name, r.department, r.brand,
            COUNT(*) tong,
            SUM(CASE WHEN r.status='done'     THEN 1 ELSE 0 END) da_diem_danh,
            SUM(CASE WHEN r.status='missed'   THEN 1 ELSE 0 END) vang,
            SUM(CASE WHEN r.is_makeup=1       THEN 1 ELSE 0 END) luot_bu,
            SUM(CASE WHEN r.status IN ('pending','waiting') THEN 1 ELSE 0 END) dang_cho,
            SUM(CASE WHEN r.status='cancelled' THEN 1 ELSE 0 END) da_huy
     FROM roll_calls r JOIN users u ON u.id=r.user_id
     ${where} GROUP BY u.id, r.department, r.brand
     ORDER BY vang DESC, tong DESC`).all(...p);

  const s = rows.reduce((a, r) => ({
    tong: a.tong + r.tong, done: a.done + r.da_diem_danh,
    missed: a.missed + r.vang, makeup: a.makeup + r.luot_bu,
  }), { tong: 0, done: 0, missed: 0, makeup: 0 });

  return { rows, stats: s };
}

/* ============================================================
   MÃ NHÂN VIÊN — để khớp dòng trong sheet báo cáo
   Không bí mật, lộ ra cũng không mở được gì.
   ============================================================ */
const DEPT_PREFIX = { 'CS': 'CS', 'CS ONL': 'CSO', 'VIP': 'VIP', 'RISK': 'RSK', 'RISK ONL': 'RSO' };

function ensureEmpCode(user) {
  if (user.emp_code) return user.emp_code;
  const pre = DEPT_PREFIX[user.department] || 'NV';
  const used = new Set(db.prepare('SELECT emp_code FROM users WHERE emp_code IS NOT NULL')
    .all().map((r) => r.emp_code));
  let n = 1, code;
  do { code = pre + String(n++).padStart(2, '0'); } while (used.has(code));
  db.prepare('UPDATE users SET emp_code=? WHERE id=?').run(code, user.id);
  return code;
}

function setEmpCode(userId, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{2,16}$/.test(c)) {
    return { ok: false, message: 'Mã nhân viên 2–16 ký tự, chỉ chữ, số và . _ -' };
  }
  const dup = db.prepare('SELECT id FROM users WHERE emp_code=? AND id<>?').get(c, userId);
  if (dup) return { ok: false, message: `Mã ${c} đã có người dùng.` };
  db.prepare('UPDATE users SET emp_code=? WHERE id=?').run(c, userId);
  return { ok: true, message: `Đã đổi mã nhân viên thành ${c}.` };
}

/* Cấp mã cho mọi người chưa có */
function backfillEmpCodes() {
  const list = db.prepare("SELECT * FROM users WHERE role='staff' AND emp_code IS NULL").all();
  list.forEach(ensureEmpCode);
  return list.length;
}

/* ============================================================
   GIỜ CA MẶC ĐỊNH & LÀM THÊM GIỜ
   ============================================================ */
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* Độ dài ca: 8 tiếng, 10 tiếng… Dùng để suy giờ ra từ giờ vào trong file lịch. */
function setShiftHours(userId, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > 16) {
    return { ok: false, message: 'Độ dài ca phải từ 1 đến 16 tiếng.' };
  }
  db.prepare('UPDATE users SET shift_hours=? WHERE id=?').run(h, userId);
  return { ok: true, message: `Đã đặt ca ${h} tiếng.` };
}

function setShiftHoursBulk(dept, hours, scope = null) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > 16) {
    return { ok: false, message: 'Độ dài ca phải từ 1 đến 16 tiếng.' };
  }
  const rows = db.prepare(
    `SELECT id FROM users WHERE role='staff' AND is_active=1
     AND (? IS NULL OR department=?) AND (? IS NULL OR brand=?)`
  ).all(dept || null, dept || null, scope, scope);
  const upd = db.prepare('UPDATE users SET shift_hours=? WHERE id=?');
  db.transaction(() => rows.forEach((r) => upd.run(h, r.id)))();
  return { ok: true, message: `Đã đặt ca ${h} tiếng cho ${rows.length} người.` };
}


/* Đặt hàng loạt cho một bộ phận */

/* Ghi nhận OT cho ngày hôm nay */
function setOT(user, hours, reason, byAdmin = false, day = null) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 12) {
    return { ok: false, message: 'Số giờ OT phải từ 0.5 đến 12.' };
  }
  const d = day || dayInTz(now(), tzOf(user.location));
  const w = shiftWindow(user, now()).filter((c) => c.day === d);
  if (!w.length && !byAdmin) {
    return { ok: false, message: 'Hôm nay bạn không có ca nên không ghi nhận OT được.' };
  }
  db.prepare(`INSERT OR REPLACE INTO ot_records (user_id,day,hours,reason,by_admin,created_at)
              VALUES (?,?,?,?,?,?)`).run(user.id, d, h, reason || null, byAdmin ? 1 : 0, now());
  return { ok: true, message: `Đã ghi nhận OT ${h} giờ cho ngày ${d.split('-').reverse().join('/')}.` };
}

function clearOT(userId, day) {
  db.prepare('DELETE FROM ot_records WHERE user_id=? AND day=?').run(userId, day);
  return { ok: true, message: 'Đã bỏ ghi nhận OT.' };
}

function otToday(user) {
  const d = dayInTz(now(), tzOf(user.location));
  const r = otOf(user.id, d);
  return r ? { day: d, hours: r.hours, reason: r.reason, by_admin: !!r.by_admin } : null;
}

/* ============================================================
   NỢ BÁO CÁO
   Có ca trong lịch mà không có dòng nào trong sheet = nợ.
   ============================================================ */
const REPORT_DEPTS = (process.env.REPORT_DEPTS || 'CS,CS ONL,VIP,RISK,RISK ONL')
  .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const REPORT_GRACE_MIN   = Math.max(0, Number(process.env.REPORT_GRACE_MIN) || 60);
const REPORT_BLOCK_AFTER = Math.max(1, Number(process.env.REPORT_BLOCK_AFTER) || 1);
const REPORT_ALERT_AFTER = Math.max(1, Number(process.env.REPORT_ALERT_AFTER) || 3);

const isExempt = (userId, day) =>
  !!db.prepare('SELECT 1 FROM report_exempt WHERE user_id=? AND day=?').get(userId, day);

function setExempt(userId, day, reason, byAdmin) {
  db.prepare(`INSERT OR REPLACE INTO report_exempt (user_id,day,reason,by_admin,created_at)
              VALUES (?,?,?,?,?)`).run(userId, day, reason || null, byAdmin ? 1 : 0, now());
  return { ok: true, message: `Đã đánh dấu ca ${day.split('-').reverse().join('/')} không phát sinh.` };
}

function clearExempt(userId, day) {
  db.prepare('DELETE FROM report_exempt WHERE user_id=? AND day=?').run(userId, day);
  return { ok: true, message: 'Đã bỏ đánh dấu miễn báo cáo.' };
}

/* Các ngày đã có ca của một người, tính lùi N ngày, KHÔNG tính hôm nay */
function pastShiftDays(user, backDays = 14) {
  const tz = tzOf(user.location);
  const today = dayInTz(now(), tz);
  const rows = db.prepare(
    'SELECT day FROM shift_days WHERE user_id=? AND day<? ORDER BY day DESC LIMIT ?'
  ).all(user.id, today, backDays);
  return rows.map((r) => r.day);
}

const hasShiftOn = (userId, day) =>
  !!db.prepare('SELECT 1 FROM shift_days WHERE user_id=? AND day=?').get(userId, day);

function todayOf(user) {
  return dayInTz(now(), tzOf(user.location));
}

/* Ca hôm nay đã kết thúc chưa (cộng thêm thời gian ân hạn) */
function shiftEndedToday(user) {
  const w = shiftWindow(user, now());
  if (!w.length) return null;
  const c = w[w.length - 1];
  return now() > c.end + REPORT_GRACE_MIN * 60000;
}

const allUsers = (scope = null) =>
  db.prepare(
    `SELECT u.id,u.name,u.key,u.department,u.brand,u.location,u.role,u.is_active,
            u.device_id,u.device_seen_at,u.key_month,u.emp_code,
            u.default_start,u.default_end,u.shift_hours,
            CASE WHEN u.key_hash IS NULL THEN 0 ELSE 1 END has_key,
            (SELECT COUNT(*) FROM shift_days s WHERE s.user_id=u.id AND s.day LIKE ?) work_days
     FROM users u WHERE (? IS NULL OR u.brand=? OR u.role='super')
     ORDER BY u.role DESC, u.location, u.department, u.name`
  ).all(new Date().toISOString().slice(0, 7) + '%', scope, scope)
    .map((u) => ({ ...u, bound: !!u.device_id, has_key: !!u.has_key, timezone: tzOf(u.location) }));

function audit(actor, action, detail, ip) {
  db.prepare('INSERT INTO audit_log (actor_id,actor_name,action,detail,ip,at) VALUES (?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.name : null, action, detail, ip, now());
}

module.exports = {
  db, DEPTS, BRANDS, AUTO_CLOSE_GRACE_MIN, newKey,
  types, typeByCode, sweepStale, openFor, holderOf, lanes, present,
  startActivity, stopActivity, stateFor, history, allUsers, audit, lockKey,
  PUNCH_KINDS, PUNCH_ACTIVE, LATE_LEVELS, MAX_OFF_PER_MONTH,
  SHIFT_EARLY_MIN, LATE_IN_1, LATE_IN_2, LATE_OUT_1,
  punch, shiftToday, punchHistory, lateByUser, scheduledFor,
  myOffs, toggleOff, offSummary, setLock, isLocked, whoOff, MAX_OFF_PER_DAY_DEPT,
  LOCATIONS, LOCATION_TZ, tzOf, zonedToUtc, dayInTz, shiftWindow,
  scopeOf, isSuper, inScope,
  setPersonalKey, hasPersonalKey, checkPersonalKey, KEY_RE,
  ensureEmpCode, setEmpCode, backfillEmpCodes,
  isExempt, setExempt, clearExempt, pastShiftDays, todayOf, shiftEndedToday,
  hasCheckedOut, cancelPendingRollCalls, hasShiftOn,
  setShiftHours, setShiftHoursBulk, setOT, clearOT, otToday, otOf,
  monthHasSchedule, isOffDay,
  REPORT_DEPTS, REPORT_GRACE_MIN, REPORT_BLOCK_AFTER, REPORT_ALERT_AFTER,
  sweepRollCalls, releaseMakeups, activeRollCall, answerRollCall, rollCallReport, upcomingRollCalls, fireRollCall, deferRollCall,
  rollCallByDay, activityByDay, shiftLog,
  RC_PER_SHIFT, RC_WINDOW_MIN, RC_MAKEUP_MIN,
  applySchedule, scheduleOf, scheduleSummary,
};
