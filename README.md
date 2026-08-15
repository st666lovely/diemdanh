# Trạm trực

Quản lý ca trực và hoạt động rời vị trí cho các bộ phận CS / CS ONL / VIP / RISK / RISK ONL,
tách riêng theo brand AE và ST.

## Vào ca — nhân viên KHÔNG cần đăng nhập

Quản lý thêm nhân viên ở trang `/admin`, bấm **Chép link**, gửi cho từng người một lần.
Link kiểu `https://.../k/RYH8UTCL`. Mở lần đầu là link gắn luôn với thiết bị đó;
từ đó lưu vào màn hình chính điện thoại, mở ra là vào thẳng.

Mở cùng link trên máy khác sẽ bị chặn và ghi vào nhật ký — đây là cơ chế chống bấm hộ.
Nhân viên đổi máy thì quản lý bấm **Gỡ máy**; nghi bị lộ link thì bấm **Cấp key mới**.

Chỉ quản trị mới đăng nhập bằng tài khoản + mật khẩu.

## Chạy trên máy

```bash
npm install
ADMIN_PASSWORD=matkhau-cua-ban npm start
# mở http://localhost:3000
```

Lần chạy đầu tự tạo tài khoản quản trị (mặc định `admin`). Đăng nhập xong đổi mật khẩu ngay.

## Deploy lên Render

1. Đẩy source lên GitHub (repo **private** — có tên và IP nhân viên).
2. Render → New → Blueprint → chọn repo. `render.yaml` khai báo sẵn mọi thứ.
3. Điền `ADMIN_PASSWORD` trong Dashboard.
4. Xong. Không cần Docker, không cần nginx, không cần script deploy.

**Gói Starter, không dùng Free.** Free ngủ sau 15 phút không có request; công cụ chấm công
phải sẵn sàng 24/7, đặc biệt là ca đêm.

## Cách khóa bộ phận hoạt động

Cột `activities.lock_key` mang giá trị `"AE|CS"` khi ca đang mở và loại hoạt động chiếm khóa,
đặt về `NULL` khi kết thúc. Cột này có `UNIQUE`.

SQLite (cũng như MySQL và Postgres) coi các giá trị `NULL` là khác nhau trong unique index,
nên hàng nghìn bản ghi đã đóng cùng tồn tại được, còn mỗi cặp brand + bộ phận chỉ tồn tại
đúng một ca đang mở.

Kiểm tra ở tầng ứng dụng chỉ để có thông báo dễ hiểu. Chốt chặn thật nằm ở database —
đã test 20 người cùng bộ phận bấm trong 59ms, đúng 1 người qua.

## Quên bấm "Dừng lại"

Quá thời lượng cho phép + 30 phút thì hệ thống tự đóng, ghi `closed_by = 'auto'` và hiện
nhãn "Quên bấm" ở trang quản trị. Không có cơ chế này thì một người quên bấm sẽ khóa
bộ phận vĩnh viễn.

Quét chạy mỗi lần đọc trạng thái, thêm một vòng nền mỗi phút. Không cần cron riêng.

## Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PORT` | 3000 | Render tự đặt |
| `DATA_DIR` | `./data` | Trên Render đặt `/var/data` (đường dẫn của Persistent Disk) |
| `SESSION_SECRET` | — | Bắt buộc đổi khi chạy thật |
| `ADMIN_USER` | `admin` | Chỉ dùng lần khởi tạo đầu tiên |
| `ADMIN_PASSWORD` | — | Chỉ dùng lần khởi tạo đầu tiên |

## Sao lưu

Toàn bộ dữ liệu nằm trong một file `tramtruc.db`. Sao lưu bằng cách tải file đó về.
Nếu số nhân sự vượt vài trăm hoặc cần chạy nhiều instance thì chuyển sang Postgres —
lúc đó chỉ phải viết lại `db.js`, phần còn lại giữ nguyên.
