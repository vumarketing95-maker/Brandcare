// Bộ tiêu chí chấm điểm — PHẢI giữ khớp 1:1 với CONTENT_SCORING_RUBRIC trong internal-tool.html
// (đây là bản sao dùng ở server, vì server không đọc trực tiếp được file HTML của trình duyệt).
// Nếu sửa tiêu chí trong tool, nhớ sửa lại y hệt ở đây.
//
// Bám sát hướng dẫn CHÍNH THỨC do từng nền tảng tự công bố (Meta for Business/Meta Business Help Center,
// TikTok For Business, Google Ads Help — đối chiếu lại 16/08/2026), KHÔNG phải thuật toán xếp hạng nội bộ
// thật (không ai ngoài Meta/TikTok/Google truy cập được cái đó — giới hạn thật, không phải thiếu sót của tool).
const CONTENT_SCORING_RUBRIC = {
  facebook: {
    label: 'Facebook/Instagram (Advantage+ / Reels)',
    sourceNote: 'Đối chiếu: Meta for Business — "Best Practices to Optimize Video Ad Quality", "Best Practices for Mobile Video Ads", hướng dẫn Reels ads (an toàn vùng hiển thị, dựng dọc toàn màn hình, có âm thanh) — theo Meta, làm đúng 3 điều này giúp tăng gấp đôi khả năng được phân phối vào vị trí Reels.',
    criteria: [
      'Hook 3 giây đầu: mở đầu có chuyển động/hình ảnh gây chú ý ngay, không mở chậm hay đứng yên?',
      'Có thiết kế chủ động cho CẢ hai kiểu xem: có âm thanh/nhạc/lời thoại rõ ràng (Reels đa số xem có tiếng) VÀ vẫn có phụ đề/chữ trên màn hình để hiểu được khi tắt tiếng (Feed)?',
      'Dựng dọc toàn màn hình (9:16), thông điệp chính + CTA nằm trong vùng an toàn (safe zone) của Reels/Stories, không bị che bởi nút bấm/UI',
      'CTA (kêu gọi hành động) rõ ràng, đặt đúng lúc — thường ở đoạn kết',
      'Thời lượng phù hợp (khuyến nghị 15–30 giây cho Reels/Feed)',
      'Chữ phủ trên hình ảnh không quá nhiều (tránh bị giảm phân phối)',
    ],
  },
  tiktok: {
    label: 'TikTok',
    sourceNote: 'Đối chiếu: TikTok For Business — "Creative Best Practices for TikTok Ads" & "Creative best practices for performance ads" (ads.tiktok.com/help) — TikTok công bố 90% hiệu quả ghi nhớ quảng cáo đến từ 6 giây đầu; nội dung "native" (giống UGC) tạo tương tác cao hơn ~3.3 lần so với quảng cáo truyền thống.',
    criteria: [
      'Hook trong 6 giây đầu (đề xuất giá trị/nội dung chính nêu rõ trong 3 giây đầu) — đủ bất ngờ/tò mò/cảm xúc để người xem không lướt qua?',
      'Phong cách "native" — quay tự nhiên kiểu UGC (không quá bóng bẩy/dàn dựng), có người thật (nhân viên, khách hàng, người sáng tạo) thay vì quảng cáo studio truyền thống?',
      'Dựng dọc 9:16 toàn màn hình, độ phân giải tối thiểu 720p, nội dung nằm trong vùng an toàn của giao diện TikTok (không bị che bởi nút like/share/caption)',
      'Nhịp độ dựng nhanh, có cắt cảnh/chuyển cảnh/hiệu ứng giữ chân người xem hết video',
      'Có âm thanh/nhạc (bắt buộc — âm thanh là yếu tố cốt lõi trải nghiệm TikTok), có phụ đề/chữ trên màn hình hỗ trợ ngữ cảnh',
      'Có CTA rõ ràng ở đoạn kết + yếu tố khuyến khích tương tác (bình luận, chia sẻ, duet)?',
    ],
  },
  google: {
    label: 'Google Ads (YouTube/Performance Max/Display)',
    sourceNote: 'Đối chiếu: Google Ads Help — "About video assets for Performance Max campaigns" & "Best practices for video assets in Performance Max campaigns" (support.google.com/google-ads) — Google khuyến nghị video dài 10–60 giây, đủ 3 tỷ lệ khung hình (ngang/vuông/dọc), độ phân giải HD 1080p.',
    criteria: [
      'Đã có (hoặc dự kiến cắt thêm) đủ 3 tỷ lệ khung hình: ngang 16:9, vuông 1:1, dọc 9:16 — để Performance Max tự ghép đúng vị trí hiển thị (kể cả YouTube Shorts)?',
      'Thời lượng trong khoảng 10–60 giây (không quá ngắn dưới 10 giây, không quá dài lan man)?',
      'Logo/thương hiệu xuất hiện rõ và sớm — quan trọng vì định dạng có thể bị bấm Bỏ qua (skip) sớm trên YouTube?',
      'Chất lượng hình ảnh HD (khuyến nghị chuẩn 1080p), rõ nét kể cả khi hiển thị thu nhỏ (banner Display)?',
      'CTA rõ ràng, dễ đọc, không bị chữ nhỏ quá?',
      'Thông điệp giá trị/lợi ích chính được nêu rõ trong vài giây đầu, không lan man (vì có thể bị skip trước khi vào nội dung chính)?',
    ],
  },
};

module.exports = { CONTENT_SCORING_RUBRIC };
