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

## Hai brand, một hệ thống, quản trị tách riêng

Ba mức tài khoản:

| Vai trò | Thấy gì |
|---|---|
| `super` — quản trị tổng | Cả AE và ST. Là người duy nhất tạo được tài khoản quản trị brand |
| `admin` — quản trị brand | Chỉ nhân sự, chấm công, trễ, lịch off, lịch ca của **đúng brand mình** |
| `staff` — nhân viên | Chỉ dữ liệu của chính mình |

Quản trị brand AE **không thấy và không đụng được** bất cứ thứ gì của ST, và ngược lại:
danh sách nhân sự, bảng theo dõi, lịch sử chấm công, danh sách trễ, lịch off, nhập lịch ca —
tất cả đều lọc theo brand ở tầng truy vấn, không phải chỉ ẩn trên giao diện.

Thêm nhân sự thì brand bị ép cứng theo tài khoản đang đăng nhập, kể cả khi file nhập
hàng loạt ghi brand khác. Ghi đè lịch tháng cũng chỉ xoá lịch của người trong brand mình.

Tài khoản `super` được tạo ở lần chạy đầu từ `ADMIN_USER` / `ADMIN_PASSWORD`.
Sau đó vào tab **Quản trị viên** để tạo tài khoản cho từng brand.

## Cài lên điện thoại

Đây là web app cài được ra màn hình chính như app thường (PWA), không có trên App Store / CH Play.

**iPhone (Safari):** mở link → nút Chia sẻ ở thanh dưới → *Thêm vào MH chính*.
**Android (Chrome):** mở link → menu ⋮ → *Cài đặt ứng dụng* / *Thêm vào màn hình chính*.

Cài xong có icon riêng, mở lên chạy toàn màn hình, không thanh địa chỉ.

**Dặn nhân viên: cài lên màn hình chính TRƯỚC khi bấm chấm công lần đầu.**
Link gắn cứng vào thiết bị ở lần bấm đầu tiên, không phải lần mở trang. Trên iPhone,
app ở màn hình chính dùng kho cookie riêng với Safari nên bị coi là thiết bị khác —
bấm trong Safari trước rồi mới cài thì app sẽ bị chặn, phải nhờ quản lý bấm *Gỡ máy*.

Trang có sẵn thẻ nhắc việc này, tự ẩn khi đã cài xong.

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

## Mã cá nhân & điểm danh

**Mã cá nhân** lấy từ lương tháng trước, dạng 5 chữ số: chữ số hàng trăm nghìn + 4 số cuối.
Lương 42.560.000 thì mã là `52560`. Chọn con số này vì không ai đưa lương của mình cho
đồng nghiệp, nên nó chặn được việc bấm hộ.

Quản lý đặt mã cho từng người ở tab **Nhân sự**. Hệ thống **chỉ lưu bản băm bcrypt**,
không lưu và không trả về số gốc ở bất kỳ API nào. Người chưa đặt mã thì chưa bị chặn,
để không kẹt lúc mới triển khai.

Phải nhập mã ở **mọi thao tác**: lên ca, xuống ca, chấm công, bắt đầu rời vị trí, dừng rời vị trí.

**Điểm danh ngẫu nhiên** — hệ thống tự bắn `ROLL_CALLS_PER_SHIFT` lượt rải đều trong ca
(cách đầu và cuối ca 20 phút, giữa các lượt tối thiểu 25 phút). Mỗi lượt phải xác nhận
bằng mã cá nhân trong `ROLL_CALL_WINDOW_MIN` phút, quá hạn tính vắng.

**Đang rời vị trí thì không tính vắng.** Lượt rơi đúng lúc nhân viên đang đi vệ sinh hay
lấy đồ sẽ được hoãn, hệ thống ghi nhận lý do và tạo sẵn một lượt bù. Bấm Dừng lại xong
`ROLL_CALL_MAKEUP_MIN` phút thì lượt bù hiện lên. Không bấm Dừng mà bỏ lỡ thì vẫn tính vắng.

### Âm báo

Khi tới lượt điểm danh hoặc hết giờ rời vị trí, app đánh cùng lúc bốn kênh:

| Kênh | Hoạt động khi |
|---|---|
| Chuông (tự dựng bằng Web Audio, không cần file) | Loa còn mở, và đã bấm "Bật âm báo" ít nhất một lần |
| Rung | Điện thoại Android; iPhone không cho web rung |
| Thông báo hệ thống | Đã cho phép quyền thông báo. Kêu cả khi tab bị ẩn |
| Viền đỏ nháy + tiêu đề tab nhấp nháy | Luôn luôn, kể cả khi tắt tiếng hoàn toàn |

Chuông lặp lại tới khi xử lý xong, không tự tắt sau vài giây.

**Không ép được máy kêu khi loa đã tắt ở tầng hệ điều hành.** Trang web không có quyền
chỉnh âm lượng máy — đây là giới hạn của mọi trình duyệt, không có cách lách. Vì vậy
app đánh nhiều kênh cùng lúc: tắt tiếng thì vẫn còn rung, thông báo và màn hình nháy.

Trình duyệt cũng chặn phát tiếng tới khi người dùng chạm màn hình lần đầu, nên app hiện
thẻ **"Bật âm báo cho ca này"** ở đầu trang. Dặn nhân viên bấm một lần mỗi khi mở app.

App cũng giữ màn hình không tắt trong ca (Screen Wake Lock) — màn tắt thì không thấy thẻ điểm danh.

Xem số liệu ở tab **Điểm danh**: tổng lượt, đã điểm danh, vắng, lượt bù, tỉ lệ theo từng người.

## Lịch ca theo tháng

Ca thay đổi từng ngày nên không dùng một khung giờ cố định. Quản trị nhập file Excel/CSV
ở tab **Nhân sự**, một dòng một người, mỗi ngày trong tháng một cột:

| Ma | Ten | KhuVuc | BoPhan | Brand | 1 | 2 | … | 14 | 15 | … |
|---|---|---|---|---|---|---|---|---|---|---|
| 9F2K7QX3 | Nguyễn Thu Hà | VN | CS | AE | 08:00-16:00 | 08:00-16:00 | … | OFF | OFF | … |

- **Ma** là mã 8 ký tự trong link vào ca. Không có cột này thì khớp theo **Ten** (phải trùng khớp tuyệt đối).
- Ô ghi `HH:mm-HH:mm` (chấp nhận `12h00-22h00`); để trống hoặc `OFF` / `Nghỉ` = ngày nghỉ.
- Ca qua đêm (`22:00-06:00`) tự hiểu là kết thúc vào ngày hôm sau.
- Ngày không có lịch thì bấm chấm công vẫn ghi nhận nhưng **không tính trễ**.

Ba nút: **Xem trước** (đối chiếu, chưa ghi gì), **Merge** (chỉ đụng người có trong file),
**Ghi đè tháng** (xoá sạch lịch tháng đó của mọi người rồi ghi lại).

Cùng định dạng với bot điểm danh Telegram, chỉ khác cột định danh: bot dùng `TelegramID`,
ở đây dùng `Ma`. Thêm một cột là dùng chung được một file cho cả hai.

## Nghỉ phép: nguyện vọng và lịch chính thức

Hai thứ khác nhau, cố ý giữ riêng:

- **Đăng ký nghỉ** (`day_offs`) — nguyện vọng nhân viên tự đặt trước.
- **Lịch ca** (`shift_days`) — kết quả quản lý xếp, nhập từ file Excel. Ngày không có ca = nghỉ chính thức.

Quy trình bốn bước:

1. Nhân viên đăng ký nguyện vọng (tối đa `MAX_OFF_PER_MONTH` ngày, mỗi bộ phận 1 người/ngày).
2. Quản lý mở tab **Lịch off** xem nguyện vọng cả team rồi xếp ca.
3. Nhập file lịch ở tab **Nhân sự**.
4. **Khóa tháng** để chốt — nhân viên không sửa được nữa, quản trị vẫn chỉnh được.

Sau bước 3, hệ thống tự đối chiếu. Trên lịch của nhân viên:

| Màu | Nghĩa |
|---|---|
| Xanh đậm | Xin nghỉ và được duyệt |
| Đỏ gạch ngang | Xin nghỉ nhưng lịch vẫn xếp ca |
| Xanh nhạt | Lịch cho nghỉ (không đăng ký vẫn được nghỉ) |
| Gạch chéo | Người cùng bộ phận đã nhận ngày đó |

Bên quản trị có cột **Đối chiếu lịch** và chip lọc **Chưa đáp ứng** để thấy ngay ai bị xếp
đè lên nguyện vọng — dùng khi cần giải thích hoặc bù ngày khác.

**Lịch chính thức là thứ quyết định việc tính trễ**, không phải đăng ký. Ngày nào lịch
không xếp ca thì bấm chấm công vẫn ghi nhận nhưng không tính trễ.

## Khu vực và múi giờ

Giờ trong file luôn là **giờ địa phương** của nhân viên đó. Cột `KhuVuc` quyết định múi giờ:

| KhuVuc | Múi giờ |
|---|---|
| `VN` | Asia/Ho_Chi_Minh |
| `ARM` | Asia/Yerevan |

Cùng ghi `08:00-16:00` thì người ở VN vào ca lúc 01:00 UTC, người ở Armenia lúc 04:00 UTC —
lệch đúng 3 tiếng. Trang của nhân viên cũng hiển thị đồng hồ theo giờ địa phương của chính họ.

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
| `TZ` | `Asia/Ho_Chi_Minh` | Múi giờ máy chủ. Giờ ca của từng người tính theo khu vực riêng, không theo biến này |
| `DEFAULT_TZ` | `Asia/Ho_Chi_Minh` | Múi giờ dùng khi nhân viên chưa gán khu vực |
| `SESSION_SECRET` | — | Bắt buộc đổi khi chạy thật |
| `ADMIN_USER` | `admin` | Chỉ dùng lần khởi tạo đầu tiên |
| `ADMIN_PASSWORD` | — | Chỉ dùng lần khởi tạo đầu tiên |
| `MAX_OFF_PER_MONTH` | 15 | Số ngày off tối đa mỗi nhân viên trong một tháng |
| `MAX_OFF_PER_DAY_DEPT` | 1 | Số người cùng bộ phận được nghỉ trong cùng một ngày |
| `ROLL_CALLS_PER_SHIFT` | 4 | Số lượt điểm danh ngẫu nhiên mỗi ca |
| `ROLL_CALL_WINDOW_MIN` | 5 | Số phút được phép xác nhận trước khi tính vắng |
| `ROLL_CALL_MAKEUP_MIN` | 3 | Sau khi dừng hoạt động bao lâu thì bắn lượt bù |

## Sao lưu

Toàn bộ dữ liệu nằm trong một file `tramtruc.db`. Sao lưu bằng cách tải file đó về.
Nếu số nhân sự vượt vài trăm hoặc cần chạy nhiều instance thì chuyển sang Postgres —
lúc đó chỉ phải viết lại `db.js`, phần còn lại giữ nguyên.
