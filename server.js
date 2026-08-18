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
  return `Bạn đang xem ${item.frameCount > 1 ? `${item.frameCount} khung hình tĩnh cắt ra từ 1 video quảng cáo NHÁP (đầu/giữa/cuối video, KHÔNG phải toàn bộ chuyển động/âm thanh thật)` : '1 hình ảnh nội dung quảng cáo NHÁP'}. Chấm điểm nội dung này theo đúng tiêu chí thuật toán ${rubric.label}.

Mục tiêu quảng cáo: ${item.objective || 'Tin nhắn/Nhắn tin'}
Nội dung mới hay biến thể: ${item.variant || 'Mới hoàn toàn'}

Chấm theo từng tiêu chí sau (mỗi tiêu chí 0–10 điểm, dựa trên các khung hình đang thấy — nếu tiêu chí liên quan tới chuyển động/âm thanh mà không đánh giá chắc chắn được từ ảnh tĩnh, hãy chấm điểm trung bình 5-6 và ghi rõ trong "note" là "không đánh giá được đầy đủ từ khung hình tĩnh"):
${rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Với MỖI tiêu chí, ngoài "note" (giải thích NGẮN vì sao được điểm đó, dựa trên những gì thấy trong khung hình), bắt buộc có thêm "suggestion" — một gợi ý sửa CỤ THỂ, hành động được ngay (VD: "Thêm phụ đề tiếng Việt cỡ chữ lớn ở nửa dưới khung hình", "Cắt bỏ 2 giây đầu đang đứng yên, mở đầu ngay bằng cảnh cận sản phẩm"), không chấm chung chung "làm tốt hơn". Nếu tiêu chí đã đạt điểm cao (≥8/10), "suggestion" có thể ghi ngắn gọn "Đã tốt, giữ nguyên".

Trả lời DUY NHẤT bằng JSON hợp lệ theo đúng cấu trúc sau, không thêm chữ nào khác ngoài JSON:
{"totalScore100": <số nguyên 0-100, = trung bình cộng 6 điểm tiêu chí x10>, "criteria": [{"index":1,"score10":<0-10>,"note":"<nhận xét ngắn>","suggestion":"<gợi ý sửa cụ thể, hành động được ngay>"}, ... đủ 6 mục], "recommendation": "<1-2 câu nên sửa gì trước khi chạy quảng cáo, hoặc \\"Đủ điều kiện chạy\\" nếu tốt>"}`;
}

app.post('/analyze', async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, error: 'Server chưa cấu hình ANTHROPIC_API_KEY.' });

  const { link, platform, objective, variant } = req.body || {};
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
    let frameMeta = []; // [{label}] — cùng thứ tự với imageBuffers, dùng để hiện lại khung hình cho người xem
    if (contentType.startsWith('image/')) {
      imageBuffers = [{ buf: await fsp.readFile(rawPath), mediaType: contentType.includes('png') ? 'image/png' : 'image/jpeg' }];
      frameMeta = [{ label: 'Ảnh nội dung nháp' }];
    } else {
      // Coi như video — đổi tên có phần mở rộng để ffmpeg nhận diện đúng, rồi cắt frame.
      const videoPath = rawPath + '.mp4';
      await fsp.rename(rawPath, videoPath);
      const { frames: frameList, duration } = await extractFramesForVideo(videoPath, workDir);
      if (!frameList.length) throw new Error('Không cắt được khung hình nào từ video — file có thể bị hỏng hoặc không đúng định dạng video.');
      imageBuffers = await Promise.all(frameList.map(async (f) => ({ buf: await fsp.readFile(f.path), mediaType: 'image/jpeg' })));
      frameMeta = labelFramesForVideo(frameList, duration);
    }

    const prompt = buildPrompt({ platform, objective, variant, frameCount: imageBuffers.length });
    const content = [
      { type: 'text', text: prompt },
      ...imageBuffers.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.buf.toString('base64') } })),
    ];

    // max_tokens: 2048 — TĂNG từ 1024 vì mỗi tiêu chí giờ có thêm "suggestion" (gợi ý sửa cụ thể) bên cạnh
    // "note", gần như gấp đôi lượng chữ Claude cần trả về cho 6 tiêu chí; 1024 hay bị cắt giữa chừng làm JSON
    // trả về không đủ dấu đóng ngoặc → lỗi "không đúng định dạng JSON mong đợi" dù Claude chấm đúng, chỉ là bị cụt.
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
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

    return res.json({ ok: true, result: parsed, framesAnalyzed: imageBuffers.length, frames });
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
