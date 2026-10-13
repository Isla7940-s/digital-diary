// 上传队列：右下角进度面板，逐个上传，完成后广播 uploaded 事件
import { $, esc, fmtSize, emit, ICON } from "./lib.js";

const panel = () => $("#uploadPanel");
let queue = [], running = false, hideTimer;

function render() {
  const done = queue.filter((q) => q.state === "done").length;
  const err = queue.filter((q) => q.state === "error").length;
  const active = queue.length - done - err;
  const p = panel();
  p.hidden = !queue.length;
  p.innerHTML = `<div class="uh"><span>${active ? `正在上传 ${done + err + 1}/${queue.length}` : `上传完成 ${done} 个${err ? `，失败 ${err} 个` : ""}`}</span>
    <button class="icon-btn" data-x aria-label="关闭">${ICON.close}</button></div>
    <div class="ul">${queue.map((q) => `<div class="ur"><span class="nm">${esc(q.file.name)}</span>
      <span class="st ${q.state === "error" ? "err" : q.state === "done" ? "done" : ""}">${q.state === "error" ? esc(q.error) : q.state === "done" ? "完成" : q.state === "up" ? `${Math.round(q.p * 100)}%` : fmtSize(q.file.size)}</span>
      ${q.state === "up" || q.state === "wait" ? `<span class="bar"><i style="width:${Math.round(q.p * 100)}%"></i></span>` : ""}</div>`).join("")}</div>`;
  $("[data-x]", p).onclick = () => { if (!active) { queue = []; render(); } else p.hidden = true; };
}

function send(q) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    if (q.entryId) fd.append("entry_id", q.entryId);
    if (q.role) fd.append("role", q.role);
    fd.append("lastModified", String(q.file.lastModified || ""));
    fd.append("files", q.file, q.file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { q.p = e.loaded / e.total; render(); } };
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      xhr.status < 300 ? resolve(data[0]) : reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(fd);
  });
}

async function run() {
  if (running) return;
  running = true;
  clearTimeout(hideTimer);
  let q;
  while ((q = queue.find((x) => x.state === "wait"))) {
    q.state = "up"; render();
    try {
      q.result = await send(q);
      q.state = "done";
      emit("uploaded", q.result);
    } catch (e) { q.state = "error"; q.error = e.message; }
    render();
    q.resolve(q.result ?? null);
  }
  running = false;
  emit("data-changed");
  if (!queue.some((x) => x.state === "error")) hideTimer = setTimeout(() => { queue = []; render(); }, 3500);
}

/** 上传一批文件；entryId/role 可选。返回成功上传的文件记录 */
export function uploadFiles(files, { entryId, role } = {}) {
  const ps = [...files].map((file) => new Promise((resolve) => queue.push({ file, entryId, role, state: "wait", p: 0, resolve })));
  render();
  run();
  return Promise.all(ps).then((r) => r.filter(Boolean));
}

/** 打开系统文件选择 */
export function pickFiles({ accept = "", multiple = true, capture } = {}) {
  return new Promise((resolve) => {
    const input = $("#globalFile");
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute("capture", capture); else input.removeAttribute("capture");
    input.value = "";
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

/** 全局拖放：拖入窗口即上传，目标由当前页面决定 */
export function installDrop(getTarget) {
  let depth = 0;
  const ov = $("#dropOverlay");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    const t = getTarget();
    $("#dropHint").textContent = t.label;
    ov.hidden = false;
  });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; ov.hidden = true; } });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; ov.hidden = true;
    const t = getTarget();
    if (!e.dataTransfer.files.length) return;
    // 页面可以接管拖入的文件（例如正文编辑器：上传后插入到落点）
    if (t.onFiles) t.onFiles([...e.dataTransfer.files], e);
    else uploadFiles(e.dataTransfer.files, t);
  });
}
