'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const D = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Render đứng sau proxy — thiếu dòng này thì req.ip luôn là IP nội bộ.
// Đây đúng là lỗi khiến hệ thống chấm công cũ ghi 127.0.0.1 vào bản ghi.
app.set('trust proxy', true);

app.use(express.json());
app.use(cookieSession({
  name: 'tt',
  keys: [process.env.SESSION_SECRET || 'doi-chuoi-nay-trong-bien-moi-truong'],
  maxAge: 365 * 24 * 3600 * 1000,   // nhân viên không phải vào lại link mỗi ngày
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
}));

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

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Chỉ quản trị xem được mục này.' });
  }
  next();
}

/* --- Vào ca bằng link --- */
app.get('/k/:key', (req, res) => {
  const key = String(req.params.key || '').toUpperCase();
  const u = D.db.prepare('SELECT * FROM users WHERE key=? AND is_active=1').get(key);

  if (!u) {
    D.audit(null, 'key_invalid', key, req.ip);
    return res.redirect('/?e=nokey');
  }

  // Mỗi trình duyệt có một device_id riêng, sinh lần đầu và giữ trong cookie.
  if (!req.session.did) req.session.did = crypto.randomUUID();
  const did = req.session.did;

  if (!u.device_id) {
    // Lần đầu: gắn key với thiết bị này.
    D.db.prepare('UPDATE users SET device_id=?, device_seen_at=?, device_ua=? WHERE id=?')
      .run(did, Date.now(), (req.get('user-agent') || '').slice(0, 400), u.id);
    D.audit(u, 'device_bind', null, req.ip);
  } else if (u.device_id !== did) {
    // Key bị mở ở máy khác — chặn và ghi lại. Đây là chỗ bắt việc bấm hộ nhau.
    D.audit(u, 'device_mismatch', (req.get('user-agent') || '').slice(0, 200), req.ip);
    return res.redirect('/?e=device');
  }

  req.session.uid = u.id;
  res.redirect('/');
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
app.get('/api/state', requireUser, (req, res) => res.json(D.stateFor(req.user)));

app.post('/api/start', requireUser, (req, res) => {
  const r = D.startActivity(req.user, String((req.body || {}).code || ''), req.ip, req.get('user-agent'));
  res.status(r.ok ? 200 : 409).json({ ...r, state: D.stateFor(req.user) });
});

app.post('/api/stop', requireUser, (req, res) => {
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
   TĨNH
   ============================================================ */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Lưới an toàn: dù không có cron, mỗi phút vẫn dọn ca bị quên.
setInterval(() => {
  try { D.sweepStale(); } catch (e) { console.error('sweep lỗi:', e.message); }
}, 60000);

app.listen(PORT, () => console.log(`Trạm trực đang chạy tại cổng ${PORT}`));
