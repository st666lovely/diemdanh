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

/* Chốt thiết bị: chạy trước mọi thao tác ghi của nhân viên.
   Chưa gắn -> gắn thiết bị hiện tại. Đã gắn máy khác -> chặn. */
function requireDevice(req, res, next) {
  const u = req.user;
  if (u.role === 'admin') return next();

  if (!req.session.did) req.session.did = crypto.randomUUID();
  const did = req.session.did;

  if (!u.device_id) {
    D.db.prepare('UPDATE users SET device_id=?, device_seen_at=?, device_ua=? WHERE id=?')
      .run(did, Date.now(), (req.get('user-agent') || '').slice(0, 400), u.id);
    D.audit(u, 'device_bind', null, req.ip);
    return next();
  }

  if (u.device_id !== did) {
    D.audit(u, 'device_mismatch', (req.get('user-agent') || '').slice(0, 200), req.ip);
    return res.status(403).json({
      ok: false, device_mismatch: true,
      message: 'Link này đã gắn với thiết bị khác. Nếu bạn vừa đổi máy hoặc vừa cài app lên màn hình chính, nhờ quản lý bấm "Gỡ máy" giúp.',
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Chỉ quản trị xem được mục này.' });
  }
  next();
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

  if (!req.session.did) req.session.did = crypto.randomUUID();
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
  const u = D.db.prepare("SELECT * FROM users WHERE username=? AND role='admin' AND is_active=1")
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
    device: {
      bound: !!req.user.device_id,
      is_this: req.user.device_id ? req.user.device_id === req.session.did : null,
    },
    key: req.user.role === 'staff' ? req.user.key : null,
  });
});

app.post('/api/start', requireUser, requireDevice, (req, res) => {
  const r = D.startActivity(req.user, String((req.body || {}).code || ''), req.ip, req.get('user-agent'));
  res.status(r.ok ? 200 : 409).json({ ...r, state: D.stateFor(req.user) });
});

app.post('/api/stop', requireUser, requireDevice, (req, res) => {
  const r = D.stopActivity(req.user, 'staff');
  res.status(r.ok ? 200 : 409).json({ ...r, state: D.stateFor(req.user) });
});

/* ============================================================
   QUẢN TRỊ
   ============================================================ */
app.get('/api/admin/board', requireUser, requireAdmin, (req, res) => {
  D.sweepStale();
  res.json({
    server_time: Date.now(),
    me: { name: req.user.name },
    lanes: D.lanes(), users: D.allUsers(), types: D.types(),
    departments: D.DEPTS, brands: D.BRANDS,
    ...D.history(req.query),
  });
});

app.post('/api/admin/close/:id', requireUser, requireAdmin, (req, res) => {
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
  const brand = D.BRANDS.includes(b.brand) ? b.brand : null;

  const key = D.newKey();
  D.db.prepare(`INSERT INTO users (name,key,department,brand,role,created_at)
                VALUES (?,?,?,?,'staff',?)`).run(name, key, b.department, brand, Date.now());
  D.audit(req.user, 'user_create', name, req.ip);
  res.json({ ok: true, message: `Đã thêm ${name}.`, users: D.allUsers() });
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
      const brand = D.BRANDS.includes((p[2] || '').toUpperCase()) ? p[2].toUpperCase() : null;
      if (!dept) { skipped.push(`${p[0]} — bộ phận không hợp lệ`); continue; }
      ins.run(p[0], D.newKey(), dept, brand, Date.now());
      created.push(p[0]);
    }
  })();

  D.audit(req.user, 'user_bulk', `${created.length} người`, req.ip);
  res.json({ ok: true, created, skipped, users: D.allUsers() });
});

app.put('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy.' });

  const name = String(b.name || u.name).trim();
  const dept = D.DEPTS.includes(b.department) ? b.department : u.department;
  const brand = b.brand === '' ? null : (D.BRANDS.includes(b.brand) ? b.brand : u.brand);
  const active = b.is_active === undefined ? u.is_active : (b.is_active ? 1 : 0);

  if (u.id === req.user.id && !active) {
    return res.status(400).json({ ok: false, message: 'Không thể tự khóa tài khoản của mình.' });
  }

  D.db.prepare('UPDATE users SET name=?,department=?,brand=?,is_active=? WHERE id=?')
    .run(name, dept, brand, active, u.id);
  D.audit(req.user, 'user_update', u.name, req.ip);
  res.json({ ok: true, message: 'Đã cập nhật.', users: D.allUsers() });
});

/* Cấp lại key: link cũ chết ngay, thiết bị cũ bị gỡ. Dùng khi nhân viên đổi máy
   hoặc nghi có người dùng chung link. */
app.post('/api/admin/users/:id/rekey', requireUser, requireAdmin, (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy.' });
  const key = D.newKey();
  D.db.prepare('UPDATE users SET key=?, device_id=NULL, device_seen_at=NULL, device_ua=NULL WHERE id=?')
    .run(key, u.id);
  D.audit(req.user, 'rekey', u.name, req.ip);
  res.json({ ok: true, message: `Đã cấp key mới cho ${u.name}. Link cũ không dùng được nữa.`, users: D.allUsers() });
});

/* Gỡ thiết bị mà giữ nguyên key — nhân viên đổi điện thoại thì dùng cái này */
app.post('/api/admin/users/:id/unbind', requireUser, requireAdmin, (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy.' });
  D.db.prepare('UPDATE users SET device_id=NULL, device_seen_at=NULL, device_ua=NULL WHERE id=?').run(u.id);
  D.audit(req.user, 'unbind', u.name, req.ip);
  res.json({ ok: true, message: `Đã gỡ thiết bị của ${u.name}. Link cũ vẫn dùng được trên máy mới.`, users: D.allUsers() });
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy.' });
  if (u.id === req.user.id) {
    return res.status(400).json({ ok: false, message: 'Không thể xóa tài khoản của chính mình.' });
  }
  // Khóa thay vì xóa — xóa là mất luôn lịch sử hoạt động của người đó.
  D.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(u.id);
  D.audit(req.user, 'user_deactivate', u.name, req.ip);
  res.json({ ok: true, message: `Đã khóa ${u.name}. Lịch sử vẫn giữ.`, users: D.allUsers() });
});

/* ============================================================
   CHẤM CÔNG CA / LỊCH SỬ / TRỄ / LỊCH OFF
   ============================================================ */

/* --- Nhân viên bấm Lên ca / Xuống ca / Chấm công --- */
app.post('/api/punch', requireUser, requireDevice, (req, res) => {
  const r = D.punch(req.user, String((req.body || {}).kind || ''), req.ip, req.get('user-agent'));
  res.status(r.ok ? 200 : 400).json({ ...r, shift: D.shiftToday(req.user) });
});

/* --- Lịch sử chấm công. Nhân viên chỉ thấy của mình, quản trị thấy hết. --- */
app.get('/api/punches', requireUser, (req, res) => {
  res.json({
    ...D.punchHistory(req.query, req.user),
    kinds: D.PUNCH_KINDS,
    levels: D.LATE_LEVELS,
    departments: D.DEPTS,
    brands: D.BRANDS,
    users: req.user.role === 'admin' ? D.allUsers().filter((u) => u.role === 'staff') : [],
    is_admin: req.user.role === 'admin',
  });
});

/* --- Danh sách trễ: cùng nguồn dữ liệu, ép lọc chỉ lấy bản ghi có mức trễ --- */
app.get('/api/late', requireUser, (req, res) => {
  res.json({
    ...D.punchHistory({ ...req.query, only_late: 1 }, req.user),
    levels: D.LATE_LEVELS,
    departments: D.DEPTS,
    brands: D.BRANDS,
    users: req.user.role === 'admin' ? D.allUsers().filter((u) => u.role === 'staff') : [],
    is_admin: req.user.role === 'admin',
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

app.post('/api/offs/toggle', requireUser, requireDevice, (req, res) => {
  const r = D.toggleOff(req.user, String((req.body || {}).day || ''));
  res.status(r.ok ? 200 : 400).json(r);
});

/* --- Lịch off toàn team, chỉ quản trị --- */
app.get('/api/admin/offs', requireUser, requireAdmin, (req, res) => {
  res.json({
    ...D.offSummary(String(req.query.ym || thisYm()), req.query),
    departments: D.DEPTS, brands: D.BRANDS,
    users: D.allUsers().filter((u) => u.role === 'staff'),
  });
});

/* Quản trị chỉnh hộ nhân viên — bỏ qua hạn mức và khóa tháng */
app.post('/api/admin/offs/toggle', requireUser, requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = D.db.prepare('SELECT * FROM users WHERE id=?').get(+b.user_id);
  if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy nhân viên.' });
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
      const known = D.allUsers().filter((u) => u.role === 'staff');
      const missing = parsed.rows.filter((r) =>
        !known.some((u) => (r.key && u.key === r.key.toUpperCase()) || (r.name && u.name === r.name))
      ).map((r) => r.name || r.key);

      const dayCount = parsed.rows.reduce((n, r) => n + Object.keys(r.days).length, 0);
      return res.json({
        ok: true, preview: true, ym: parsed.ym, count: parsed.count, dayCount,
        matched: names.filter((n) => !missing.includes(n)), missing, errors: parsed.errors,
      });
    }

    const r = D.applySchedule(parsed, mode);
    D.audit(req.user, 'schedule_import', `${r.ym} ${mode} ${r.matched.length} người / ${r.dayCount} ngày`, req.ip);

    res.json({
      ok: true, ...r,
      message: `Đã áp lịch tháng ${r.ym} (${mode === 'replace' ? 'ghi đè' : 'merge'}): `
        + `${r.matched.length} người, ${r.dayCount} ngày làm.`
        + (r.missing.length ? ` Không khớp ${r.missing.length} người: ${r.missing.slice(0, 5).join(', ')}.` : ''),
    });
  });

/* --- Xem lịch tháng đã nhập --- */
app.get('/api/admin/schedule', requireUser, requireAdmin, (req, res) => {
  const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
  const out = D.scheduleSummary(ym);
  if (req.query.user_id) out.detail = D.scheduleOf(+req.query.user_id, ym);
  res.json(out);
});

/* --- Đổi khu vực (múi giờ) của nhân viên --- */
app.put('/api/admin/users/:id/location', requireUser, requireAdmin, (req, res) => {
  const loc = String((req.body || {}).location || '').toUpperCase();
  if (!D.LOCATIONS.includes(loc)) {
    return res.status(400).json({ ok: false, message: 'Khu vực phải là ' + D.LOCATIONS.join(' hoặc ') + '.' });
  }
  D.db.prepare('UPDATE users SET location=? WHERE id=?').run(loc, +req.params.id);
  D.audit(req.user, 'location_update', `#${req.params.id} -> ${loc}`, req.ip);
  res.json({ ok: true, message: `Đã đổi khu vực sang ${loc} (${D.tzOf(loc)}).`, users: D.allUsers() });
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
}, 60000);

app.listen(PORT, () => {
  const d = new Date();
  console.log(`Trạm trực đang chạy tại cổng ${PORT}`);
  console.log(`[giờ] Múi giờ: ${process.env.TZ} · giờ máy chủ hiện tại: ${d.toLocaleString('vi-VN')}`);
});
