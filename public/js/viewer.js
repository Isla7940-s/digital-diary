// 全屏查看器：图片缩放、视频/录音播放、文字阅读、信息面板与操作
import { $, api, esc, ICON, KIND_LABEL, fmtDay, fmtTime, fmtSize, fmtDur, weekday, waveSvg, emit, toast, confirmSheet } from "./lib.js";
import { pickEntryDialog } from "./dialogs.js";

const root = () => $("#viewer");
let state = null;

const prefInfo = () => { try { return localStorage.getItem("viewer.info") !== "0"; } catch { return true; } };
const savePrefInfo = (v) => { try { localStorage.setItem("viewer.info", v ? "1" : "0"); } catch { /* 无痕模式 */ } };

/** @param {any[]} items @param {string} id @param {{ onChanged?: ()=>void }} opts */
export function openViewer(items, id, opts = {}) {
  state = { items: [...items], i: Math.max(0, items.findIndex((x) => x.id === id)), info: innerWidth > 860 && prefInfo(), opts };
  document.body.style.overflow = "hidden";
  root().hidden = false;
  render();
}

export function closeViewer() {
  if (!state) return;
  root().innerHTML = "";
  root().hidden = true;
  document.body.style.overflow = "";
  state = null;
}

function stageHtml(a) {
  if (a.kind === "image") return `<img src="/files/${a.id}" alt="" draggable="false">`;
  if (a.kind === "video") return `<video src="/files/${a.id}" controls autoplay playsinline></video>`;
  if (a.kind === "audio") return `<div class="audio-stage"><div class="disc">${waveSvg(a.id, 36)}</div>
    <div class="an">${esc(a.caption || a.original_name)}</div><audio src="/files/${a.id}" controls autoplay></audio></div>`;
  if (a.kind === "text") return `<pre>加载中…</pre>`;
  return `<div class="audio-stage"><div class="disc" style="color:var(--accent-ink)">${ICON.file}</div><div class="an">${esc(a.original_name)}</div>
    <a class="btn primary" href="/files/${a.id}" target="_blank">打开文件</a></div>`;
}

function infoHtml(a) {
  const dims = a.width && a.height ? `${a.width} × ${a.height}` : "";
  return `<div class="info">
    <h3>信息</h3>
    <label class="field">说明<input type="text" id="vCaption" value="${esc(a.caption)}" placeholder="添加说明…"></label>
    <dl>
      <dt>拍摄</dt><dd>${fmtDay(a.taken_at)} ${weekday(a.taken_at)} ${fmtTime(a.taken_at)}</dd>
      <dt>类型</dt><dd>${KIND_LABEL[a.kind]}${a.entry_id ? ` · ${a.role === "page" ? "纸质原稿" : "富媒体"}` : ""}</dd>
      <dt>日记</dt><dd>${a.entry_id ? `<a class="idpill" href="#/e/${esc(a.entry_id)}">${esc(a.entry_id)}</a>` : `<span class="muted">未归组</span>`}</dd>
      <dt>文件</dt><dd>${esc(a.original_name)}</dd>
      <dt>大小</dt><dd>${fmtSize(a.size)}${dims ? ` · ${dims}` : ""}${a.duration ? ` · ${fmtDur(a.duration)}` : ""}</dd>
    </dl>
    <div class="acts">
      <button class="btn sm" data-act="assign">${ICON.link}${a.entry_id ? "移到其他日记" : "加入日记"}</button>
      ${a.entry_id ? `<button class="btn sm" data-act="unassign">${ICON.unlink}移出日记</button>` : ""}
      <a class="btn sm" href="/files/${a.id}?download=1">${ICON.dl}下载原件</a>
      <button class="btn sm danger" data-act="trash">${ICON.trash}删除</button>
    </div>
  </div>`;
}

function render() {
  const { items, i, info } = state;
  const a = items[i];
  if (!a) return closeViewer();
  const el = root();
  el.innerHTML = `<div class="stage">
      <div class="vtop">
        <button class="vbtn" data-act="close" aria-label="关闭">${ICON.close}</button>
        <div class="vt"><b>${fmtDay(a.taken_at)} ${fmtTime(a.taken_at)}</b><span>${esc(a.original_name)}${a.entry_id ? ` · ${esc(a.entry_id)}` : ""}</span></div>
        <a class="vbtn" href="/files/${a.id}?download=1" aria-label="下载">${ICON.dl}</a>
        <button class="vbtn ${info ? "on" : ""}" data-act="info" aria-label="信息">${ICON.info}</button>
      </div>
      ${items.length > 1 ? `<button class="vbtn nav prev" data-act="prev" aria-label="上一个">${ICON.back}</button><button class="vbtn nav next" data-act="next" aria-label="下一个">${ICON.next}</button>` : ""}
      ${stageHtml(a)}
      <span class="vcount">${i + 1} / ${items.length}</span>
    </div>${info ? infoHtml(a) : ""}`;

  if (a.kind === "text") fetch(`/files/${a.id}`).then((r) => r.text()).then((t) => { if (state?.items[state.i] === a) $(".stage pre", el).textContent = t; });
  const img = $(".stage > img", el);
  img?.addEventListener("click", () => {
    const st = $(".stage", el);
    st.classList.toggle("zoomed");
    if (st.classList.contains("zoomed")) st.scrollTo((img.scrollWidth - st.clientWidth) / 2, (img.scrollHeight - st.clientHeight) / 2);
  });
  $("#vCaption", el)?.addEventListener("change", async (e) => {
    await api(`/media/${a.id}`, { method: "PATCH", body: { caption: e.target.value } });
    a.caption = e.target.value;
    toast("说明已保存");
    state.opts.onChanged?.();
  });
}

const step = (d) => { if (state.items.length > 1) { state.i = (state.i + d + state.items.length) % state.items.length; render(); } };

async function act(name) {
  const a = state.items[state.i];
  if (name === "close") return closeViewer();
  if (name === "prev") return step(-1);
  if (name === "next") return step(1);
  if (name === "info") { state.info = !state.info; savePrefInfo(state.info); return render(); }
  if (name === "assign") {
    const r = await pickEntryDialog({ title: a.entry_id ? "移到其他日记" : "加入日记", exclude: a.entry_id, defaultRole: a.role });
    if (!r) return;
    await api("/media/assign", { method: "POST", body: { ids: [a.id], entry_id: r.id, role: r.role } });
    Object.assign(a, { entry_id: r.id, role: r.role });
    toast(`已加入 ${r.id}`);
  } else if (name === "unassign") {
    await api("/media/unassign", { method: "POST", body: { ids: [a.id] } });
    Object.assign(a, { entry_id: null, role: "media" });
    toast("已移出日记");
  } else if (name === "trash") {
    if (!(await confirmSheet("删除这个文件？", "文件会移入回收站，可以随时恢复。", "移入回收站", true))) return;
    await api("/media/trash", { method: "POST", body: { ids: [a.id] } });
    state.items.splice(state.i, 1);
    if (state.i >= state.items.length) state.i = state.items.length - 1;
    toast("已移入回收站");
  } else return;
  emit("data-changed");
  state.opts.onChanged?.();
  state.items.length ? render() : closeViewer();
}

// 事件只绑定一次
document.addEventListener("click", (e) => {
  if (!state) return;
  const b = e.target.closest("#viewer [data-act]");
  if (b) act(b.dataset.act);
});
document.addEventListener("keydown", (e) => {
  if (!state || e.target.matches("input, textarea") || $("#sheetRoot").children.length) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "i") act("info");
});
let tx = null, ty = null;
addEventListener("touchstart", (e) => { if (state) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }, { passive: true });
addEventListener("touchend", (e) => {
  if (!state || tx === null || e.target.closest(".info, video, audio, .zoomed")) return;
  const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx > 0 ? -1 : 1);
  else if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 2) closeViewer();
  tx = null;
});
