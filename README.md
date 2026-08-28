# Trạm trực

Quản lý ca trực và hoạt động rời vị trí cho các bộ phận
tách riêng theo brand AE và ST.

## Vào ca — nhân viên KHÔNG cần đăng nhập

Quản lý thêm nhân viên ở trang `/admin`, bấm **Chép link**, gửi cho từng người một lần.
Link kiểu `https://.../k/RYH8UTCL`. Lưu vào màn hình chính là mở ra vào thẳng.

Link **không gắn với thiết bị nào** — mở được ở bất kỳ máy nào, kể cả máy dùng chung
nhiều người. Việc xác định ai đang thao tác do **mã cá nhân** đảm nhiệm, vì mã mới là
thứ không đưa cho nhau được. Nghi link bị lộ thì bấm **Cấp key mới**, link cũ chết ngay.

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

## Xoá dữ liệu, làm lại từ đầu

Chạy trong **Shell** của Render:

| Lệnh | Xoá gì | Giữ lại |
|---|---|---|
| `node reset.js lichsu` | Chấm công, điểm danh, rời vị trí, ảnh, nhật ký | Nhân sự, mã cá nhân, mã NV, lịch ca, lịch nghỉ |
| `node reset.js lich` | Thêm lịch ca, lịch nghỉ, OT, miễn báo cáo | Nhân sự, mã cá nhân, mã NV, cấu hình |
| `node reset.js tatca` | Sạch mọi thứ kể cả nhân sự | Không giữ gì |

Phải gõ `XOA` để xác nhận. Thêm `--yes` để bỏ qua bước hỏi.

Riêng `tatca` cần **Restart service** sau khi chạy — hệ thống tạo lại database và
tài khoản quản trị từ `ADMIN_PASSWORD`.

Hai mức đầu có hiệu lực ngay, không cần restart.

## Ảnh xác nhận theo từng thao tác

| Thao tác | Ảnh webcam | Ảnh màn hình Trạm trực |
|---|---|---|
| Lên ca | bắt buộc | bắt buộc |
| Xuống ca | bắt buộc | bắt buộc |
| Điểm danh | bắt buộc | bắt buộc |
| Dừng hoạt động | không | bắt buộc |
| Bắt đầu hoạt động | không | không |

Dừng hoạt động chỉ cần ảnh màn hình vì mục đích là chứng minh **đã quay lại máy**,
không phải xác minh danh tính lần nữa.

Ảnh màn hình chụp bằng `getDisplayMedia` — trình duyệt hỏi chọn cửa sổ, nhân viên
chọn tab Trạm trực. Quản trị xem lại ở khung ảnh có hai tab **Ảnh chụp** và **Màn hình**;
riêng hoạt động chỉ có tab màn hình.

## Chỉ dùng trên máy tính

Chấm công **chỉ làm được trên máy tính**. Mở link nhân viên bằng điện thoại sẽ hiện
màn chặn, và mọi thao tác ghi đều bị từ chối ở tầng máy chủ.

Lý do: mỗi lần lên ca, xuống ca hay điểm danh đều phải kèm **ảnh chụp màn hình Trạm trực**
để chứng minh đang ngồi tại máy làm việc. Trình duyệt điện thoại không chụp được màn hình.

Chặn ở hai lớp: máy chủ đọc User-Agent, và trang tự kiểm tra thêm bằng cảm ứng —
bắt được cả iPad đời mới khai là Macintosh.

Trang quản trị **không bị chặn**, vẫn xem được bằng điện thoại.

Cần mở lại cho điện thoại thì đặt biến `ALLOW_MOBILE=1`.

## (Cũ) Cài lên điện thoại

Đây là web app cài được ra màn hình chính như app thường (PWA), không có trên App Store / CH Play.

**iPhone (Safari):** mở link → nút Chia sẻ ở thanh dưới → *Thêm vào MH chính*.
**Android (Chrome):** mở link → menu ⋮ → *Cài đặt ứng dụng* / *Thêm vào màn hình chính*.

Cài xong có icon riêng, mở lên chạy toàn màn hình, không thanh địa chỉ.

Trang có sẵn thẻ nhắc cài đặt, tự ẩn khi đã cài xong.

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

**Mã cá nhân** do quản lý tự đặt cho từng người: 4–32 ký tự, không khoảng trắng, chữ số
ký hiệu đều được. Ví dụ `x2560`, `52560`, `HA-0825`.

Cách đặt phổ biến là lấy từ lương tháng trước, vì không ai đưa lương của mình cho đồng
nghiệp — đó là thứ chặn được việc bấm hộ. Nhưng nội dung mã là việc của quản lý,
hệ thống không ép theo quy tắc nào.

Đặt mã bằng một trong hai cách: nút **Đặt mã** ở tab Nhân sự cho từng người, hoặc thêm cột
`MaCaNhan` vào file lịch tháng — mỗi tháng nhập lịch một lần là đổi mã luôn. Hệ thống **chỉ lưu bản băm bcrypt**,
không lưu và không trả về số gốc ở bất kỳ API nào. Người chưa đặt mã thì chưa bị chặn,
để không kẹt lúc mới triển khai.

Phải nhập mã ở **mọi thao tác**: lên ca, xuống ca, chấm công, bắt đầu rời vị trí, dừng rời vị trí.

## Ảnh xác nhận có mặt (chống chấm công hộ từ xa)

Chỉ mã cá nhân không chặn được việc mở link chấm công **từ ngoài công ty** — ai có
đúng mã (kể cả người khác đưa) vẫn bấm được, dù đang ở đâu. Vì vậy **lên ca, xuống
ca và mỗi lượt điểm danh ngẫu nhiên** đều bắt buộc kèm một **ảnh chụp trực tiếp**
bằng camera trước (selfie) ngay trong app, trước khi nhập mã cá nhân.

- Ảnh chụp **sống** qua `getUserMedia`, không cho chọn ảnh có sẵn từ thư viện —
  đây là điểm khác biệt với việc chỉ tải ảnh lên, vốn không chứng minh được người
  đó có mặt tại đúng thời điểm bấm.
- Ảnh được nén nhỏ ở trình duyệt (vuông ~480px, JPEG) trước khi gửi, nên không nặng
  mạng kể cả với đường truyền yếu.
- Server **chỉ lưu file ảnh trên đĩa** (`DATA_DIR/photos/<id-nhân-viên>/…`), không
  lưu trong SQLite, và **không cho chọn thao tác nào bỏ qua ảnh** — thiếu ảnh thì
  request bị chặn ở tầng server (`photo_required`), không chỉ chặn ở giao diện.
- Quản lý xem lại ảnh ở tab **Lịch sử / Trễ** (nút "Xem ảnh" từng dòng) và tab
  **Điểm danh** (nút "Xem lượt" → từng lượt có ảnh riêng). Chỉ quản trị đúng brand
  mới xem được ảnh của brand mình.
- **Chấm công tự do (`log`)**, nếu có dùng, không bắt buộc ảnh — chỉ áp dụng cho
  lên ca / xuống ca / điểm danh.

**Giới hạn cần biết:** ảnh chụp chặn được việc nhờ đồng nghiệp bấm hộ từ xa và
việc dùng chung link, nhưng không chống được trường hợp ảnh chụp một bức ảnh cũ
hoặc chụp lại chính màn hình — không có cách nào chặn tuyệt đối 100% chỉ bằng
web, vì trình duyệt không có quyền xác minh vật lý. Ảnh vẫn hữu ích để quản lý
**đối chiếu bằng mắt khi có nghi ngờ**, không phải để giám sát tự động 24/7.

**Dung lượng đĩa:** mỗi ảnh khoảng 30–120KB. Ảnh cộng dồn theo thời gian, không có
cơ chế tự xoá — nếu dùng lâu dài nên định kỳ dọn thư mục `DATA_DIR/photos` cho
những tháng đã qua, hoặc tự thêm cron dọn theo nhu cầu.

**Điểm danh ngẫu nhiên** — hệ thống tự bắn `ROLL_CALLS_PER_SHIFT` lượt rải đều trong ca
(cách đầu và cuối ca 20 phút, giữa các lượt tối thiểu 25 phút). Mỗi lượt phải xác nhận
bằng mã cá nhân trong `ROLL_CALL_WINDOW_MIN` phút, quá hạn tính vắng.

**Đang rời vị trí thì không tính vắng.** Lượt rơi đúng lúc nhân viên đang đi vệ sinh hay
lấy đồ sẽ được hoãn, hệ thống ghi nhận lý do và tạo sẵn một lượt bù. Bấm Dừng lại xong
`ROLL_CALL_MAKEUP_MIN` phút thì lượt bù hiện lên. Không bấm Dừng mà bỏ lỡ thì vẫn tính vắng.

### Cách tính trễ

Mốc tính trễ là **đúng giờ ca**. Quá giờ dù 1 phút cũng là trễ, và trễ bao nhiêu phút
thì ghi đúng bấy nhiêu.

Ca 20:43, bấm lúc 20:44 là trễ 1 phút. Bấm 20:41 là sớm 2 phút, tính đúng giờ.
Phần giây bị cắt bỏ chứ không làm tròn — bấm 20:43:57 vẫn là đúng giờ.

Muốn bắt có mặt sớm trước giờ ca thì đặt `SHIFT_EARLY_MIN` lớn hơn 0.

| Mức | Điều kiện |
|---|---|
| Trễ lên ca ~1p | Quá mốc từ 1 phút |
| Trễ lên ca ~30p | Quá mốc từ 30 phút |
| Trễ xuống ca ~60p | Quá giờ tan ca từ 60 phút |

Cột **Theo lịch** trong bảng hiện mốc đã trừ sẵn, không phải giờ ca.

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

## Tuân thủ báo cáo

Trạm trực đọc thẳng **Google Sheets báo cáo duyệt rút / duyệt khuyến mãi** qua Service Account.
Không có form báo cáo riêng — nội dung chính là dữ liệu thật đã có cấu trúc, nên không gõ bừa được.

**Cách nhận biết ai chưa điền:** có ca trong lịch mà **không file nào** có dòng mang **Mã NV**
của người đó trong ngày đó = nợ.

Khai nhiều file trong biến `REPORT_SHEETS`, mỗi dòng một file:

```
Chứng từ USDT|19KQ7pC0bkzhIiMEy2BTsMWEFumWPF-37QsepFWH1viI|Nhập liệu
Xử lý gian lận|1AbCdEf...|Nhập liệu
Duyệt rút & KM|1XyZ123...|Nhập liệu
```

Dạng `Tên hiển thị | spreadsheetId | Tên tab`. Mỗi ngày RISK chỉ phát sinh một hai loại việc
chứ không phải cả ba, nên **có dòng ở bất kỳ file nào là đủ**.

Một file lỗi thì các file còn lại vẫn đọc bình thường. Chỉ khi **mọi file đều lỗi** hệ thống
mới bỏ qua hoàn toàn và không chặn ai.

Mã NV (`CS01`, `RSK03`…) do Trạm trực sinh sẵn, xem và sửa ở tab Nhân sự. Thêm cột `MaNV`
vào **cả ba file** và điền mã này ở mỗi dòng.

Tên cột nhận diện linh hoạt: cột nào bắt đầu bằng `Ngày` đều tính là cột ngày
(`Ngày`, `Ngày phát hiện`, `Ngày xử lý`), tương tự với `Số tiền`, `Loại`, `Người xử lý`.
Số tiền đọc được cả `1.266.000` kiểu Việt Nam lẫn `1,266,000` kiểu Anh.

> **Không dùng mã cá nhân làm cột trong sheet.** Sheet cả team cùng xem, để mã cá nhân vào
> là lộ ngay và mất luôn tác dụng chống bấm hộ. Mã NV thì lộ ra cũng không mở được gì.

**Ba nấc chặn**

1. **Không bấm được Xuống ca** khi hôm nay chưa có dòng nào. Bỏ về luôn thì hệ thống ghi
   chưa xuống ca, tự thành trễ xuống ca 60 phút và vào danh sách trễ.
2. **Không bấm được Lên ca** khi còn nợ từ `REPORT_BLOCK_AFTER` ca. Màn hình ghi rõ nợ ngày nào.
3. **Cảnh báo khóa BO** khi nợ từ `REPORT_ALERT_AFTER` ca — hiện đỏ ở tab Báo cáo.

**Tự mở khóa.** Điền vào sheet rồi bấm "Tôi đã điền rồi" là hệ thống đọc lại ngay, thấy dòng
là mở trong vài giây. Không chờ ai duyệt.

**Ca không phát sinh việc** thì bấm "Ca không phát sinh" và ghi lý do tối thiểu 10 ký tự —
để phân biệt ca trống với quên điền. Quản trị cũng miễn được từng ca ở tab Báo cáo.

**Sheet lỗi thì không chặn ai.** Mất mạng hay hết quyền đọc thì hệ thống cho qua hết,
vì thà bỏ sót vài ca còn hơn khóa nhầm cả team giữa giờ làm.

**Theo dõi ở tab Báo cáo:** lưới ô vuông mỗi người mỗi ca — xanh là đã điền, xám là được miễn,
đỏ là chưa điền. Nhìn lướt thấy ngay ai có vệt đỏ. Kèm số ca nợ và trạng thái chặn.

### Cấu hình

Cần ba biến môi trường: `REPORT_SHEETS`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`.

Nhớ chia sẻ **cả ba file** cho Service Account, không chỉ một file.

Hai biến Google lấy từ file JSON key của Service Account — dùng lại được key của bot báo cáo
đang chạy. Sau đó vào file Sheets bấm **Chia sẻ**, dán email Service Account, chọn **Người xem**.
Không cần quyền sửa vì chỉ đọc.

## Lịch ca theo tháng

Ca thay đổi từng ngày nên không dùng một khung giờ cố định. Quản trị nhập file Excel/CSV
ở tab **Nhân sự**, một dòng một người, mỗi ngày trong tháng một cột:

| Ma | Ten | KhuVuc | BoPhan | Brand | MaCaNhan | ThangLuong | 1 | 2 | … | 14 | 15 | … |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 9F2K7QX3 | Nguyễn Thu Hà | VN | CS | AE | 52560 | 2026-07 | 08:00-16:00 | 08:00-16:00 | … | OFF | OFF | … |

- **Ma** là mã 8 ký tự trong link vào ca. Không có cột này thì khớp theo **Ten** (phải trùng khớp tuyệt đối).
- Ô ghi `HH:mm-HH:mm` (chấp nhận `12h00-22h00`); để trống hoặc `OFF` / `Nghỉ` = ngày nghỉ.
- Ca qua đêm (`22:00-06:00`) tự hiểu là kết thúc vào ngày hôm sau.
- Ngày không có lịch thì bấm chấm công vẫn ghi nhận nhưng **không tính trễ**.
- **MaCaNhan** do quản lý tự đặt (4–32 ký tự, không khoảng trắng), **ThangLuong** dạng `2026-07`.
  Để trống hai cột này thì giữ nguyên mã cũ. Hệ thống băm ngay khi nhận, không lưu bản gốc.
  **Định dạng cột MaCaNhan thành Text trong Excel**, nếu không Excel cắt mất số 0 đầu.

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
| `SHIFT_EARLY_MIN` | 0 | 0 = tính trễ từ đúng giờ ca. Đặt >0 nếu bắt có mặt sớm |
| `LATE_IN_MIN1` | 1 | Quá mốc từ bấy nhiêu phút là trễ nhẹ |
| `LATE_IN_MIN2` | 30 | Ngưỡng trễ nặng |
| `LATE_OUT_MIN` | 60 | Ngưỡng trễ xuống ca |
| `ROLL_CALLS_PER_SHIFT` | 4 | Số lượt điểm danh ngẫu nhiên mỗi ca |
| `ROLL_CALL_WINDOW_MIN` | 5 | Số phút được phép xác nhận trước khi tính vắng |
| `ROLL_CALL_MAKEUP_MIN` | 3 | Sau khi dừng hoạt động bao lâu thì bắn lượt bù |
| `REPORT_SHEETS` | — | Danh sách file, mỗi dòng `Tên \| ID \| Tab` |
| `REPORT_SHEET_TTL_MIN` | 10 | Bao lâu đọc lại sheet một lần |
| `REPORT_BLOCK_AFTER` | 1 | Nợ mấy ca thì chặn vào ca mới |
| `REPORT_ALERT_AFTER` | 3 | Nợ mấy ca thì cảnh báo khóa BO |
| `REPORT_GRACE_MIN` | 60 | Sau giờ tan ca bao lâu mới tính là nợ |
| `REPORT_DEPTS` | cả 5 | Bộ phận phải nộp báo cáo |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | — | Email Service Account |
| `GOOGLE_PRIVATE_KEY` | — | Private key từ file JSON |

## Sao lưu

Toàn bộ dữ liệu nằm trong một file `tramtruc.db`, cộng thêm thư mục `photos/`
chứa ảnh xác nhận có mặt — cả hai đều nằm trong `DATA_DIR`. Sao lưu bằng cách
tải cả file `.db` lẫn thư mục `photos/` về (trên Render là toàn bộ Persistent
Disk gắn ở `DATA_DIR`). Nếu số nhân sự vượt vài trăm hoặc cần chạy nhiều instance
thì chuyển sang Postgres — lúc đó chỉ phải viết lại `db.js`, phần còn lại giữ
nguyên (ảnh vẫn có thể tiếp tục lưu trên đĩa hoặc chuyển sang object storage).
