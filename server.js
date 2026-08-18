// ================= BACKEND CHẤM ĐIỂM NỘI DUNG (tự động, gọi Claude API thật) =================
// Việc này CẦN thiết vì file internal-tool.html là 1 file HTML tĩnh chạy trong trình duyệt — không thể giữ
// API key an toàn ở đó (ai mở file cũng thấy được key). Server nhỏ này giữ API key, tải nội dung từ link,
// cắt frame nếu là video, gửi cho Claude chấm theo đúng bộ tiêu chí thuật toán từng nền tảng, trả điểm về.
//
// GIỚI HẠN THẬT cần biết: Claude API không "xem" video được — server tự cắt ra vài khung hình tĩnh (đầu/giữa/cuối)
// rồi gửi CÁC ẢNH đó cho Claude chấm. Nghĩa là Claude KHÔNG đánh giá được chuyển động thật, nhịp dựng, hay âm thanh —
// chỉ suy luận qua các khung hình tĩnh + tên file. Chính xác hơn nhiều so với không chấm gì, nhưng không bằng
// 1 người (hoặc Claude qua chat) xem trực tiếp toàn bộ video.

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { CONTENT_SCORING_RUBRIC } = require('./rubric');

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET || ''; // đặt 1 chuỗi bất kỳ để chặn người lạ gọi thẳng API tốn phí của anh
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929'; // kiểm tra lại ID model mới nhất tại console.anthropic.com nếu lỗi "model not found"
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB — chặn file quá to tốn tài nguyên/tiền

// Dữ liệu Facebook TRỰC TIẾP (live) từ Windsor.ai — khác với phần chấm điểm nội dung ở trên, dùng API key RIÊNG
// lấy từ chính tài khoản windsor.ai (Settings → API Access), KHÔNG phải key Anthropic ở trên.
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY || '';
const WINDSOR_BASE = process.env.WINDSOR_BASE || 'https://connectors.windsor.ai'; // override chỉ dùng khi test cục bộ
const WINDSOR_FIELDS = 'date,campaign,account_name,spend,actions_onsite_conversion_messaging_conversation_started_7d,actions_comment';
const WINDSOR_LOOKBACK_DAYS = 60; // kéo 60 ngày gần nhất mỗi lần làm mới — đủ cho mọi bộ lọc trong tool (Hôm nay/7 ngày/30 ngày), không kéo quá nhiều gây chậm

if (!ANTHROPIC_API_KEY) {
  console.error('THIẾU ANTHROPIC_API_KEY trong biến môi trường — server sẽ trả lỗi cho mọi yêu cầu chấm điểm cho tới khi anh khai báo key này.');
}
if (!WINDSOR_API_KEY) {
  console.error('THIẾU WINDSOR_API_KEY trong biến môi trường — mục "Làm mới dữ liệu trực tiếp" ở tool sẽ báo lỗi cho tới khi anh khai báo key này.');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function checkSecret(req, res) {
  if (!APP_SECRET) return true; // chưa đặt APP_SECRET thì bỏ qua kiểm tra (KHÔNG khuyến nghị dùng lâu dài)
  const got = req.header('x-app-secret') || '';
  if (got !== APP_SECRET) { res.status(401).json({ ok: false, error: 'Sai hoặc thiếu mã bí mật (x-app-secret). Kiểm tra lại ô "Mã bí mật backend" trong tool.' }); return false; }
  return true;
}

// Chuyển link chia sẻ Google Drive (dạng .../file/d/FILE_ID/view...) thành link tải trực tiếp.
// LƯU Ý: chỉ hoạt động nếu file đã để chế độ "Bất kỳ ai có link đều xem được" — Drive vẫn có thể chặn file
// lớn bằng trang cảnh báo virus-scan, đoạn code dưới xử lý được hầu hết trường hợp nhưng không đảm bảo 100%.
function resolveDirectUrl(link) {
  const driveMatch = link.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (driveMatch) return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  const driveOpenMatch = link.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (driveOpenMatch) return `https://drive.google.com/uc?export=download&id=${driveOpenMatch[1]}`;
  return link;
}

async function downloadToTemp(url, destPath) {
  let res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Không tải được link (HTTP ${res.status}). Kiểm tra link đã để chế độ "Bất kỳ ai có link đều xem được" chưa, hoặc link có yêu cầu đăng nhập không.`);
  let contentType = res.headers.get('content-type') || '';

  // Google Drive chặn file lớn bằng 1 trang HTML xác nhận ("không quét virus được, vẫn tải xuống?") — đọc trang đó
  // để lấy token "confirm=" rồi tải lại đúng file thật.
  if (contentType.includes('text/html') && url.includes('drive.google.com')) {
    const html = await res.text();
    const confirmMatch = html.match(/confirm=([0-9A-Za-z_]+)/) || html.match(/name="confirm"\s+value="([^"]+)"/);
    const idMatch = url.match(/id=([^&]+)/);
    if (confirmMatch && idMatch) {
      const retryUrl = `https://drive.google.com/uc?export=download&confirm=${confirmMatch[1]}&id=${idMatch[1]}`;
      res = await fetch(retryUrl, { redirect: 'follow' });
      contentType = res.headers.get('content-type') || '';
      if (!res.ok) throw new Error(`Không tải được file sau khi xác nhận Google Drive (HTTP ${res.status}).`);
    } else {
      throw new Error('Link Google Drive trả về trang xác nhận nhưng không đọc được token — có thể file chưa để chế độ công khai, hoặc thử đính kèm file trực tiếp thay vì dùng link.');
    }
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File quá lớn (${Math.round(contentLength / 1024 / 1024)}MB, giới hạn ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB).`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('File quá lớn sau khi tải về, vượt giới hạn cho phép.');
  await fsp.writeFile(destPath, buf);
  return { contentType, bytes: buf.length };
}

function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data || !data.format || !data.format.duration) return resolve(null);
      resolve(Number(data.format.duration));
    });
  });
}

// Đọc chiều rộng/cao thật của video gốc — dùng để biết có cần tự crop lại đúng tỷ lệ khung hình hay không
// (VD video quay ngang 16:9 nhưng nền tảng yêu cầu dọc 9:16).
function ffprobeDimensions(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) return resolve(null);
      const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
      if (!videoStream || !videoStream.width || !videoStream.height) return resolve(null);
      resolve({ width: videoStream.width, height: videoStream.height });
    });
  });
}

function extractFrame(filePath, timestampSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on('end', () => resolve(outPath))
      .on('error', (err) => reject(err))
      .screenshots({ timestamps: [timestampSec], filename: path.basename(outPath), folder: path.dirname(outPath), size: '640x?' });
  });
}

async function extractFramesForVideo(filePath, workDir) {
  const duration = await ffprobeDuration(filePath);
  let timestamps;
  if (duration && duration > 1) {
    timestamps = [
      Math.min(0.5, duration * 0.05),
      duration * 0.3,
      duration * 0.6,
      Math.max(duration - 0.5, duration * 0.9),
    ].map((t) => Math.max(0, Math.min(t, duration - 0.1)));
  } else {
    timestamps = [0.2]; // video quá ngắn hoặc không đọc được thời lượng — lấy đại 1 khung hình đầu
  }
  const frames = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outPath = path.join(workDir, `frame-${i}.jpg`);
    try {
      await extractFrame(filePath, timestamps[i], outPath);
      frames.push({ path: outPath, timestampSec: timestamps[i] });
    } catch (e) {
      console.error('Lỗi cắt frame ở giây', timestamps[i], e.message);
    }
  }
  return { frames, duration };
}

// Đặt tên dễ hiểu cho từng khung hình (VD "Đầu video (~5%)") để tool hiện lại đúng thứ tự, giúp người xem biết
// CHÍNH XÁC Claude đã nhìn thấy phần nào của video khi chấm — không phải chỉ 1 con số điểm chung chung.
function labelFramesForVideo(frameList, duration) {
  return frameList.map((f, i) => {
    if (!duration || duration <= 1) return { label: `Khung hình ${i + 1}` };
    const pct = Math.max(0, Math.min(100, Math.round((f.timestampSec / duration) * 100)));
    if (i === 0) return { label: `Đầu video (~${pct}%)` };
    if (i === frameList.length - 1) return { label: `Cuối video (~${pct}%)` };
    return { label: `Giữa video (~${pct}%)` };
  });
}

function buildPrompt(item) {
  const rubric = CONTENT_SCORING_RUBRIC[item.platform];
  const hookIdx = rubric.hookCriterionIndex || 1;
  // Liệt kê thời điểm (giây) của từng khung hình trong video gốc — để Claude có thể chỉ đích danh 1 khung hình
  // khác (thời điểm khác) làm điểm mở đầu mạnh hơn, thay vì chỉ nói chung chung "cắt bớt đoạn đầu".
  const frameTimeLines = (item.frameMeta && item.frameMeta.length > 1)
    ? item.frameMeta.map((f, i) => `- Khung hình ${i + 1} (${f.label}): giây ${Math.round(f.timestampSec)}${item.duration ? `/${Math.round(item.duration)}` : ''}`).join('\n')
    : '';
  const durationLine = (item.duration && rubric.targetDurationRange)
    ? `Thời lượng video gốc: ${Math.round(item.duration)} giây (khuyến nghị của nền tảng: ${rubric.targetDurationRange[0]}–${rubric.targetDurationRange[1]} giây).`
    : (item.duration ? `Thời lượng video gốc: ${Math.round(item.duration)} giây.` : '');

  return `Bạn đang xem ${item.frameCount > 1 ? `${item.frameCount} khung hình tĩnh cắt ra từ 1 video quảng cáo NHÁP (đầu/giữa/cuối video, KHÔNG phải toàn bộ chuyển động/âm thanh thật)` : '1 hình ảnh nội dung quảng cáo NHÁP'}. Chấm điểm nội dung này theo đúng tiêu chí thuật toán ${rubric.label}.
${frameTimeLines ? `\nThời điểm (giây) của từng khung hình trong video gốc:\n${frameTimeLines}\n` : ''}${durationLine ? `\n${durationLine}\n` : ''}
Mục tiêu quảng cáo: ${item.objective || 'Tin nhắn/Nhắn tin'}
Nội dung mới hay biến thể: ${item.variant || 'Mới hoàn toàn'}
Chủ đề / Ngành hàng: ${item.topic || '(không rõ — tự nhận diện qua nội dung nhìn thấy, KHÔNG suy đoán bừa nếu không chắc, chỉ mô tả chung "sản phẩm/dịch vụ" nếu chưa rõ đúng ngành gì)'}

QUAN TRỌNG: khi viết "note" và "suggestion" cho từng tiêu chí, PHẢI đối chiếu đúng "Chủ đề/Ngành hàng" ở trên — nếu đã biết rõ chủ đề, TUYỆT ĐỐI không nhắc tới sản phẩm/dịch vụ hay hình ảnh của ngành khác (VD: không nói về da liễu/thẩm mỹ da nếu chủ đề đã ghi rõ là cơ xương khớp). Nếu chủ đề chưa rõ, chỉ mô tả chung "sản phẩm/dịch vụ", không suy đoán bừa ngành hàng.

Chấm theo từng tiêu chí sau (mỗi tiêu chí 0–10 điểm, dựa trên các khung hình đang thấy — nếu tiêu chí liên quan tới chuyển động/âm thanh mà không đánh giá chắc chắn được từ ảnh tĩnh, hãy chấm điểm trung bình 5-6 và ghi rõ trong "note" là "không đánh giá được đầy đủ từ khung hình tĩnh"):
${rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

YÊU CẦU CHẤT LƯỢNG cho "note" và "suggestion" — đây là phần nhân sự content/ads sẽ đọc trực tiếp để sửa, PHẢI thực tế và làm được ngay, không được chung chung:
- "note": chỉ ra CHÍNH XÁC điều gì nhìn thấy (hoặc không thấy) trong khung hình dẫn tới điểm đó — neo vào chi tiết cụ thể (VD "khung hình đầu vẫn là cảnh tĩnh, chưa có sản phẩm hay người xuất hiện" thay vì "mở đầu chưa hấp dẫn").
- "suggestion": PHẢI là 1 hành động cụ thể, có thể làm ngay trong buổi dựng tiếp theo — nêu RÕ vị trí (giây nào/khung hình nào nếu liên quan), và RÕ đây là việc sửa được bằng hậu kỳ (cắt/dựng lại/thêm chữ/đổi thứ tự cảnh — nhân sự dựng video làm được ngay, không cần quay lại) hay BẮT BUỘC phải quay lại/chụp lại (cần đội quay dựng cảnh mới). Tuyệt đối tránh các cụm chung chung vô nghĩa như "làm hấp dẫn hơn", "cải thiện chất lượng", "tối ưu nội dung" — nếu định viết cụm như vậy, PHẢI thay bằng hành động cụ thể thay thế nó có nghĩa là gì. Nếu tiêu chí đã đạt điểm cao (≥8/10), "suggestion" có thể ghi ngắn gọn "Đã tốt, giữ nguyên".

RIÊNG tiêu chí số ${hookIdx} (tiêu chí hook/mở đầu) — nếu điểm dưới 8/10 VÀ đang xem VIDEO (nhiều khung hình, có liệt kê "Thời điểm khung hình" ở trên) VÀ trong các khung hình đó có 1 khung hình cho thấy khoảnh khắc mở đầu mạnh/thu hút hơn khung hình đầu hiện tại (chuyển động, cận cảnh sản phẩm, cảm xúc rõ...), hãy thêm field "hookRecutSec" = ĐÚNG 1 trong các số giây đã liệt kê ở trên (KHÔNG bịa số ngoài danh sách, KHÔNG suy diễn số giây không có trong danh sách). Nếu không có khung hình nào tốt hơn, hoặc đây là ảnh tĩnh (không phải video), hoặc điểm đã ≥8/10, để "hookRecutSec": null.

Trả lời DUY NHẤT bằng JSON hợp lệ theo đúng cấu trúc sau, không thêm chữ nào khác ngoài JSON:
{"totalScore100": <số nguyên 0-100, = trung bình cộng ${rubric.criteria.length} điểm tiêu chí x10>, "criteria": [{"index":1,"score10":<0-10>,"note":"<nhận xét ngắn, neo vào chi tiết cụ thể nhìn thấy>","suggestion":"<hành động cụ thể làm ngay được, ghi rõ hậu kỳ hay cần quay lại>","hookRecutSec":<chỉ điền ở ĐÚNG tiêu chí số ${hookIdx} — số giây hoặc null; các tiêu chí khác BỎ QUA field này>"}, ... đủ ${rubric.criteria.length} mục], "recommendation": "<1-2 câu nên sửa gì trước khi chạy quảng cáo, hoặc \\"Đủ điều kiện chạy\\" nếu tốt>"}`;
}

// Cắt 1 đoạn demo NGẮN (3-6 giây) từ CHÍNH video gốc, bắt đầu ở thời điểm Claude đề xuất — để xem thử "nếu mở
// đầu từ đây thì sao" mà không cần dựng lại thủ công. Đây là bản xem nhanh (không dựng chuyên nghiệp: không cắt
// cảnh, không thêm chữ/nhạc), chỉ giúp hình dung hướng sửa trước khi quyết định dựng lại chính thức.
function cutHookDemoClip(videoPath, workDir, startSec, duration) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(workDir, 'hook-demo.mp4');
    const clipLen = Math.max(3, Math.min(6, duration - startSec));
    if (clipLen < 1) { resolve(null); return; }
    ffmpeg(videoPath)
      .setStartTime(startSec)
      .duration(clipLen)
      .outputOptions([
        '-vf', 'scale=480:-2',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
      ])
      .on('end', async () => {
        try {
          const stat = await fsp.stat(outPath);
          if (stat.size > 8 * 1024 * 1024) { resolve(null); return; } // quá nặng — bỏ qua thay vì trả response nặng nề
          const buf = await fsp.readFile(outPath);
          resolve({
            dataUrl: `data:video/mp4;base64,${buf.toString('base64')}`,
            startSec: Math.round(startSec),
            durationSec: Math.round(clipLen),
          });
        } catch (e) { reject(e); }
      })
      .on('error', (err) => reject(err))
      .save(outPath);
  });
}

// Tự động dựng lại 1 BẢN VIDEO HOÀN CHỈNH (không chỉ demo hook ngắn) áp dụng các sửa CƠ HỌC làm được chắc chắn
// bằng ffmpeg, dựa trên đúng khung tiêu chí đang chấm — để nhân sự content/ads có sẵn 1 bản nháp đã sửa thay vì
// phải tự dựng lại từ đầu theo từng gợi ý chữ. CHỈ áp dụng các sửa có căn cứ rõ ràng từ rubric/kết quả chấm:
//   1) Cắt bỏ đoạn mở đầu yếu, bắt đầu video từ thời điểm Claude đã chỉ ra (tiêu chí Hook <8/10 + có hookRecutSec).
//   2) Cắt bớt thời lượng nếu vượt khung khuyến nghị của rubric (CHỈ khi rubric.targetDurationRange có đặt — xem
//      ghi chú trong rubric.js, TikTok không có tiêu chí thời lượng cụ thể nên KHÔNG tự cắt theo phỏng đoán).
//   3) Tự crop lại đúng tỷ lệ khung hình dọc 9:16 nếu video gốc quay sai tỷ lệ.
//   4) Gắn khung chữ CTA ở vài giây cuối — CHỈ khi anh tự nhập sẵn nội dung CTA (không tự bịa chữ thương hiệu).
// KHÔNG tự làm được (vẫn để lại trong "suggestion" dạng chữ cho nhân sự tự xử lý): phụ đề lời thoại (cần nhận
// diện giọng nói, chưa có), đổi phong cách quay (native/UGC), thêm logo thương hiệu (cần file logo), quay lại
// cảnh mới. Trả về null nếu không có sửa nào áp dụng được (nội dung đã đạt hết các tiêu chí tự sửa được).
function buildAutoEditVideo({ videoPath, workDir, duration, dims, rubric, hookRecutSec, hookNeedsFix, ctaText }) {
  return new Promise((resolve, reject) => {
    const applied = [];

    // 1) Cắt bỏ đoạn mở đầu yếu.
    let startSec = 0;
    if (hookNeedsFix && typeof hookRecutSec === 'number' && !isNaN(hookRecutSec) && hookRecutSec > 1 && hookRecutSec < duration - 1) {
      startSec = hookRecutSec;
      applied.push(`Cắt bỏ ~${Math.round(startSec)} giây mở đầu yếu, video giờ bắt đầu từ đoạn mạnh hơn (theo đề xuất chấm điểm tiêu chí Hook).`);
    }

    // 2) Cắt bớt thời lượng nếu vượt khung khuyến nghị.
    const remaining = duration - startSec;
    let clipDuration = remaining;
    if (rubric.targetDurationRange) {
      const [min, max] = rubric.targetDurationRange;
      if (remaining > max) {
        clipDuration = max;
        applied.push(`Cắt bớt còn ${max} giây cho đúng khung thời lượng khuyến nghị của nền tảng (${min}-${max} giây).`);
      }
    }
    if (clipDuration < 1) { resolve(null); return; }

    // 3) Tự crop lại đúng tỷ lệ dọc 9:16 nếu video gốc sai tỷ lệ.
    const vfParts = [];
    if (rubric.targetAspectRatio === '9:16' && dims && dims.width && dims.height) {
      const currentRatio = dims.width / dims.height;
      const targetRatio = 9 / 16;
      if (Math.abs(currentRatio - targetRatio) > 0.05) {
        // Lưu ý cú pháp: dấu phẩy TRONG biểu thức min(...) phải escape bằng "\," (khác dấu phẩy NGOÀI dùng để
        // nối chuỗi các filter với nhau) — đã kiểm tra thực tế bằng ffmpeg, không bọc nháy đơn quanh biểu thức.
        vfParts.push('crop=min(iw\\,ih*9/16):min(ih\\,iw*16/9)', 'scale=1080:1920');
        applied.push(`Tự crop lại khung hình về đúng tỷ lệ dọc 9:16 (video gốc đang tỷ lệ ${dims.width}x${dims.height}, không đúng chuẩn).`);
      }
    }

    // 4) Gắn khung chữ CTA cuối video — CHỈ khi có sẵn nội dung CTA do người dùng tự nhập.
    if (ctaText && String(ctaText).trim()) {
      const rawText = String(ctaText).trim().slice(0, 40);
      // Escape ký tự đặc biệt cho cú pháp filter ffmpeg (dấu ':' và '\' phải escape, dấu ''' bọc riêng).
      const safeText = rawText.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");
      // Cỡ chữ tự co theo độ dài chữ để không tràn khung hình dọc 1080px — công thức hiệu chỉnh thực tế bằng ffmpeg (xem test).
      const fontSize = Math.max(28, Math.min(56, Math.round(950 / (0.66 * Math.max(rawText.length, 1)))));
      const ctaStart = Math.max(0, clipDuration - 3);
      vfParts.push(`drawtext=text='${safeText}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h-th-100:enable='gte(t\\,${ctaStart.toFixed(1)})'`);
      applied.push(`Gắn khung chữ CTA "${rawText}" ở ${Math.round(clipDuration - ctaStart)} giây cuối video.`);
    }

    if (!applied.length) { resolve(null); return; } // không có sửa cơ học nào áp dụng được — nội dung đã đạt các tiêu chí tự sửa được

    const outPath = path.join(workDir, 'auto-edit.mp4');
    const outputOptions = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
    if (vfParts.length) outputOptions.unshift('-vf', vfParts.join(','));

    ffmpeg(videoPath)
      .setStartTime(startSec)
      .duration(clipDuration)
      .outputOptions(outputOptions)
      .on('end', async () => {
        try {
          const stat = await fsp.stat(outPath);
          if (stat.size > 15 * 1024 * 1024) {
            // outPath vẫn giữ lại (KHÔNG null) dù không trả dataUrl — để bước chấm lại điểm bên dưới (rescoreAutoEditedVideo)
            // vẫn đọc được file thật này, chỉ là không gửi nguyên video nặng về cho trình duyệt.
            resolve({ dataUrl: null, appliedFixes: applied, outPath, note: 'Video sau khi tự sửa quá nặng (>15MB) để xem trực tiếp trong tool — dùng phần mềm dựng video thông thường để áp dụng các sửa liệt kê ở trên thay vì tải trực tiếp bản này.' });
            return;
          }
          const buf = await fsp.readFile(outPath);
          resolve({
            dataUrl: `data:video/mp4;base64,${buf.toString('base64')}`,
            appliedFixes: applied,
            outPath,
            startSec: Math.round(startSec),
            durationSec: Math.round(clipDuration),
          });
        } catch (e) { reject(e); }
      })
      .on('error', (err) => reject(err))
      .save(outPath);
  });
}

// Sau khi tự dựng lại video (buildAutoEditVideo), CHẤM LẠI ĐIỂM chính bản video đã sửa đó — để trả lời thẳng câu
// hỏi "sửa xong thì điểm có thật sự cao hơn không", không chỉ liệt kê đã sửa gì rồi để nhân sự tự đoán. Cắt lại
// khung hình TỪ CHÍNH file đã sửa (outPath), chấm lại y hệt quy trình chấm chính (cùng buildPrompt, cùng rubric),
// rồi trả về điểm mới để tool hiện "Điểm trước → Điểm sau khi tự sửa". Best-effort — lỗi ở đây KHÔNG được làm
// hỏng phần "đã tự sửa gì" đã có sẵn (nhân sự vẫn dùng được video đã sửa dù không chấm lại được).
async function rescoreAutoEditedVideo({ outPath, rubric, platform, objective, variant, topic }) {
  const rescoreDir = path.join(path.dirname(outPath), 'rescore');
  await fsp.mkdir(rescoreDir, { recursive: true });
  const newDuration = await ffprobeDuration(outPath);
  if (!newDuration) return null;
  const { frames: frameList, duration } = await extractFramesForVideo(outPath, rescoreDir);
  if (!frameList.length) return null;
  const imageBuffers = await Promise.all(frameList.map(async (f) => ({ buf: await fsp.readFile(f.path), mediaType: 'image/jpeg' })));
  const labeled = labelFramesForVideo(frameList, duration);
  const frameMeta = frameList.map((f, i) => ({ label: (labeled[i] && labeled[i].label) || `Khung hình ${i + 1}`, timestampSec: f.timestampSec }));
  const prompt = buildPrompt({ platform, objective, variant, topic, frameCount: imageBuffers.length, frameMeta, duration });
  const content = [
    { type: 'text', text: prompt },
    ...imageBuffers.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.buf.toString('base64') } })),
  ];
  // max_tokens: 3072 — xem ghi chú ở lần gọi Claude chấm chính bên dưới (buildPrompt giờ đòi hỏi "note"/"suggestion"
  // chi tiết + cụ thể hơn, dài hơn hẳn bản trước, 2048 hay bị cắt cụt giữa chừng).
  const message = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 3072, messages: [{ role: 'user', content }] });
  const textOut = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const jsonMatch = textOut.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]);
  if (parsed && Array.isArray(parsed.criteria)) {
    parsed.criteria = parsed.criteria.map((c) => ({ ...c, label: rubric.criteria[(Number(c.index) || 1) - 1] || `Tiêu chí ${c.index}` }));
  }
  return parsed;
}

// Gọi Claude kèm công cụ tìm kiếm web (best-effort) để tìm 1-2 quảng cáo THẬT cùng ngành có hook tốt, tham khảo
// cách làm. KHÔNG được để lỗi ở đây làm hỏng cả kết quả chấm điểm chính — mọi lỗi đều bị bắt và trả về mảng rỗng.
async function findHookReferenceExamples({ platform, topic }) {
  try {
    const rubric = CONTENT_SCORING_RUBRIC[platform];
    const searchPrompt = `Tìm 1-2 quảng cáo THẬT đang chạy hoặc từng chạy trên nền tảng tương tự ${rubric.label}, cùng ngành/chủ đề "${topic || '(chưa rõ ngành cụ thể — tìm ví dụ hook quảng cáo hiệu quả nói chung, không giới hạn ngành)'}", có đoạn mở đầu (hook) ấn tượng, thu hút ngay trong vài giây đầu.

Với MỖI ví dụ tìm được, trả về NGẮN GỌN: tên nhãn hàng/nguồn, link (nếu tìm được link thật), và 1 câu giải thích NGẮN vì sao hook của họ hiệu quả — dùng để THAM KHẢO cách làm, không phải để copy nguyên văn. TUYỆT ĐỐI không bịa link hay tên nhãn hàng không có thật — nếu không tìm được ví dụ đáng tin cậy, trả về mảng rỗng.

Trả lời DUY NHẤT bằng JSON hợp lệ, không thêm chữ nào khác:
{"examples": [{"source":"<tên nhãn hàng/nguồn>","url":"<link thật hoặc chuỗi rỗng nếu không có>","note":"<vì sao hook hiệu quả, 1 câu>"}]}`;

    const payload = {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: searchPrompt }],
    };
    const client = (anthropic.beta && anthropic.beta.messages && typeof anthropic.beta.messages.create === 'function')
      ? anthropic.beta.messages
      : anthropic.messages;
    const msg = await client.create(payload);
    const textOut = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.examples) ? parsed.examples.filter((e) => e && (e.source || e.url)).slice(0, 2) : [];
  } catch (e) {
    console.error('Lỗi tìm ví dụ hook tham khảo (bỏ qua, không chặn kết quả chấm điểm chính):', e.message);
    return [];
  }
}

app.post('/analyze', async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, error: 'Server chưa cấu hình ANTHROPIC_API_KEY.' });

  const { link, platform, objective, variant, topic, ctaText } = req.body || {};
  if (!link || !platform || !CONTENT_SCORING_RUBRIC[platform]) {
    return res.status(400).json({ ok: false, error: 'Thiếu link hoặc nền tảng không hợp lệ.' });
  }
  const rubric = CONTENT_SCORING_RUBRIC[platform];

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scoring-'));
  try {
    const directUrl = resolveDirectUrl(link);
    const rawPath = path.join(workDir, 'raw-input');
    const { contentType } = await downloadToTemp(directUrl, rawPath);

    let imageBuffers = [];
    let frameMeta = []; // [{label, timestampSec?}] — cùng thứ tự với imageBuffers, dùng để hiện lại khung hình cho người xem
    let videoPath = null; // chỉ khác null khi nội dung là VIDEO — cần giữ lại để cắt demo hook bên dưới (Bước sau khi Claude chấm xong)
    let duration = null;
    let dims = null; // {width, height} — chỉ đọc khi là video, dùng để biết có cần tự crop lại tỷ lệ khung hình hay không
    if (contentType.startsWith('image/')) {
      imageBuffers = [{ buf: await fsp.readFile(rawPath), mediaType: contentType.includes('png') ? 'image/png' : 'image/jpeg' }];
      frameMeta = [{ label: 'Ảnh nội dung nháp' }];
    } else {
      // Coi như video — đổi tên có phần mở rộng để ffmpeg nhận diện đúng, rồi cắt frame.
      videoPath = rawPath + '.mp4';
      await fsp.rename(rawPath, videoPath);
      const extracted = await extractFramesForVideo(videoPath, workDir);
      const frameList = extracted.frames;
      duration = extracted.duration;
      if (!frameList.length) throw new Error('Không cắt được khung hình nào từ video — file có thể bị hỏng hoặc không đúng định dạng video.');
      imageBuffers = await Promise.all(frameList.map(async (f) => ({ buf: await fsp.readFile(f.path), mediaType: 'image/jpeg' })));
      const labeled = labelFramesForVideo(frameList, duration);
      // Gộp timestampSec (từ frameList) vào frameMeta (label) — buildPrompt cần cả hai để chỉ đích danh thời điểm cho Claude.
      frameMeta = frameList.map((f, i) => ({ label: (labeled[i] && labeled[i].label) || `Khung hình ${i + 1}`, timestampSec: f.timestampSec }));
      dims = await ffprobeDimensions(videoPath);
    }

    const prompt = buildPrompt({ platform, objective, variant, topic, frameCount: imageBuffers.length, frameMeta, duration });
    const content = [
      { type: 'text', text: prompt },
      ...imageBuffers.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.buf.toString('base64') } })),
    ];

    // max_tokens: 3072 — TĂNG tiếp từ 2048 vì buildPrompt giờ đòi hỏi "note"/"suggestion" chi tiết, cụ thể, neo
    // vào chi tiết thật + ghi rõ hậu kỳ hay cần quay lại (yêu cầu chất lượng mới) — dài hơn hẳn bản trước, 2048
    // vẫn còn bị cắt cụt giữa chừng làm JSON không đủ dấu đóng ngoặc → lỗi "không đúng định dạng JSON mong đợi"
    // dù Claude chấm đúng, chỉ là bị cụt. (Lịch sử: 1024 → 2048 → 3072, mỗi lần tăng do prompt đòi hỏi output
    // chi tiết hơn ở lần đó.)
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 3072,
      messages: [{ role: 'user', content }],
    });

    const textOut = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    let parsed;
    try {
      const jsonMatch = textOut.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textOut);
    } catch (e) {
      // Nếu bị cắt cụt do hết max_tokens, nói rõ ra thay vì chỉ báo "sai định dạng" chung chung — giúp biết ngay
      // cần tăng max_tokens tiếp hay đây là lỗi khác (Claude tự ý thêm chữ ngoài JSON).
      const truncated = message.stop_reason === 'max_tokens';
      const errMsg = truncated
        ? 'Claude trả lời bị cắt cụt giữa chừng (hết giới hạn token) nên JSON không đầy đủ. Thử bấm "🤖 Phân tích ngay" lại — nếu vẫn lỗi này, cần tăng max_tokens trong server.js.'
        : 'Claude trả về không đúng định dạng JSON mong đợi.';
      return res.status(502).json({ ok: false, error: errMsg, raw: textOut, stopReason: message.stop_reason });
    }

    // Gắn thêm "label" (tên tiêu chí thật, đọc từ rubric) vào từng dòng điểm Claude trả về — Claude chỉ trả
    // {index, score10, note, suggestion}, tool cần tên tiêu chí đầy đủ để hiện bảng chi tiết biết ĐÚNG chỗ đang
    // mất điểm. "suggestion" (gợi ý sửa cụ thể) đã có sẵn trong Claude trả về nên tự đi theo qua "...c".
    if (parsed && Array.isArray(parsed.criteria)) {
      parsed.criteria = parsed.criteria.map((c) => ({
        ...c,
        label: rubric.criteria[(Number(c.index) || 1) - 1] || `Tiêu chí ${c.index}`,
      }));
    }

    // Trả lại chính các khung hình đã gửi cho Claude chấm (dạng data URL, đủ nhỏ vì đã resize 640px lúc cắt) —
    // để tool hiện lại đúng những gì Claude đã "nhìn thấy", đối chiếu trực tiếp với điểm/nhận xét từng tiêu chí.
    const frames = imageBuffers.map((im, i) => ({
      label: (frameMeta[i] && frameMeta[i].label) || `Khung hình ${i + 1}`,
      dataUrl: `data:${im.mediaType};base64,${im.buf.toString('base64')}`,
    }));

    // Nếu tiêu chí Hook bị điểm thấp (<8/10) VÀ đây là video: (A) tự cắt 1 đoạn demo NGẮN từ chính video gốc,
    // bắt đầu ở thời điểm Claude đề xuất, để xem thử hướng mở đầu mới; (B) tìm 1-2 ví dụ quảng cáo THẬT cùng
    // ngành có hook tốt để tham khảo cách làm. Cả 2 đều best-effort — lỗi ở đây KHÔNG được làm hỏng kết quả
    // chấm điểm chính đã có ở trên.
    let hookDemo = null;
    let hookReferenceExamples = [];
    const hookIdx = rubric.hookCriterionIndex || 1;
    const hookCriterion = parsed && Array.isArray(parsed.criteria) ? parsed.criteria.find((c) => Number(c.index) === hookIdx) : null;
    if (videoPath && duration && hookCriterion) {
      const hookScore = Number(hookCriterion.score10);
      const recutSec = Number(hookCriterion.hookRecutSec);
      const needsFix = !isNaN(hookScore) && hookScore < 8;
      if (needsFix) {
        if (!isNaN(recutSec) && recutSec > 1 && recutSec < duration - 1) {
          try {
            hookDemo = await cutHookDemoClip(videoPath, workDir, recutSec, duration);
          } catch (e) {
            console.error('Lỗi cắt demo hook (bỏ qua, không chặn kết quả chấm điểm chính):', e.message);
          }
        }
        hookReferenceExamples = await findHookReferenceExamples({ platform, topic });
      }
    }

    // Tự dựng lại 1 BẢN VIDEO HOÀN CHỈNH áp dụng các sửa cơ học làm được chắc chắn (cắt mở đầu yếu, cắt bớt thời
    // lượng, crop lại tỷ lệ khung hình, gắn CTA nếu có) — xem chi tiết phạm vi/giới hạn ở buildAutoEditVideo().
    // Best-effort, KHÔNG được làm hỏng kết quả chấm điểm chính đã có ở trên.
    let autoEditVideo = null;
    if (videoPath && duration) {
      try {
        const hookNeedsFix = !!(hookCriterion && !isNaN(Number(hookCriterion.score10)) && Number(hookCriterion.score10) < 8);
        autoEditVideo = await buildAutoEditVideo({
          videoPath,
          workDir,
          duration,
          dims,
          rubric,
          hookRecutSec: hookCriterion ? Number(hookCriterion.hookRecutSec) : NaN,
          hookNeedsFix,
          ctaText,
        });
      } catch (e) {
        console.error('Lỗi tự dựng video (bỏ qua, không chặn kết quả chấm điểm chính):', e.message);
      }

      // Chấm lại điểm CHÍNH bản video đã tự sửa — trả lời thẳng "sửa xong điểm có cao hơn không", không chỉ liệt
      // kê đã sửa gì. Best-effort: lỗi ở đây không mất phần "đã tự sửa gì" đã có, chỉ là không có điểm so sánh.
      if (autoEditVideo && autoEditVideo.outPath) {
        try {
          const rescoredResult = await rescoreAutoEditedVideo({ outPath: autoEditVideo.outPath, rubric, platform, objective, variant, topic });
          if (rescoredResult) {
            autoEditVideo.rescoredResult = rescoredResult;
            autoEditVideo.scoreBefore = typeof parsed.totalScore100 === 'number' ? parsed.totalScore100 : null;
          }
        } catch (e) {
          console.error('Lỗi chấm lại điểm video đã tự sửa (bỏ qua, video đã sửa vẫn dùng được bình thường):', e.message);
        }
        delete autoEditVideo.outPath; // đường dẫn file trên server — không trả về cho trình duyệt
      }
    }

    return res.json({ ok: true, result: parsed, framesAnalyzed: imageBuffers.length, frames, hookDemo, hookReferenceExamples, autoEditVideo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Lỗi không xác định.' });
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ================= DỮ LIỆU FACEBOOK TRỰC TIẾP (live) TỪ WINDSOR.AI =================
// Đây là điều tool tĩnh (chỉ HTML/JS chạy trong trình duyệt) không tự làm được — gọi thẳng Windsor.ai từ trình
// duyệt sẽ lộ WINDSOR_API_KEY cho bất kỳ ai mở file. Server này giữ key, gọi hộ, trả về đúng dạng dữ liệu
// tool cần (đã gộp tên "Tài khoản — Chiến dịch" sẵn) để tool chỉ việc hiển thị, không cần biết gì về Windsor.ai.
function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

app.get('/facebook-daily', async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!WINDSOR_API_KEY) return res.status(500).json({ ok: false, error: 'Server chưa cấu hình WINDSOR_API_KEY.' });

  const dateFrom = isoDateNDaysAgo(WINDSOR_LOOKBACK_DAYS);
  const dateTo = isoDateNDaysAgo(0);
  const url = `${WINDSOR_BASE}/facebook?api_key=${encodeURIComponent(WINDSOR_API_KEY)}&fields=${encodeURIComponent(WINDSOR_FIELDS)}&date_from=${dateFrom}&date_to=${dateTo}`;

  try {
    const wres = await fetch(url);
    if (!wres.ok) {
      const bodyText = await wres.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Windsor.ai trả lỗi HTTP ${wres.status}. Kiểm tra lại WINDSOR_API_KEY trên Render còn đúng/còn hiệu lực không.`, detail: bodyText.slice(0, 500) });
    }
    const json = await wres.json();
    const rawRows = json.data || json.result || (Array.isArray(json) ? json : []);
    if (!Array.isArray(rawRows)) {
      return res.status(502).json({ ok: false, error: 'Windsor.ai trả về dữ liệu không đúng định dạng mong đợi.' });
    }
    const rows = rawRows
      .filter((r) => r && r.date && r.campaign)
      .map((r) => ({
        n: `${r.account_name || 'Không rõ tài khoản'} — ${r.campaign}`,
        d: String(r.date).slice(0, 10),
        s: Math.round(Number(r.spend) || 0),
        m: Math.round(Number(r.actions_onsite_conversion_messaging_conversation_started_7d) || 0),
        c: Math.round(Number(r.actions_comment) || 0),
      }));
    return res.json({ ok: true, rows, fetchedAt: new Date().toISOString(), dateFrom, dateTo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Lỗi không xác định khi gọi Windsor.ai.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Content scoring backend đang chạy ở cổng ${PORT}`));
