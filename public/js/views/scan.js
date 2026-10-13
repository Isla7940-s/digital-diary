// 扫码 / 输入编号：打开纸质日记对应的数字内容
import { $, ICON, toast, extractId } from "../lib.js";

async function decodeImage(bitmap) {
  if ("BarcodeDetector" in window) {
    try { const r = await new window.BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap); if (r[0]) return r[0].rawValue; } catch { /* 回退 jsQR */ }
  }
  if (!window.jsQR) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  for (const max of [800, 1200, 1800, 400]) {
    const s = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * s); canvas.height = Math.round(bitmap.height * s);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = window.jsQR(img.data, img.width, img.height);
    if (r) return r.data;
  }
  return null;
}

export async function render({ app }) {
  const canCamera = window.isSecureContext && navigator.mediaDevices?.getUserMedia;
  app.innerHTML = `
    <div class="page-head"><div><h1>扫码</h1><div class="sub">扫描纸质日记上的二维码，或直接输入编号</div></div></div>
    <div class="narrow">
      <section class="card">
        <form class="id-form" id="idForm">
          <input type="text" id="idInput" placeholder="261013-1" autocomplete="off" inputmode="text" autofocus>
          <button class="btn primary">打开</button>
        </form>
      </section>
      <section class="card">
        ${canCamera ? `<div class="viewfinder"><video id="video" playsinline muted></video></div>
          <p class="muted" id="scanHint" style="margin-top:10px;font-size:13px">把二维码对准取景框</p>`
        : `<p class="muted" style="font-size:13px;line-height:1.7">当前通过 http 访问，浏览器不允许直接打开摄像头。可以用「拍照识别」，效果相同；配置 https 后可使用实时扫码。</p>`}
        <label class="btn" style="margin-top:12px">${ICON.image}拍照 / 选图识别<input type="file" id="photo" accept="image/*" capture="environment" hidden></label>
      </section>
    </div>`;

  const go = (raw) => {
    const id = extractId(raw);
    if (!id) { toast(`无法识别编号：${String(raw).slice(0, 40)}`); return false; }
    location.hash = `#/e/${id}`;
    return true;
  };
  $("#idForm").addEventListener("submit", (e) => { e.preventDefault(); go($("#idInput").value); });
  $("#photo").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await decodeImage(await createImageBitmap(f));
    text ? go(text) : toast("没有在图片中找到二维码，请靠近一些重拍");
    e.target.value = "";
  });
  if (!canCamera) return;

  let stream, stopped = false;
  const stop = () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    if (stopped) { stop(); return stop; }
    const video = $("#video");
    video.srcObject = stream;
    await video.play();
    const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (stopped) return;
      let text = null;
      try {
        if (detector) text = (await detector.detect(video))[0]?.rawValue ?? null;
        else if (video.videoWidth && window.jsQR) {
          const s = Math.min(1, 640 / video.videoWidth);
          canvas.width = video.videoWidth * s; canvas.height = video.videoHeight * s;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
        }
      } catch { /* 单帧失败忽略 */ }
      if (text && go(text)) return;
      setTimeout(tick, 150);
    };
    tick();
  } catch (err) {
    const hint = $("#scanHint");
    if (hint) hint.textContent = `无法打开摄像头：${err.message}。可以改用拍照识别。`;
  }
  return stop;
}
