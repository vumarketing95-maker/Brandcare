# Backend nội bộ — hướng dẫn triển khai

Server nhỏ này làm 2 việc cho tool "Trung tâm Hiệu suất Quảng cáo", cả 2 đều CẦN 1 server đứng sau vì file
`internal-tool.html` là file HTML tĩnh chạy trong trình duyệt — không thể giữ API key an toàn ở đó (ai mở file
cũng thấy được key):

1. **Chấm điểm nội dung tự động** (nút "🤖 Phân tích ngay") — tải nội dung từ link, cắt khung hình nếu là
   video, gửi Claude chấm theo đúng bộ tiêu chí thuật toán từng nền tảng, trả điểm về ngay cho tool.
2. **Làm mới dữ liệu Facebook trực tiếp** (nút "🔄 Làm mới dữ liệu Facebook ngay", hoặc bật "Tự động làm mới
   mỗi 5 phút") — gọi Windsor.ai lấy số chi tiêu/tin nhắn/bình luận mới nhất, thay cho việc phải nhờ Claude
   chạy lại thủ công mỗi lần muốn số mới.

Cả 2 dùng CHUNG 1 server, 1 URL, 1 mã bí mật (APP_SECRET) — chỉ cần deploy 1 lần.

**Giới hạn thật cần biết (chấm điểm nội dung):** Claude không "xem" video được — server tự cắt 4 khung hình
tĩnh (đầu/30%/60%/cuối video) rồi gửi các ảnh đó cho Claude chấm. Chính xác hơn nhiều so với không chấm gì,
nhưng không đánh giá được chuyển động thật, nhịp dựng, hay âm thanh như khi xem trực tiếp toàn bộ video.

## Bước 1 — Lấy 2 API key (Anthropic + Windsor.ai)

**1a. API key Claude (Anthropic)** — dùng cho chấm điểm nội dung:
1. Vào https://console.anthropic.com/settings/keys, đăng nhập/tạo tài khoản (chọn "Tổ chức" nếu key dùng cho
   công ty, xem thêm ở khung chat đã trao đổi).
2. Tạo 1 API key mới (Expires: "Never" vì key này chạy nền liên tục trên server), copy lại (chỉ hiện 1 lần —
   **dán trực tiếp vào ô Environment Variables ở Bước 2, KHÔNG dán vào chat hay bất kỳ đâu khác**).
3. Ở mục Billing, nạp ít tiền vào và **đặt giới hạn chi tiêu (spending limit)** để tránh phát sinh ngoài ý muốn.

**1b. API key Windsor.ai** — dùng cho làm mới dữ liệu Facebook trực tiếp (khác hoàn toàn với key Anthropic ở
trên, và khác với việc kết nối Windsor.ai qua Claude mà anh đã làm trước đó — đây là 1 API key riêng lấy trực
tiếp từ chính tài khoản windsor.ai):
1. Đăng nhập https://app.windsor.ai bằng đúng tài khoản đã kết nối 15 tài khoản Facebook Ads.
2. Vào **Settings → API Access**, lấy API key hiện có (hoặc tạo mới nếu chưa có).
3. Copy lại — cũng dán trực tiếp vào ô Environment Variables ở Bước 2, không dán vào chat.

## Bước 2 — Deploy server lên Render (miễn phí để bắt đầu)

1. Vào https://render.com, đăng nhập bằng GitHub (hoặc tạo tài khoản).
2. Đưa thư mục `scoring-backend` này lên 1 repo GitHub riêng (có thể tạo repo mới, kéo thả đúng các file:
   `server.js`, `rubric.js`, `package.json`, `Dockerfile`, `.env.example`, `README.md`).
3. Trên Render: **New +** → **Web Service** → chọn đúng repo vừa tạo.
4. Ở phần cấu hình:
   - **Environment**: chọn **Docker** (Render tự nhận diện `Dockerfile`).
   - **Instance Type**: Free để thử trước; nếu muốn dữ liệu Facebook luôn tự làm mới liên tục (không "ngủ"
     giữa chừng), nên nâng lên gói trả phí thấp nhất (thường vài USD/tháng) — xem mục "Chi phí" bên dưới.
5. Ở mục **Environment Variables**, thêm:
   - `ANTHROPIC_API_KEY` = key lấy ở Bước 1a
   - `WINDSOR_API_KEY` = key lấy ở Bước 1b
   - `APP_SECRET` = tự đặt 1 chuỗi bất kỳ, càng dài càng khó đoán (VD 1 đoạn 20-30 ký tự ngẫu nhiên) — dùng
     chung để bảo vệ CẢ 2 tính năng (chấm điểm + làm mới dữ liệu)
   - (tuỳ chọn) `CLAUDE_MODEL` nếu muốn đổi model khác mặc định
6. Bấm **Create Web Service** — đợi Render build xong (vài phút), Render sẽ cấp cho anh 1 URL dạng
   `https://ten-app-cua-anh.onrender.com`.
7. Kiểm tra server sống chưa: mở `https://ten-app-cua-anh.onrender.com/health` trên trình duyệt, thấy
   `{"ok":true}` là server đã chạy.

## Bước 3 — Kết nối vào tool

1. Mở `internal-tool.html`, mở khối **"⚙️ Cấu hình backend"** ngay dưới thanh badge trên cùng của trang
   (dùng chung cho cả 2 tính năng, không cần cấu hình riêng từng chỗ).
2. Điền:
   - **URL backend**: URL Render ở Bước 2 (VD `https://ten-app-cua-anh.onrender.com`)
   - **Mã bí mật backend**: đúng giá trị `APP_SECRET` đã đặt ở Bước 2
3. Ngay khi điền đủ 2 ô này, tool **tự động làm mới dữ liệu Facebook ngay lập tức VÀ tự bật chế độ làm mới mỗi
   5 phút** — không cần bấm thêm gì. Có thể tắt tự động bằng cách bỏ tick ô "Tự động làm mới mỗi 5 phút".
4. Sang tab "📋 Chấm điểm nội dung": dán link nội dung nháp + chọn nền tảng/mục tiêu như bình thường, bấm
   **"🤖 Phân tích ngay"** — kết quả hiện thẳng trong bảng sau vài giây tới vài chục giây.
5. Nếu 1 trong 2 tính năng báo lỗi (badge đỏ ở đầu trang, hoặc thông báo lỗi khi bấm Phân tích ngay), phương
   án dự phòng luôn còn: dữ liệu Facebook giữ nguyên snapshot/lần làm mới gần nhất (không mất dữ liệu); chấm
   điểm nội dung vẫn dùng được qua "📋 Sao chép yêu cầu chấm" + dán vào chat thủ công.

## Lưu ý về link nội dung (chấm điểm)

- Video/ảnh trên Google Drive: phải để chế độ chia sẻ **"Bất kỳ ai có link đều xem được"**, nếu không server
  không tải được (giống hệt việc Claude qua chat cũng không mở được link riêng tư).
- File quá lớn (>200MB) sẽ bị từ chối để tránh tốn tài nguyên/tiền — nên nén video nháp trước khi chấm.
- Link không phải file trực tiếp (VD link Canva dạng trang chỉnh sửa, link TikTok bài đăng công khai) có thể
  không tải được — trường hợp này dùng cách chấm qua chat thủ công (Sao chép yêu cầu chấm) đáng tin cậy hơn.

## Lưu ý về dữ liệu Facebook trực tiếp

- Mỗi lần làm mới, server kéo **60 ngày gần nhất** từ Windsor.ai (đủ cho mọi bộ lọc trong tool: Hôm nay/7 ngày/
  30 ngày) — không kéo toàn bộ lịch sử để tránh chậm.
- Facebook cần 24-72 giờ để ghi nhận đầy đủ tin nhắn/chuyển đổi — số của "Hôm nay"/"Hôm qua" luôn có khả năng
  bị đếm thiếu dù đã làm mới, kể cả với dữ liệu trực tiếp. Đây là độ trễ tự nhiên của Meta, không phải lỗi.
- Nếu gói Render đang dùng là Free, server "ngủ" sau 15 phút không có ai gọi — lần làm mới đầu tiên sau khi
  ngủ sẽ chậm hơn (~30-60 giây) do phải khởi động lại. Muốn "Tự động làm mới mỗi 5 phút" luôn mượt (không có
  độ trễ khởi động), nên nâng lên gói trả phí thấp nhất của Render.

## Chi phí

- Render: gói Free đủ để thử; dùng thật xuyên suốt (đặc biệt nếu bật tự động làm mới liên tục) nên nâng cấp
  (thường vài USD/tháng) để server không bị "ngủ".
- Anthropic API: tính theo lượng ảnh/token gửi đi, mỗi lần chấm nội dung (4 ảnh + prompt) thường chỉ vài trăm
  đồng — nên theo dõi ở console.anthropic.com/settings/billing và đặt giới hạn chi tiêu.
- Windsor.ai API: dùng chung hạn mức đã có sẵn trong gói Windsor.ai đang dùng (không phát sinh phí Anthropic
  nào cho phần này) — nếu gói Windsor.ai có giới hạn số lần gọi API, bật "Tự động làm mới mỗi 5 phút" sẽ gọi
  khoảng 12 lần/giờ; nếu lo vượt hạn mức, có thể chỉ bấm làm mới thủ công thay vì bật tự động liên tục.
