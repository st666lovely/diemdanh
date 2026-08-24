'use strict';

// PHẢI đặt trước mọi require khác. Máy chủ Render chạy theo UTC, nên nếu không ép
// múi giờ thì giờ ca "09:00" bị hiểu là 09:00 UTC = 16:00 giờ Việt Nam, và mọi
// phép tính trễ đều lệch 7 tiếng. Đặt sớm để Node chưa kịp ghi nhớ múi giờ cũ.
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const D = require('./db');
const { parseScheduleFile } = require('./schedule');
const Sheets = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

// Render đứng sau proxy — thiếu dòng này thì req.ip luôn là IP nội bộ.
// Đây đúng là lỗi khiến hệ thống chấm công cũ ghi 127.0.0.1 vào bản ghi.
app.set('trust proxy', true);

app.use(express.json());
// Cờ "secure" phải bám theo giao thức THẬT của từng request.
// Render kết thúc TLS ở proxy rồi chuyển tiếp bằng HTTP, nên nếu đặt cứng
// secure=true theo NODE_ENV thì cookie bị bỏ im lặng: đăng nhập trả về ok
// nhưng không có cookie, request sau bị 401, trang đứng yên ở màn đăng nhập.
// Nhờ 'trust proxy' bật ở trên, req.secure đọc được X-Forwarded-Proto.
const sessionOpts = {
  name: 'tt',
  keys: [process.env.SESSION_SECRET || 'doi-chuoi-nay-trong-bien-moi-truong'],
  maxAge: 365 * 24 * 3600 * 1000,   // nhân viên không phải mở lại link mỗi ngày
  httpOnly: true,
  sameSite: 'lax',
};
const sessionSecure = cookieSession({ ...sessionOpts, secure: true });
const sessionPlain  = cookieSession({ ...sessionOpts, secure: false });
app.use((req, res, next) =>
  (req.secure ? sessionSecure : sessionPlain)(req, res, next));

/* ============================================================
   PHIÊN
   Nhân viên: không mật khẩu. Mở /k/<key> một lần, key gắn với thiết bị đó.
   Quản trị: đăng nhập bằng tài khoản + mật khẩu.
   ============================================================ */
const findUser = (id) =>
  D.db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(id) || null;

function currentUser(req) {
  return req.session && req.session.uid ? findUser(req.session.uid) : null;
}

function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, message: 'Chưa có phiên. Mở lại link được cấp.' });
  req.user = u;
  next();
}

/* Bắt nhập mã cá nhân ở MỌI thao tác: lên ca, xuống ca, chấm công,
   bắt đầu và dừng rời vị trí. Mã lấy từ lương tháng trước nên không ai
   đưa cho đồng nghiệp, đó là lý do chọn nó. */
function requireKey(req, res, next) {
  if (req.user.role !== 'staff') return next();
  const r = D.checkPersonalKey(req.user, (req.body || {}).key);
  if (!r.ok) {
    D.audit(req.user, 'key_wrong', null, req.ip);
    return res.status(403).json({ ok: false, key_required: true, message: r.message });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'super') {
    return res.status(403).json({ ok: false, message: 'Chỉ quản trị xem được mục này.' });
  }
  if (req.user.role === 'admin' && !req.user.brand) {
    return res.status(403).json({ ok: false, message: 'Tài khoản quản trị chưa được gán brand. Liên hệ quản trị tổng.' });
  }
  req.scope = D.scopeOf(req.user);   // null = thấy tất cả
  next();
}

function requireSuper(req, res, next) {
  if (req.user.role !== 'super') {
    return res.status(403).json({ ok: false, message: 'Chỉ quản trị tổng làm được việc này.' });
  }
  next();
}

/* Lấy nhân viên theo id NHƯNG chặn nếu khác brand với quản trị đang thao tác.
   Trả về null và tự gửi 404 để không lộ việc người đó có tồn tại hay không. */
function targetUser(req, res) {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên trong phạm vi quản lý của bạn.' });
    return null;
  }
  return u;
}

/* --- Vào ca bằng link ---
   Phục vụ thẳng trang thay vì chuyển hướng về "/", để URL trên thanh địa chỉ giữ nguyên
   /k/<key>. Nhờ vậy nhân viên "Thêm vào màn hình chính" thì icon trỏ đúng link của họ.
   Quan trọng với iPhone: app cài ra màn hình chính dùng kho cookie RIÊNG với Safari,
   nếu icon chỉ trỏ về "/" thì mở lên sẽ không có phiên và bị chặn. */
app.get('/k/:key', (req, res) => {
  const key = String(req.params.key || '').toUpperCase();
  const u = D.db.prepare('SELECT * FROM users WHERE key=? AND is_active=1').get(key);

  if (!u) {
    D.audit(null, 'key_invalid', key, req.ip);
    return res.redirect('/?e=nokey');
  }

  req.session.uid = u.id;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* Manifest động: khi mở qua /k/<key>, start_url trỏ về đúng link đó.
   Nếu để start_url = "/" thì icon trên màn hình chính mở ra là mất phiên. */
app.get('/manifest.webmanifest', (req, res) => {
  const k = String(req.query.k || '').toUpperCase();
  const valid = k && D.db.prepare('SELECT 1 FROM users WHERE key=? AND is_active=1').get(k);
  res.type('application/manifest+json').json({
    name: 'Trạm trực', short_name: 'Trạm trực',
    description: 'Chấm công ca và quản lý rời vị trí',
    start_url: valid ? `/k/${k}` : '/',
    scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#F1F3F2', theme_color: '#0F6E52', lang: 'vi',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

/* --- Đăng nhập quản trị --- */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = D.db.prepare("SELECT * FROM users WHERE username=? AND role IN ('admin','super') AND is_active=1")
    .get(String(username || '').trim());
  if (!u || !u.password_hash || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Sai tài khoản hoặc mật khẩu.' });
  }
  req.session.uid = u.id;
  D.audit(u, 'admin_login', null, req.ip);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.post('/api/admin/password', requireUser, requireAdmin, (req, res) => {
  const { current, next: nx } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash || '')) {
    return res.status(400).json({ ok: false, message: 'Mật khẩu hiện tại không đúng.' });
  }
  if (String(nx || '').length < 8) {
    return res.status(400).json({ ok: false, message: 'Mật khẩu mới cần ít nhất 8 ký tự.' });
  }
  D.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(nx, 10), req.user.id);
  D.audit(req.user, 'password_change', null, req.ip);
  res.json({ ok: true, message: 'Đã đổi mật khẩu.' });
});

/* ============================================================
   NHÂN VIÊN
   ============================================================ */
app.get('/api/state', requireUser, (req, res) => {
  const ym = new Date().toISOString().slice(0, 7);
  res.json({
    ...D.stateFor(req.user),
    shift: D.shiftToday(req.user),
    offs: D.myOffs(req.user, ym),
    schedule: D.scheduleOf(req.user.id, ym),
    key: { required: D.hasPersonalKey(req.user), month: req.user.key_month || null },
    rollcall: (() => {
      const rc = D.activeRollCall(req.user.id);
      if (!rc) return null;
      return { id: rc.id, due_at: rc.due_at, deadline_at: rc.deadline_at,
               is_makeup: !!rc.is_makeup };
    })(),
  });
});

app.post('/api/start', requireUser, requireKey, (req, res) => {
  const r = D.startActivity(req.user, String((req.body || {}).code || ''), req.ip, req.get('user-agent'));

  // Vừa rời vị trí mà đang có lượt điểm danh chờ -> hoãn ngay, không để họ bị tính vắng
  if (r.ok) {
    const rc = D.db.prepare(
      "SELECT * FROM roll_calls WHERE user_id=? AND status='pending' AND due_at<=? AND deadline_at>=?"
    ).get(req.user.id, Date.now(), Date.now());
    const open = D.openFor(req.user.id);
    if (rc && open) {
      D.deferRollCall(rc, open);
      r.message += ' Lượt điểm danh đang chờ đã được hoãn, sẽ bù sau khi bạn bấm Dừng lại.';
    }
  }
  res.status(r.ok ? 200 : 409).json({ ...r, state: D.stateFor(req.user) });
});

app.post('/api/stop', requireUser, requireKey, (req, res) => {
  const r = D.stopActivity(req.user, 'staff');
  // Trong lúc rời vị trí có lượt điểm danh nào bị hoãn thì giờ bắn bù
  if (r.ok) {
    const n = D.releaseMakeups(req.user.id);
    if (n) {
      r.message += ` Có ${n} lượt điểm danh bù sẽ hiện trong ${D.RC_MAKEUP_MIN} phút nữa.`;
      D.audit(req.user, 'rollcall_makeup_released', String(n), req.ip);
    }
  }
  res.status(r.ok ? 200 : 409).json({ ...r, state: D.stateFor(req.user) });
});

/* ============================================================
   QUẢN TRỊ
   ============================================================ */
app.get('/api/admin/board', requireUser, requireAdmin, (req, res) => {
  D.sweepStale();
  res.json({
    server_time: Date.now(),
    me: { name: req.user.name, role: req.user.role, brand: req.user.brand },
    scope: req.scope,
    lanes: D.lanes(req.scope), users: D.allUsers(req.scope), types: D.types(),
    departments: D.DEPTS, brands: req.scope ? [req.scope] : D.BRANDS,
    ...D.history(req.query, req.scope),
  });
});

app.post('/api/admin/close/:id', requireUser, requireAdmin, (req, res) => {
  const a = D.db.prepare('SELECT * FROM activities WHERE id=?').get(+req.params.id);
  if (!a || !D.inScope(req.scope, a.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy hoạt động trong phạm vi của bạn.' });
  }
  const r = D.stopActivity(req.user, 'admin', +req.params.id);
  if (r.ok) D.audit(req.user, 'force_close', `activity #${req.params.id}`, req.ip);
  res.status(r.ok ? 200 : 409).json(r);
});

app.get('/api/admin/export.csv', requireUser, requireAdmin, (req, res) => {
  const { rows } = D.history({ ...req.query, limit: 100000 });
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dmy = (t) => new Date(t).toLocaleDateString('vi-VN');
  const hms = (t) => (t ? new Date(t).toLocaleTimeString('vi-VN', { hour12: false }) : '');
  const cb = { staff: 'Nhân viên', auto: 'Tự đóng (quên bấm)', admin: 'Quản trị' };

  const lines = [
    ['Ngày', 'Bắt đầu', 'Kết thúc', 'Tên hiển thị', 'Bộ phận', 'Brand', 'Hoạt động',
     'Cho phép (phút)', 'Thực tế (phút)', 'Quá giờ', 'Kết thúc bởi', 'IP'],
    ...rows.map((r) => [
      dmy(r.started_at), hms(r.started_at), hms(r.ended_at), r.user_name,
      r.department || '', r.brand || '', r.type_name, r.limit_minutes,
      r.duration_sec != null ? (r.duration_sec / 60).toFixed(1) : '',
      r.is_over_limit ? 'Có' : 'Không', cb[r.closed_by] || 'Đang chạy', r.ip || '',
    ]),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="hoat-dong-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.map((l) => l.map(esc).join(',')).join('\n'));
});

/* --- Tài khoản --- */
app.post('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên nhân viên.' });
  if (!D.DEPTS.includes(b.department)) {
    return res.status(400).json({ ok: false, message: 'Bộ phận không hợp lệ.' });
  }
  const brand = req.scope !== null ? req.scope
    : (D.BRANDS.includes(b.brand) ? b.brand : null);
  if (req.scope === null && !brand) {
    return res.status(400).json({ ok: false, message: 'Chọn brand cho nhân viên này.' });
  }

  const key = D.newKey();
  D.db.prepare(`INSERT INTO users (name,key,department,brand,role,created_at)
                VALUES (?,?,?,?,'staff',?)`).run(name, key, b.department, brand, Date.now());
  D.audit(req.user, 'user_create', `${name} (${brand})`, req.ip);
  res.json({ ok: true, message: `Đã thêm ${name} vào ${brand}.`, users: D.allUsers(req.scope) });
});

app.post('/api/admin/users/bulk', requireUser, requireAdmin, (req, res) => {
  const text = String((req.body || {}).text || '');
  const ins = D.db.prepare(`INSERT INTO users (name,key,department,brand,role,created_at)
                            VALUES (?,?,?,?,'staff',?)`);
  const created = [], skipped = [];

  D.db.transaction(() => {
    for (const line of text.split('\n')) {
      const p = line.split('|').map((s) => s.trim());
      if (!p[0]) continue;
      const dept = D.DEPTS.includes((p[1] || '').toUpperCase()) ? p[1].toUpperCase() : null;
      let brand = D.BRANDS.includes((p[2] || '').toUpperCase()) ? p[2].toUpperCase() : null;
      if (req.scope !== null) brand = req.scope;   // admin theo brand chỉ thêm được người của brand mình
      if (!dept) { skipped.push(`${p[0]} — bộ phận không hợp lệ`); continue; }
      if (!brand) { skipped.push(`${p[0]} — thiếu brand`); continue; }
      ins.run(p[0], D.newKey(), dept, brand, Date.now());
      created.push(p[0]);
    }
  })();

  D.audit(req.user, 'user_bulk', `${created.length} người`, req.ip);
  res.json({ ok: true, created, skipped, users: D.allUsers(req.scope) });
});

app.put('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = targetUser(req, res); if (!u) return;

  const name = String(b.name || u.name).trim();
  const dept = D.DEPTS.includes(b.department) ? b.department : u.department;
  // Admin theo brand không được chuyển người sang brand khác
  const brand = req.scope !== null ? u.brand
    : (b.brand === '' ? null : (D.BRANDS.includes(b.brand) ? b.brand : u.brand));
  const active = b.is_active === undefined ? u.is_active : (b.is_active ? 1 : 0);

  if (u.id === req.user.id && !active) {
    return res.status(400).json({ ok: false, message: 'Không thể tự khóa tài khoản của mình.' });
  }

  D.db.prepare('UPDATE users SET name=?,department=?,brand=?,is_active=? WHERE id=?')
    .run(name, dept, brand, active, u.id);
  D.audit(req.user, 'user_update', u.name, req.ip);
  res.json({ ok: true, message: 'Đã cập nhật.', users: D.allUsers(req.scope) });
});

/* Đặt mã cá nhân (lấy từ lương tháng trước). Chỉ nhận, băm rồi quên số gốc. */
app.post('/api/admin/users/:id/personal-key', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const b = req.body || {};
  const r = D.setPersonalKey(u.id, b.key, b.month);
  if (r.ok) D.audit(req.user, 'personal_key_set', `${u.name} (${b.month || '-'})`, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, users: D.allUsers(req.scope) });
});

/* --- Giờ ca mặc định --- */
app.put('/api/admin/users/:id/default-shift', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const b = req.body || {};
  const r = D.setDefaultShift(u.id, b.start, b.end);
  if (r.ok) D.audit(req.user, 'default_shift', `${u.name} ${b.start}-${b.end}`, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, users: D.allUsers(req.scope) });
});

app.post('/api/admin/default-shift/bulk', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = D.setDefaultShiftBulk(b.department || null, b.brand || null, b.start, b.end, req.scope);
  if (r.ok) D.audit(req.user, 'default_shift_bulk', `${b.department || 'tất cả'} ${b.start}-${b.end}`, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, users: D.allUsers(req.scope) });
});

/* --- Làm thêm giờ --- */
app.post('/api/ot', requireUser, requireKey, (req, res) => {
  const b = req.body || {};
  const r = D.setOT(req.user, b.hours, b.reason, false);
  if (r.ok) D.audit(req.user, 'ot_set', `${b.hours}h · ${b.reason || ''}`, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, shift: D.shiftToday(req.user) });
});

app.delete('/api/ot', requireUser, requireKey, (req, res) => {
  const day = D.todayOf(req.user);
  const r = D.clearOT(req.user.id, day);
  D.audit(req.user, 'ot_clear', day, req.ip);
  res.json({ ...r, shift: D.shiftToday(req.user) });
});

app.post('/api/admin/ot', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+b.user_id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên.' });
  }
  const r = b.clear
    ? D.clearOT(u.id, String(b.day))
    : D.setOT(u, b.hours, b.reason || 'Quản trị ghi nhận', true, b.day || null);
  D.audit(req.user, b.clear ? 'ot_clear' : 'ot_set_admin', `${u.name} ${b.day || ''}`, req.ip);
  res.status(r.ok ? 200 : 400).json(r);
});

/* --- Nhật ký vào/ra ca --- */
app.get('/api/admin/shift-log', requireUser, requireAdmin, (req, res) => {
  res.json({
    ...D.shiftLog(req.query, req.scope),
    users: D.allUsers(req.scope).filter((u) => u.role === 'staff'),
    departments: D.DEPTS,
    brands: req.scope ? [req.scope] : D.BRANDS,
    early_min: D.SHIFT_EARLY_MIN,
  });
});

/* --- Xem lượt chi tiết theo ngày --- */
app.get('/api/admin/rollcalls/detail', requireUser, requireAdmin, (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.query.user_id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên.' });
  }
  res.json({ user: { id: u.id, name: u.name, emp_code: u.emp_code }, ...D.rollCallByDay(u.id, req.query) });
});

app.get('/api/admin/activities/detail', requireUser, requireAdmin, (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.query.user_id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên.' });
  }
  res.json({ user: { id: u.id, name: u.name, emp_code: u.emp_code }, ...D.activityByDay(u.id, req.query) });
});

/* Bắn điểm danh thủ công */
app.post('/api/admin/rollcalls/fire', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = D.fireRollCall({
    who: String(b.who || 'all'),
    windowMin: Math.min(30, Math.max(1, Number(b.window_min) || D.RC_WINDOW_MIN)),
    scope: req.scope,
  });
  D.audit(req.user, 'rollcall_fire', `${b.who} -> ${r.fired.length} người`, req.ip);
  res.json(r);
});

/* Bảng theo dõi nợ báo cáo */
app.get('/api/admin/reports', requireUser, requireAdmin, async (req, res) => {
  D.backfillEmpCodes();
  const back = Math.min(31, Math.max(3, Number(req.query.days) || 14));
  const staff = D.allUsers(req.scope).filter((u) => u.role === 'staff' && u.is_active);

  const dayset = new Set();
  const perUser = [];
  for (const u of staff) {
    const full = D.db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    const days = D.pastShiftDays(full, back);
    days.forEach((d) => dayset.add(d));
    const today = D.todayOf(full);
    dayset.add(today);
    perUser.push({ u, full, days, today });
  }

  const sum = await Sheets.summarize([...dayset], req.query.refresh === '1');

  const rows = perUser.map(({ u, full, days, today }) => {
    const code = D.ensureEmpCode(full);

    // Ngày cũ + HÔM NAY (nếu hôm nay có ca). Trước đây thiếu hôm nay nên
    // điền xong vẫn không thấy ô nào sáng lên.
    const allDays = [...days].reverse();
    if (D.hasShiftOn(full.id, today)) allDays.push(today);

    const cells = allDays.map((d) => {
      const hit = sum.byKey[`${code}|${d}`];
      return {
        day: d,
        is_today: d === today,
        rows: hit ? hit.count : 0,
        amount: hit ? hit.amount : 0,
        exempt: D.isExempt(full.id, d),
        state: hit ? 'done' : (D.isExempt(full.id, d) ? 'exempt' : 'missing'),
      };
    });
    // Hôm nay chưa hết ca thì chưa tính là nợ
    const owing = cells.filter((c) => c.state === 'missing' && !c.is_today);
    const t = sum.byKey[`${code}|${today}`];
    return {
      id: u.id, name: u.name, emp_code: code,
      department: u.department, brand: u.brand,
      cells, owing: owing.length,
      owing_days: owing.map((c) => c.day),
      today_rows: t ? t.count : 0,
      today_exempt: D.isExempt(full.id, today),
      blocked: owing.length >= D.REPORT_BLOCK_AFTER,
      alert: owing.length >= D.REPORT_ALERT_AFTER,
    };
  }).sort((a, b) => b.owing - a.owing);

  res.json({
    rows,
    days: [...dayset].sort().reverse().slice(0, back),
    sheet: Sheets.status(),
    config: {
      grace_min: D.REPORT_GRACE_MIN,
      block_after: D.REPORT_BLOCK_AFTER,
      alert_after: D.REPORT_ALERT_AFTER,
      depts: D.REPORT_DEPTS,
    },
    stats: {
      total: rows.length,
      owing: rows.filter((r) => r.owing > 0).length,
      blocked: rows.filter((r) => r.blocked).length,
      alert: rows.filter((r) => r.alert).length,
    },
    departments: D.DEPTS,
    brands: req.scope ? [req.scope] : D.BRANDS,
    users: D.allUsers(req.scope).filter((u) => u.role === 'staff'),
  });
});

app.put('/api/admin/users/:id/emp-code', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const r = D.setEmpCode(u.id, (req.body || {}).emp_code);
  if (r.ok) D.audit(req.user, 'emp_code_set', `${u.name} -> ${(req.body || {}).emp_code}`, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, users: D.allUsers(req.scope) });
});

/* Quản trị miễn báo cáo cho một ca */
app.post('/api/admin/reports/exempt', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+b.user_id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên trong phạm vi của bạn.' });
  }
  const r = b.clear
    ? D.clearExempt(u.id, String(b.day))
    : D.setExempt(u.id, String(b.day), String(b.reason || 'Quản trị miễn'), true);
  D.audit(req.user, b.clear ? 'report_exempt_clear' : 'report_exempt_set', `${u.name} ${b.day}`, req.ip);
  res.json(r);
});

/* Báo cáo điểm danh */
app.get('/api/admin/rollcalls', requireUser, requireAdmin, (req, res) => {
  D.sweepRollCalls();
  res.json({
    ...D.rollCallReport(req.query, req.scope),
    upcoming: D.upcomingRollCalls(req.scope),
    server_time: Date.now(),
    users: D.allUsers(req.scope).filter((u) => u.role === 'staff'),
    departments: D.DEPTS,
    brands: req.scope ? [req.scope] : D.BRANDS,
    config: { per_shift: D.RC_PER_SHIFT, window_min: D.RC_WINDOW_MIN, makeup_min: D.RC_MAKEUP_MIN },
  });
});

/* Cấp lại key: link cũ chết ngay, thiết bị cũ bị gỡ. Dùng khi nhân viên đổi máy
   hoặc nghi có người dùng chung link. */
app.post('/api/admin/users/:id/rekey', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const key = D.newKey();
  D.db.prepare('UPDATE users SET key=? WHERE id=?').run(key, u.id);
  D.audit(req.user, 'rekey', u.name, req.ip);
  res.json({ ok: true, message: `Đã cấp key mới cho ${u.name}. Link cũ không dùng được nữa.`, users: D.allUsers(req.scope) });
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  if (u.id === req.user.id) {
    return res.status(400).json({ ok: false, message: 'Không thể xóa tài khoản của chính mình.' });
  }
  // Khóa thay vì xóa — xóa là mất luôn lịch sử hoạt động của người đó.
  D.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(u.id);
  D.audit(req.user, 'user_deactivate', u.name, req.ip);
  res.json({ ok: true, message: `Đã khóa ${u.name}. Lịch sử vẫn giữ.`, users: D.allUsers(req.scope) });
});

/* ============================================================
   TUÂN THỦ BÁO CÁO
   Có ca trong lịch mà không có dòng nào của mình trong sheet = nợ.
   Điền vào sheet là tự mở khóa, không cần ai duyệt.
   ============================================================ */

/* Tình trạng nợ của một nhân viên. force=true thì đọc lại sheet ngay. */
async function reportStatus(user, force = false) {
  if (user.role !== 'staff') return { owing: [], today: null, blocked: false, off: true };
  if (!D.REPORT_DEPTS.includes(String(user.department || '').toUpperCase())) {
    return { owing: [], today: null, blocked: false, off: true, reason: 'Bộ phận này không phải nộp' };
  }

  const code = D.ensureEmpCode(user);
  const today = D.todayOf(user);
  const days = D.pastShiftDays(user, 14);

  const sum = await Sheets.summarize([...days, today], force);

  // Sheet hỏng thì KHÔNG chặn ai — thà bỏ sót còn hơn khóa nhầm cả team
  if (sum.error && !sum.total) {
    return { owing: [], today: null, blocked: false, sheet_error: sum.error, emp_code: code };
  }

  const owing = days.filter((d) => !sum.byKey[`${code}|${d}`] && !D.isExempt(user.id, d));
  const t = sum.byKey[`${code}|${today}`] || null;

  return {
    emp_code: code,
    owing,
    blocked: owing.length >= D.REPORT_BLOCK_AFTER,
    alert: owing.length >= D.REPORT_ALERT_AFTER,
    today: {
      day: today,
      rows: t ? t.count : 0,
      amount: t ? t.amount : 0,
      approved: t ? t.approved : 0,
      rejected: t ? t.rejected : 0,
      sources: t ? t.sources : {},        // dòng đến từ file nào
      exempt: D.isExempt(user.id, today),
      shift_ended: D.shiftEndedToday(user),
    },
    sheets: sum.sources || [],
    fetched_at: sum.fetched_at,
    sheet_error: sum.error || null,
  };
}

/* Chốt chặn:
   - Xuống ca: hôm nay chưa có dòng nào thì không cho bấm
   - Lên ca:   còn nợ ca cũ thì không cho vào ca mới */
async function reportGate(req, res, kind) {
  const st = await reportStatus(req.user);
  if (st.off || st.sheet_error) return null;

  if (kind === 'out' && st.today && st.today.rows === 0 && !st.today.exempt) {
    const ten = (st.sheets || []).map((x) => x.name).join(', ');
    return {
      ok: false, report_required: true, report: st,
      message: `Chưa có dòng nào của ${st.emp_code} hôm nay ở bất kỳ file nào`
             + (ten ? ` (${ten})` : '') + '. '
             + 'Điền một trong các file rồi bấm "Tôi đã điền rồi". '
             + 'Ca không phát sinh việc gì thì bấm "Ca không phát sinh".',
    };
  }

  if (kind === 'in' && st.blocked) {
    const ds = st.owing.map((d) => d.split('-').reverse().join('/'));
    return {
      ok: false, report_required: true, report: st,
      message: `Còn nợ báo cáo ${st.owing.length} ca: ${ds.slice(0, 5).join(', ')}`
             + (ds.length > 5 ? '…' : '') + '. Điền bù xong mới vào ca mới được.',
    };
  }
  return null;
}

app.get('/api/report/status', requireUser, async (req, res) => {
  res.json(await reportStatus(req.user, req.query.refresh === '1'));
});

/* Nút "Tôi đã điền rồi" — đọc lại sheet ngay, không chờ tới lượt quét */
app.post('/api/report/recheck', requireUser, async (req, res) => {
  const st = await reportStatus(req.user, true);
  res.json({
    ok: true, report: st,
    message: st.sheet_error ? 'Không đọc được sheet: ' + st.sheet_error
      : st.today && st.today.rows > 0
        ? `Đã thấy ${st.today.rows} dòng của bạn hôm nay`
          + (Object.keys(st.today.sources || {}).length
              ? ` (${Object.entries(st.today.sources).map(([k, v]) => `${k}: ${v}`).join(' · ')})` : '') + '.'
        : 'Vẫn chưa thấy dòng nào của bạn ở file nào. Kiểm tra cột Ngày và cột MaNV đã điền đúng chưa.',
  });
});

/* Ca không phát sinh việc — vẫn phải khai, để phân biệt với quên điền */
app.post('/api/report/no-activity', requireUser, (req, res) => {
  const day = D.todayOf(req.user);
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 10) {
    return res.status(400).json({ ok: false, message: 'Ghi rõ lý do ít nhất 10 ký tự.' });
  }
  const r = D.setExempt(req.user.id, day, reason, false);
  D.audit(req.user, 'report_no_activity', `${day}: ${reason}`, req.ip);
  res.json(r);
});

/* --- Điểm danh ngẫu nhiên --- */
app.post('/api/rollcall/answer', requireUser, (req, res) => {
  const r = D.answerRollCall(req.user, (req.body || {}).key, req.ip);
  res.status(r.ok ? 200 : 400).json({ ...r, state: D.stateFor(req.user) });
});

/* ============================================================
   CHẤM CÔNG CA / LỊCH SỬ / TRỄ / LỊCH OFF
   ============================================================ */

/* --- Nhân viên bấm Lên ca / Xuống ca / Chấm công --- */
app.post('/api/punch', requireUser, requireKey, async (req, res) => {
  const kind = String((req.body || {}).kind || '');

  // Chốt tuân thủ báo cáo — chỉ áp cho lên ca và xuống ca
  if (kind === 'in' || kind === 'out') {
    try {
      const blocked = await reportGate(req, res, kind);
      if (blocked) return res.status(409).json({ ...blocked, shift: D.shiftToday(req.user) });
    } catch (e) {
      console.error('reportGate lỗi, cho qua:', e.message);   // lỗi sheet không được chặn người làm
    }
  }

  const r = D.punch(req.user, kind, req.ip, req.get('user-agent'));

  if (r.ok && kind === 'out') {
    const n = D.cancelPendingRollCalls(req.user.id);
    if (n) {
      r.message += ` Đã huỷ ${n} lượt điểm danh còn treo.`;
      D.audit(req.user, 'rollcall_cancel_on_out', String(n), req.ip);
    }
  }

  res.status(r.ok ? 200 : 400).json({ ...r, shift: D.shiftToday(req.user) });
});

/* --- Lịch sử chấm công. Nhân viên chỉ thấy của mình, quản trị thấy hết. --- */
/* Danh sách brand cho ô lọc: nhân viên không cần, admin chỉ brand mình, super cả hai */
function brandOptions(user) {
  if (user.role === 'staff') return [];
  const scope = D.scopeOf(user);
  return scope === null ? D.BRANDS : (D.BRANDS.includes(scope) ? [scope] : []);
}

app.get('/api/punches', requireUser, (req, res) => {
  res.json({
    ...D.punchHistory(req.query, req.user),
    kinds: D.PUNCH_KINDS,
    levels: D.LATE_LEVELS,
    departments: D.DEPTS,
    brands: brandOptions(req.user),
    users: req.user.role === 'staff' ? [] : D.allUsers(D.scopeOf(req.user)).filter((u) => u.role === 'staff'),
    is_admin: req.user.role !== 'staff',
  });
});

/* --- Danh sách trễ ---
   Mặc định trả bảng TỔNG HỢP THEO NGƯỜI (ai trễ nhiều), vì đó là thứ quản lý cần.
   Thêm ?detail=1 để xem nhật ký từng lượt của một người. */
app.get('/api/late', requireUser, (req, res) => {
  const scope = D.scopeOf(req.user);
  const detail = req.query.detail === '1' || req.user.role === 'staff';

  res.json({
    detail,
    ...(detail
      ? D.punchHistory({ ...req.query, only_late: 1 }, req.user)
      : D.lateByUser(req.query, scope === null ? null : scope)),
    levels: D.LATE_LEVELS,
    departments: D.DEPTS,
    brands: brandOptions(req.user),
    users: req.user.role === 'staff' ? [] : D.allUsers(D.scopeOf(req.user)).filter((u) => u.role === 'staff'),
    is_admin: req.user.role !== 'staff',
  });
});

app.get('/api/punches/export.csv', requireUser, requireAdmin, (req, res) => {
  const { rows } = D.punchHistory({ ...req.query, limit: 100000 }, req.user);
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dmy = (t) => (t ? new Date(t).toLocaleDateString('vi-VN') : '');
  const hms = (t) => (t ? new Date(t).toLocaleTimeString('vi-VN', { hour12: false }) : '');

  // Cột tên dùng TÊN HIỂN THỊ, không dùng key hay tên đăng nhập.
  const lines = [
    ['Ngày', 'Giờ bấm', 'Tên hiển thị', 'Bộ phận', 'Brand', 'Loại',
     'Giờ theo lịch', 'Trễ (phút)', 'Mức trễ', 'IP'],
    ...rows.map((r) => [
      dmy(r.actual_at), hms(r.actual_at), r.user_name, r.department || '', r.brand || '',
      r.kind_label, hms(r.scheduled_at), r.late_minutes || '', r.late_label || '', r.ip || '',
    ]),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="cham-cong-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.map((l) => l.map(esc).join(',')).join('\n'));
});

/* --- Lịch off của chính nhân viên --- */
const thisYm = () => new Date().toISOString().slice(0, 7);

app.get('/api/offs', requireUser, (req, res) => {
  res.json(D.myOffs(req.user, String(req.query.ym || thisYm())));
});

app.post('/api/offs/toggle', requireUser, (req, res) => {
  const r = D.toggleOff(req.user, String((req.body || {}).day || ''));
  res.status(r.ok ? 200 : 400).json(r);
});

/* --- Lịch off toàn team, chỉ quản trị --- */
app.get('/api/admin/offs', requireUser, requireAdmin, (req, res) => {
  res.json({
    ...D.offSummary(String(req.query.ym || thisYm()), req.query, req.scope),
    departments: D.DEPTS, brands: req.scope ? [req.scope] : D.BRANDS,
    users: D.allUsers(req.scope).filter((u) => u.role === 'staff'),
    scope: req.scope,
  });
});

/* Quản trị chỉnh hộ nhân viên — bỏ qua hạn mức và khóa tháng */
app.post('/api/admin/offs/toggle', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+b.user_id);
  if (!u || !D.inScope(req.scope, u.brand)) {
    return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên trong phạm vi của bạn.' });
  }
  const r = D.toggleOff(u, String(b.day || ''), true);
  if (r.ok) D.audit(req.user, 'off_toggle', `${u.name} ${b.day}`, req.ip);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/admin/offs/lock', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = D.setLock(String(b.ym || thisYm()), !!b.locked);
  D.audit(req.user, b.locked ? 'off_lock' : 'off_unlock', String(b.ym), req.ip);
  res.json(r);
});

/* --- Quản trị tổng: tạo và quản lý tài khoản quản trị từng brand --- */
const RE_USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;

app.get('/api/admin/admins', requireUser, requireAdmin, requireSuper, (req, res) => {
  res.json({
    admins: D.db.prepare(
      `SELECT id,name,username,brand,role,is_active FROM users
       WHERE role IN ('admin','super') ORDER BY role DESC, brand, name`).all(),
    brands: D.BRANDS,
  });
});

app.post('/api/admin/admins', requireUser, requireAdmin, requireSuper, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const username = String(b.username || '').trim();

  if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên hiển thị.' });
  if (!RE_USERNAME.test(username)) {
    return res.status(400).json({ ok: false, message: 'Tên đăng nhập 3–32 ký tự, chỉ chữ, số và . _ -' });
  }
  if (String(b.password || '').length < 8) {
    return res.status(400).json({ ok: false, message: 'Mật khẩu cần ít nhất 8 ký tự.' });
  }
  if (!D.BRANDS.includes(b.brand)) {
    return res.status(400).json({ ok: false, message: 'Chọn brand cho tài khoản quản trị này.' });
  }

  try {
    D.db.prepare(
      `INSERT INTO users (name,key,username,password_hash,brand,role,department,created_at)
       VALUES (?,?,?,?,?,'admin','RISK',?)`
    ).run(name, D.newKey(), username, bcrypt.hashSync(b.password, 10), b.brand, Date.now());
  } catch (e) {
    return res.status(409).json({ ok: false, message: 'Tên đăng nhập đã tồn tại.' });
  }

  D.audit(req.user, 'admin_create', `${username} (${b.brand})`, req.ip);
  res.json({ ok: true, message: `Đã tạo quản trị ${name} cho brand ${b.brand}.` });
});

app.put('/api/admin/admins/:id', requireUser, requireAdmin, requireSuper, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare("SELECT * FROM users WHERE id=? AND role IN ('admin','super')").get(+req.params.id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy tài khoản quản trị.' });
  if (u.id === req.user.id && b.is_active === false) {
    return res.status(400).json({ ok: false, message: 'Không thể tự khóa tài khoản của mình.' });
  }

  if (b.password) {
    if (String(b.password).length < 8) {
      return res.status(400).json({ ok: false, message: 'Mật khẩu cần ít nhất 8 ký tự.' });
    }
    D.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(b.password, 10), u.id);
  }
  if (u.role === 'admin' && D.BRANDS.includes(b.brand)) {
    D.db.prepare('UPDATE users SET brand=? WHERE id=?').run(b.brand, u.id);
  }
  if (b.is_active !== undefined) {
    D.db.prepare('UPDATE users SET is_active=? WHERE id=?').run(b.is_active ? 1 : 0, u.id);
  }

  D.audit(req.user, 'admin_update', u.username, req.ip);
  res.json({ ok: true, message: 'Đã cập nhật tài khoản quản trị.' });
});

/* --- Nhập lịch ca tháng từ file Excel/CSV ---
   Gửi thẳng file trong body (không dùng multipart) cho gọn.
   Tháng áp dụng và cách áp nằm ở query: ?ym=2026-08&mode=merge|replace|preview */
app.post('/api/admin/schedule/import',
  requireUser, requireAdmin,
  express.raw({ type: () => true, limit: '8mb' }),   // nhận mọi kiểu, kể cả khi thiếu Content-Type
  (req, res) => {
    const ym = String(req.query.ym || '');
    const mode = ['merge', 'replace', 'preview'].includes(req.query.mode) ? req.query.mode : 'preview';

    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ ok: false, message: 'Không nhận được file.' });
    }

    let parsed;
    try {
      parsed = parseScheduleFile(req.body, ym);
    } catch (e) {
      return res.status(400).json({ ok: false, message: 'Không đọc được file: ' + e.message });
    }
    if (!parsed.count) {
      return res.status(400).json({ ok: false, message: parsed.errors[0] || 'File không có dòng nào hợp lệ.', errors: parsed.errors });
    }

    // Xem trước: đối chiếu với danh sách nhân sự, chưa ghi gì vào database
    if (mode === 'preview') {
      const names = parsed.rows.map((r) => r.name || r.key);
      const known = D.allUsers(req.scope).filter((u) => u.role === 'staff');
      const missing = parsed.rows.filter((r) =>
        !known.some((u) => (r.key && u.key === r.key.toUpperCase()) || (r.name && u.name === r.name))
      ).map((r) => r.name || r.key);

      const dayCount = parsed.rows.reduce((n, r) => n + Object.keys(r.days).length, 0);
      const keyCount = parsed.rows.filter((r) => r.personal_key).length;
      return res.json({
        ok: true, preview: true, ym: parsed.ym, count: parsed.count, dayCount, keyCount,
        matched: names.filter((n) => !missing.includes(n)), missing, errors: parsed.errors,
      });
    }

    const r = D.applySchedule(parsed, mode, req.scope);
    D.audit(req.user, 'schedule_import', `${r.ym} ${mode} ${r.matched.length} người / ${r.dayCount} ngày`, req.ip);

    res.json({
      ok: true, ...r,
      message: `Đã áp lịch tháng ${r.ym} (${mode === 'replace' ? 'ghi đè' : 'merge'}): `
        + `${r.matched.length} người, ${r.dayCount} ngày làm.`
        + (r.keySet.length ? ` Đặt mã cá nhân cho ${r.keySet.length} người.` : '')
        + (r.missing.length ? ` Không khớp ${r.missing.length} người: ${r.missing.slice(0, 5).join(', ')}.` : ''),
    });
  });

/* --- Xem lịch tháng đã nhập --- */
app.get('/api/admin/schedule', requireUser, requireAdmin, (req, res) => {
  const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
  const out = D.scheduleSummary(ym, req.scope);
  if (req.query.user_id) out.detail = D.scheduleOf(+req.query.user_id, ym);
  res.json(out);
});

/* --- Đổi khu vực (múi giờ) của nhân viên --- */
app.put('/api/admin/users/:id/location', requireUser, requireAdmin, (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const loc = String((req.body || {}).location || '').toUpperCase();
  if (!D.LOCATIONS.includes(loc)) {
    return res.status(400).json({ ok: false, message: 'Khu vực phải là ' + D.LOCATIONS.join(' hoặc ') + '.' });
  }
  D.db.prepare('UPDATE users SET location=? WHERE id=?').run(loc, +req.params.id);
  D.audit(req.user, 'location_update', `#${req.params.id} -> ${loc}`, req.ip);
  res.json({ ok: true, message: `Đã đổi khu vực sang ${loc} (${D.tzOf(loc)}).`, users: D.allUsers(req.scope) });
});

/* ============================================================
   TĨNH
   ============================================================ */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Lưới an toàn: dù không có cron, mỗi phút vẫn dọn ca bị quên.
setInterval(() => {
  try { D.sweepStale(); } catch (e) { console.error('sweep lỗi:', e.message); }
  try {
    const r = D.sweepRollCalls();
    if (r.planned || r.missed || r.deferred) {
      console.log(`[điểm danh] sinh ${r.planned} · vắng ${r.missed} · hoãn vì đang rời vị trí ${r.deferred}`);
    }
  } catch (e) { console.error('sweep điểm danh lỗi:', e.message); }
}, 60000);

app.listen(PORT, () => {
  const d = new Date();
  console.log(`Trạm trực đang chạy tại cổng ${PORT}`);
  console.log(`[giờ] Múi giờ: ${process.env.TZ} · giờ máy chủ hiện tại: ${d.toLocaleString('vi-VN')}`);
});
