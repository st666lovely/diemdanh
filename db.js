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
  role           TEXT    NOT NULL DEFAULT 'staff',   -- staff | admin
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
`);

// Cột giờ ca — thêm sau nên dùng ALTER có kiểm tra, tránh lỗi khi chạy lại
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('shift_start')) db.exec("ALTER TABLE users ADD COLUMN shift_start TEXT NOT NULL DEFAULT '09:00'");
  if (!cols.includes('shift_end'))   db.exec("ALTER TABLE users ADD COLUMN shift_end   TEXT NOT NULL DEFAULT '18:00'");

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
     VALUES (?,?,?,?,'admin','RISK',?)`
  ).run('Quản trị', newKey(), u, bcrypt.hashSync(p, 10), Date.now());
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

function lanes() {
  return db.prepare(
    `SELECT brand, department, COUNT(*) headcount FROM users
     WHERE is_active=1 AND role='staff' AND department IS NOT NULL
     GROUP BY brand, department ORDER BY department, brand`
  ).all().map((p) => {
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
function history(f = {}) {
  const w = [], p = [];
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
const PUNCH_KINDS = { in: 'Lên ca', out: 'Xuống ca', log: 'Chấm công' };

const LATE_LEVELS = {
  in5:   { label: 'Trễ lên ca ~5p',    kind: 'in',  min: 5 },
  in30:  { label: 'Trễ lên ca ~30p',   kind: 'in',  min: 30 },
  out60: { label: 'Trễ xuống ca ~60p', kind: 'out', min: 60 },
};
const MAX_OFF_PER_MONTH = Math.max(1, Number(process.env.MAX_OFF_PER_MONTH) || 15);
// Cùng một ngày, mỗi bộ phận (theo cặp brand + bộ phận) cho tối đa bấy nhiêu người nghỉ.
const MAX_OFF_PER_DAY_DEPT = Math.max(1, Number(process.env.MAX_OFF_PER_DAY_DEPT) || 1);

/* Mốc giờ theo lịch của một lần chấm, tính từ giờ ca của nhân viên.
   Ca qua đêm (vd 22:00–06:00) thì giờ xuống ca rơi sang ngày hôm sau. */
function scheduledFor(user, kind, at = now()) {
  if (kind === 'log') return null;

  const [sh, sm] = String(user.shift_start || '09:00').split(':').map(Number);
  const [eh, em] = String(user.shift_end || '18:00').split(':').map(Number);

  const base = new Date(at); base.setHours(0, 0, 0, 0);
  const start = new Date(base); start.setHours(sh, sm, 0, 0);
  const end = new Date(base);   end.setHours(eh, em, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);   // ca qua đêm

  if (kind === 'in') {
    // Bấm lúc rạng sáng thì thuộc ca bắt đầu từ hôm trước
    if (at < start.getTime() - 12 * 3600000) start.setDate(start.getDate() - 1);
    return start.getTime();
  }
  if (at < start.getTime()) end.setDate(end.getDate() - 1);
  return end.getTime();
}

function lateOf(kind, diffMin) {
  if (diffMin <= 0) return null;
  if (kind === 'in')  return diffMin >= 30 ? 'in30' : (diffMin >= 5 ? 'in5' : null);
  if (kind === 'out') return diffMin >= 60 ? 'out60' : null;
  return null;
}

function punch(user, kind, ip, ua) {
  if (!PUNCH_KINDS[kind]) return { ok: false, message: 'Loại chấm công không hợp lệ.' };

  const at = now();
  const sched = scheduledFor(user, kind, at);
  const diff = sched ? Math.round((at - sched) / 60000) : 0;
  const level = lateOf(kind, diff);
  const hhmm = new Date(at).toLocaleTimeString('vi-VN', { hour12: false });

  db.prepare(`INSERT INTO punches
    (user_id,kind,brand,department,scheduled_at,actual_at,late_minutes,late_level,ip,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, kind, user.brand, user.department, sched, at,
    Math.max(0, diff), level, ip, (ua || '').slice(0, 400));

  return {
    ok: true, late_level: level,
    message: level
      ? `${PUNCH_KINDS[kind]} lúc ${hhmm} — ${LATE_LEVELS[level].label} (${diff} phút).`
      : `${PUNCH_KINDS[kind]} lúc ${hhmm}.`,
  };
}

/* Trạng thái ca hôm nay */
function shiftToday(user) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const rows = db.prepare('SELECT * FROM punches WHERE user_id=? AND actual_at>=? ORDER BY actual_at')
    .all(user.id, from.getTime() - 12 * 3600000);   // lùi 12h để bắt ca đêm

  const lastIn = [...rows].reverse().find((r) => r.kind === 'in');
  const lastOut = [...rows].reverse().find((r) => r.kind === 'out');

  return {
    on_shift: !!(lastIn && (!lastOut || lastOut.actual_at < lastIn.actual_at)),
    checked_in_at: lastIn ? lastIn.actual_at : null,
    checked_out_at: lastOut ? lastOut.actual_at : null,
    shift_start: user.shift_start, shift_end: user.shift_end,
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
  if (viewer && viewer.role !== 'admin') { w.push('p.user_id=?'); p.push(viewer.id); }
  else if (f.user_id) { w.push('p.user_id=?'); p.push(f.user_id); }
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
            SUM(CASE WHEN p.late_level='out60' THEN 1 ELSE 0 END) c
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
    },
  };
}

/* ============================================================
   LỊCH OFF
   ============================================================ */
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

  return {
    ym, days, used: days.length, max: MAX_OFF_PER_MONTH,
    locked: isLocked(ym), taken, per_day: MAX_OFF_PER_DAY_DEPT,
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
function offSummary(ym, filter = '') {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.department, u.brand,
            (SELECT COUNT(*) FROM day_offs d WHERE d.user_id=u.id AND d.day LIKE ?) n,
            (SELECT GROUP_CONCAT(d.day) FROM day_offs d WHERE d.user_id=u.id AND d.day LIKE ?) days
     FROM users u WHERE u.role='staff' AND u.is_active=1
     ORDER BY u.department, u.name`).all(ym + '%', ym + '%');

  const shaped = rows.map((r) => ({ ...r, days: r.days ? r.days.split(',').sort() : [] }));

  return {
    ym, locked: isLocked(ym), max: MAX_OFF_PER_MONTH,
    rows: shaped.filter((r) => {
      if (filter === 'none')    return r.n === 0;
      if (filter === 'partial') return r.n > 0 && r.n < MAX_OFF_PER_MONTH;
      if (filter === 'full')    return r.n >= MAX_OFF_PER_MONTH;
      if (/^\d{1,2}$/.test(filter)) return r.n === +filter;
      return true;
    }),
    counts: {
      all: rows.length,
      none: rows.filter((r) => r.n === 0).length,
      partial: rows.filter((r) => r.n > 0 && r.n < MAX_OFF_PER_MONTH).length,
      full: rows.filter((r) => r.n >= MAX_OFF_PER_MONTH).length,
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

const allUsers = () =>
  db.prepare(
    `SELECT id,name,key,department,brand,role,is_active,device_id,device_seen_at,shift_start,shift_end
     FROM users ORDER BY role DESC, department, name`
  ).all().map((u) => ({ ...u, bound: !!u.device_id }));

function audit(actor, action, detail, ip) {
  db.prepare('INSERT INTO audit_log (actor_id,actor_name,action,detail,ip,at) VALUES (?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.name : null, action, detail, ip, now());
}

module.exports = {
  db, DEPTS, BRANDS, AUTO_CLOSE_GRACE_MIN, newKey,
  types, typeByCode, sweepStale, openFor, holderOf, lanes, present,
  startActivity, stopActivity, stateFor, history, allUsers, audit, lockKey,
  PUNCH_KINDS, LATE_LEVELS, MAX_OFF_PER_MONTH,
  punch, shiftToday, punchHistory, scheduledFor,
  myOffs, toggleOff, offSummary, setLock, isLocked, whoOff, MAX_OFF_PER_DAY_DEPT,
};
