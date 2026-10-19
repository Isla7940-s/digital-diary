// 全屏查看器
// 图片：滚轮 / 双指缩放（以指针为中心）、拖动平移、双击切换「适应 / 原始大小」、旋转；先显示缩略图再换原图，并预加载前后两张
// 切换：← → 键、两侧按钮、底部缩略图条；手机左右滑动跟手切换、下滑关闭、单击隐藏工具栏
// 视频 / 录音 / 文字 / 其他文件照常播放或阅读；右侧（手机为底部）信息面板可改说明、归组、下载、删除
import { $, $$, api, esc, ICON, KIND_LABEL, fmtDay, fmtTime, fmtSize, fmtDur, weekday, waveSvg, emit, toast, confirmSheet, viewUrl } from "./lib.js";
import { pickEntryDialog } from "./dialogs.js";
import { isLive, liveUrl, playLive, LIVE_ICON } from "./live.js";

const root = () => $("#viewer");
let state = null;

const prefInfo = () => { try { return localStorage.getItem("viewer.info") !== "0"; } catch { return true; } };
const savePrefInfo = (v) => { try { localStorage.setItem("viewer.info", v ? "1" : "0"); } catch { /* 无痕模式 */ } };
const mobile = () => innerWidth <= 860;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const I = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICO = {
  zin: I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5"/>'),
  zout: I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5"/>'),
  rot: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
};

/** @param {any[]} items @param {string} id @param {{ onChanged?: ()=>void }} opts */
export function openViewer(items, id, opts = {}) {
  state = {
    items: [...items], i: Math.max(0, items.findIndex((x) => x.id === id)), opts,
    info: !mobile() && prefInfo(), chrome: true,
    z: null,  // 当前图片的缩放状态
  };
  document.body.style.overflow = "hidden";
  root().hidden = false;
  render();
}

export function closeViewer() {
  if (!state) return;
  stopLive = null;
  root().innerHTML = "";
  root().hidden = true;
  root().className = "viewer";
  root().style.removeProperty("--bg-a");  // 下滑关闭时留下的半透明背景
  document.body.style.overflow = "";
  state = null;
}

// ---------- 渲染 ----------

/** 图片铺满屏幕时需要的像素宽度（含屏幕密度） */
function screenPx(a) {
  const ratio = a.width && a.height ? a.width / a.height : 1;
  return Math.ceil(Math.min(innerWidth, innerHeight * ratio) * (devicePixelRatio || 1));
}
/** 当前已加载版本的像素宽度（原图记为无穷大） */
const loadedWidth = (url) => Number(/[?&]w=(\d+)/.exec(url)?.[1]) || Infinity;

function slideHtml(a, current) {
  if (!a) return "";
  if (a.kind === "image") {
    const dims = a.width && a.height ? ` width="${a.width}" height="${a.height}"` : "";
    // 三级加载：缩略图（立即）→ 适合屏幕的浏览版 → 放大超过浏览版清晰度时才取原图
    const full = viewUrl(a, screenPx(a));
    const first = a.thumb ? `/thumbs/${a.id}` : full;
    // 实况照片：视频叠在照片上、跟着照片一起缩放旋转，平时透明
    const live = current && isLive(a) ? `<video class="live-v v-live" src="${liveUrl(a.id)}" muted playsinline preload="auto"></video>` : "";
    return `<img class="${current ? "v-img" : "v-fit"}" src="${first}" data-full="${full}" data-orig="/files/${a.id}"${dims} alt="" draggable="false" decoding="async">${live}`;
  }
  if (!current) {
    // 相邻的非图片只放占位，避免两段视频同时加载
    return a.kind === "video" && a.thumb ? `<img class="v-fit" src="/thumbs/${a.id}" alt="" draggable="false">`
      : `<div class="v-ph">${ICON[a.kind] || ICON.file}<span>${esc(a.caption || a.original_name)}</span></div>`;
  }
  if (a.kind === "video") return `<video src="/files/${a.id}" controls autoplay playsinline${a.thumb ? ` poster="/thumbs/${a.id}"` : ""}></video>`;
  if (a.kind === "audio") return `<div class="audio-stage"><div class="disc">${waveSvg(a.id, 36)}</div>
    <div class="an">${esc(a.caption || a.original_name)}</div><audio src="/files/${a.id}" controls autoplay></audio></div>`;
  if (a.kind === "text") return `<pre class="v-text">加载中…</pre>`;
  return `<div class="audio-stage"><div class="disc" style="color:var(--accent-ink)">${ICON.file}</div><div class="an">${esc(a.original_name)}</div>
    <a class="btn primary" href="/files/${a.id}" target="_blank" rel="noopener">打开文件</a></div>`;
}

function infoHtml(a) {
  const dims = a.width && a.height ? `${a.width} × ${a.height}` : "";
  return `<aside class="v-info">
    <div class="vi-head"><h3>信息</h3><button class="vbtn sm" data-act="info" aria-label="关闭信息">${ICON.close}</button></div>
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
  </aside>`;
}

function stripHtml() {
  const { items, i } = state;
  if (items.length < 2) return "";
  return `<div class="v-strip" id="vStrip">${items.map((a, j) => `<button class="vs-i ${j === i ? "on" : ""}" data-go="${j}" aria-label="第 ${j + 1} 项">
    ${a.thumb ? `<img src="/thumbs/${a.id}" alt="" loading="lazy" draggable="false">` : `<span>${ICON[a.kind] || ICON.file}</span>`}</button>`).join("")}</div>`;
}

function render() {
  const { items, i, info } = state;
  const a = items[i];
  if (!a) return closeViewer();
  const n = items.length;
  const prev = n > 1 ? items[(i - 1 + n) % n] : null, next = n > 1 ? items[(i + 1) % n] : null;
  const el = root();
  el.className = `viewer ${info ? "with-info" : ""} ${state.chrome ? "" : "bare"}`;
  el.innerHTML = `<div class="v-main">
      <header class="v-top">
        <button class="vbtn" data-act="close" aria-label="关闭">${ICON.close}</button>
        <div class="vt"><b>${fmtDay(a.taken_at)} ${fmtTime(a.taken_at)}${n > 1 ? `<em>${i + 1} / ${n}</em>` : ""}</b>
          <span>${esc(a.caption || a.original_name)}${a.entry_id ? ` · ${esc(a.entry_id)}` : ""}</span></div>
        ${a.kind === "image" ? `<div class="v-zoom">
          <button class="vbtn" data-act="zout" aria-label="缩小">${ICO.zout}</button>
          <button class="v-pct" data-act="fit" title="适应屏幕（0）/ 原始大小（1）">100%</button>
          <button class="vbtn" data-act="zin" aria-label="放大">${ICO.zin}</button>
          <button class="vbtn" data-act="rot" aria-label="旋转">${ICO.rot}</button></div>` : ""}
        ${isLive(a) ? `<button class="v-livebtn" data-act="live" title="播放实况（手机上长按照片）">${LIVE_ICON}实况</button>` : ""}
        <a class="vbtn" href="/files/${a.id}?download=1" aria-label="下载">${ICON.dl}</a>
        <button class="vbtn ${info ? "on" : ""}" data-act="info" aria-label="信息">${ICON.info}</button>
      </header>
      <div class="v-stage" id="vStage">
        <div class="v-track" id="vTrack">
          ${prev ? `<div class="v-slide" style="left:-100%">${slideHtml(prev, false)}</div>` : ""}
          <div class="v-slide cur">${slideHtml(a, true)}</div>
          ${next ? `<div class="v-slide" style="left:100%">${slideHtml(next, false)}</div>` : ""}
        </div>
        ${n > 1 ? `<button class="vbtn nav prev" data-act="prev" aria-label="上一个">${ICON.back}</button><button class="vbtn nav next" data-act="next" aria-label="下一个">${ICON.next}</button>` : ""}
      </div>
      ${stripHtml()}
    </div>${info ? infoHtml(a) : ""}`;

  if (a.kind === "text") fetch(`/files/${a.id}`).then((r) => r.text()).then((t) => { if (state?.items[state.i] === a) $(".v-text", el).textContent = t || "（空）"; });
  $("#vCaption", el)?.addEventListener("change", async (ev) => {
    await api(`/media/${a.id}`, { method: "PATCH", body: { caption: ev.target.value } });
    a.caption = ev.target.value;
    toast("说明已保存");
    state.opts.onChanged?.();
  });
  $(`#vStrip .on`, el)?.scrollIntoView({ block: "nearest", inline: "center" });

  // 相邻图片：缩略图先出，原图预加载后替换
  $$(".v-slide img[data-full]", el).forEach(upgrade);
  state.z = null;
  const img = $(".v-img", el);
  if (img) setupImage(img, a);
  if (isLive(a)) {
    const shown = a;
    setTimeout(() => { if (state?.items[state.i] === shown && (state.z?.s ?? 1) <= 1.01) startLive(); }, 350);
  }
  bindGestures();
}

/** 先显示缩略图，原图加载完成后替换 */
function upgrade(img) {
  const full = img.dataset.full;
  if (!full || img.src.endsWith(full)) return;
  const pre = new Image();
  pre.onload = () => { if (img.isConnected && !img.src.endsWith(img.dataset.orig)) img.src = full; };  // 已换成原图就别降级
  pre.src = full;
}

// ---------- 图片缩放 ----------

function stageBox() {
  const st = $("#vStage");
  const r = st.getBoundingClientRect();
  const m = mobile() ? 0 : 28;  // 留白，与 .v-fit 的 CSS 一致
  return { W: r.width - m * 2, H: r.height - m * 2, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

function setupImage(img, a) {
  const live = img.parentElement.querySelector(".v-live");
  const z = state.z = { img, live, nw: a.width || 0, nh: a.height || 0, r: 0, s: 1, x: 0, y: 0, fit: 1, loadedW: loadedWidth(img.dataset.full), hires: false };
  const ready = () => {
    if (!z.nw || !z.nh) { z.nw = img.naturalWidth; z.nh = img.naturalHeight; }
    for (const m of [img, live]) if (m) { m.style.width = `${z.nw}px`; m.style.height = `${z.nh}px`; }
    refit();
  };
  if (z.nw && z.nh) ready();
  else img.addEventListener("load", ready, { once: true });
}

function refit() {
  const z = state?.z;
  if (!z || !z.nw) return;
  const { W, H } = stageBox();
  const rot = z.r % 180 !== 0;
  const w = rot ? z.nh : z.nw, h = rot ? z.nw : z.nh;
  z.fit = Math.min(W / w, H / h, 1);  // 小图不放大
  clampPan();
  apply();
}

const maxScale = (z) => Math.max(3, 4 / z.fit);  // 最多到原图的 400%

function apply(anim = false) {
  const z = state?.z;
  if (!z) return;
  for (const m of [z.img, z.live]) {
    if (!m) continue;
    m.classList.toggle("anim", anim);
    m.style.transform = `translate(-50%, -50%) translate(${z.x}px, ${z.y}px) rotate(${z.r}deg) scale(${z.fit * z.s})`;
  }
  $("#vStage")?.classList.toggle("zoomed", z.s > 1.01);
  const pct = $(".v-pct");
  if (pct) pct.textContent = `${Math.round(z.fit * z.s * 100)}%`;
  // 放大到浏览版不够清晰时，换成原图（尺寸不变，只是更清楚）
  if (!z.hires && z.nw && z.nw * z.fit * z.s * (devicePixelRatio || 1) > z.loadedW * 1.1) {
    z.hires = true;
    const pre = new Image();
    pre.onload = () => { if (z.img.isConnected) z.img.src = pre.src; };
    pre.src = z.img.dataset.orig;
  }
}

function bounds(z, s = z.s) {
  const { W, H } = stageBox();
  const k = z.fit * s, rot = z.r % 180 !== 0;
  const w = (rot ? z.nh : z.nw) * k, h = (rot ? z.nw : z.nh) * k;
  return { mx: Math.max(0, (w - W) / 2), my: Math.max(0, (h - H) / 2) };
}
function clampPan() {
  const z = state.z;
  const { mx, my } = bounds(z);
  z.x = clamp(z.x, -mx, mx);
  z.y = clamp(z.y, -my, my);
}

/** 以屏幕上的某一点为中心缩放到 s */
function zoomTo(s, px, py, anim = true) {
  const z = state?.z;
  if (!z) return;
  const { cx, cy } = stageBox();
  s = clamp(s, 1, maxScale(z));
  const ratio = s / z.s;
  const ox = (px ?? cx) - cx, oy = (py ?? cy) - cy;
  z.x = ox - (ox - z.x) * ratio;
  z.y = oy - (oy - z.y) * ratio;
  z.s = s;
  if (s === 1) { z.x = 0; z.y = 0; }
  clampPan();
  apply(anim);
}
const zoomBy = (f, px, py, anim = true) => state?.z && zoomTo(state.z.s * f, px, py, anim);
/** 双击：适应 ⇄ 放大（至少到原图大小） */
function toggleZoom(px, py) {
  const z = state?.z;
  if (!z) return;
  if (z.s > 1.01) zoomTo(1, px, py);
  else zoomTo(Math.max(2.5, 1 / z.fit), px, py);
}
function rotate() {
  const z = state?.z;
  if (!z) return;
  z.r = (z.r + 90) % 360;
  z.s = 1; z.x = 0; z.y = 0;
  refit();
  apply(true);
}

// ---------- 实况照片 ----------

let stopLive = null;
function startLive(muted = true) {
  const box = $(".v-slide.cur");
  const a = state?.items[state.i];
  if (!box || !isLive(a)) return;
  stopLive?.();
  const btn = $(".v-livebtn");
  btn?.classList.add("on");
  const stop = playLive(box, a.id, { muted });
  const v = $("video.live-v", box);
  const done = () => { btn?.classList.remove("on"); if (stopLive === off) stopLive = null; };
  const off = () => { stop(); done(); };
  v?.addEventListener("ended", done, { once: true });
  stopLive = off;
}

// ---------- 切换 ----------

let stepping = false;
/** 带滑动动画切到相邻一项 */
function step(d) {
  if (!state || state.items.length < 2 || stepping) return;
  const track = $("#vTrack");
  const go = () => { state.i = (state.i + d + state.items.length) % state.items.length; stepping = false; render(); };
  if (!track || matchMedia("(prefers-reduced-motion: reduce)").matches) return go();
  stepping = true;
  track.classList.add("anim");
  track.style.transform = `translateX(${-d * 100}%)`;
  track.addEventListener("transitionend", go, { once: true });
  setTimeout(() => { if (stepping) go(); }, 400);
}
function goTo(j) { if (state && j !== state.i) { state.i = j; render(); } }

// ---------- 手势（Pointer Events：鼠标与触摸统一处理） ----------

function bindGestures() {
  const st = $("#vStage");
  if (!st) return;
  const pts = new Map();
  let g = null, lastTap = null, tapTimer = null;
  const track = $("#vTrack");
  const isImg = () => !!state?.z;

  st.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("video, audio, pre, a, button, input, .audio-stage")) return;
    try { st.setPointerCapture(e.pointerId); } catch { /* 合成事件或已失效的指针 */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      g = { type: "pending", x0: e.clientX, y0: e.clientY, t0: performance.now(), tx: state.z?.x ?? 0, ty: state.z?.y ?? 0, touch: e.pointerType !== "mouse" };
      if (g.touch && state.z?.live) {
        const mine = g;
        mine.press = setTimeout(() => { if (g === mine && g.type === "pending") { g.type = "live"; startLive(false); } }, 380);
      }
    } else if (pts.size === 2 && isImg()) {
      clearTimeout(g?.press);
      const [p, q] = [...pts.values()];
      g = { type: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y), m0: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, s0: state.z.s, x0: state.z.x, y0: state.z.y };
      track.style.transform = "";
    }
  });

  st.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const z = state.z;
    if (g.type === "pinch" && pts.size >= 2) {
      const [p, q] = [...pts.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y), m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const s = clamp(g.s0 * d / g.d0, 0.7, maxScale(z) * 1.2);  // 允许略微超出，松手回弹
      const { cx, cy } = stageBox();
      const ox = g.m0.x - cx, oy = g.m0.y - cy, ratio = s / g.s0;
      z.s = s;
      z.x = ox - (ox - g.x0) * ratio + (m.x - g.m0.x);
      z.y = oy - (oy - g.y0) * ratio + (m.y - g.m0.y);
      return apply();
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.type === "live") return;
    if (g.type === "pending") {
      if (Math.hypot(dx, dy) < 6) return;
      clearTimeout(g.press);
      if (isImg() && z.s > 1.01) g.type = "pan";
      else if (Math.abs(dx) > Math.abs(dy) && state.items.length > 1) g.type = "swipe";
      else if (dy > 0 && g.touch) g.type = "dismiss";
      else g.type = "none";
    }
    if (g.type === "pan") {
      const { mx, my } = bounds(z);
      // 越界时阻尼
      const rub = (v, m) => (v > m ? m + (v - m) * 0.3 : v < -m ? -m + (v + m) * 0.3 : v);
      z.x = rub(g.tx + dx, mx);
      z.y = rub(g.ty + dy, my);
      apply();
    } else if (g.type === "swipe") {
      track.classList.remove("anim");
      track.style.transform = `translateX(${dx}px)`;
    } else if (g.type === "dismiss") {
      const cur = $(".v-slide.cur");
      cur.style.transform = `translateY(${Math.max(0, dy)}px) scale(${1 - Math.min(dy, 400) / 2000})`;
      root().style.setProperty("--bg-a", String(1 - Math.min(dy, 300) / 400));
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    const z = state?.z;
    if (g.type === "pinch") {
      if (pts.size === 0) {
        if (z.s < 1) zoomTo(1, null, null);
        else { z.s = Math.min(z.s, maxScale(z)); clampPan(); apply(true); }
        g = null;
      }
      return;
    }
    if (pts.size) return;
    clearTimeout(g.press);
    if (g.type === "live") { stopLive?.(); g = null; return; }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0, dt = performance.now() - g.t0;
    if (g.type === "pan") { clampPan(); apply(true); }
    else if (g.type === "swipe") {
      const W = $("#vStage").clientWidth;
      if (Math.abs(dx) > W * 0.18 || (Math.abs(dx) > 30 && Math.abs(dx) / dt > 0.5)) {
        // 从当前拖动位置继续滑完
        track.classList.add("anim");
        stepping = true;
        track.style.transform = `translateX(${dx < 0 ? -100 : 100}%)`;
        const d = dx < 0 ? 1 : -1;
        const go = () => { if (!stepping) return; stepping = false; state.i = (state.i + d + state.items.length) % state.items.length; render(); };
        track.addEventListener("transitionend", go, { once: true });
        setTimeout(go, 400);
      } else { track.classList.add("anim"); track.style.transform = ""; }
    } else if (g.type === "dismiss") {
      if (dy > 110) closeViewer();
      else {
        const cur = $(".v-slide.cur");
        cur.classList.add("anim");
        cur.style.transform = "";
        root().style.removeProperty("--bg-a");
      }
    } else if (g.type === "pending") {
      // 点击：双击缩放；手机单击显隐工具栏
      const now = performance.now();
      if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        clearTimeout(tapTimer);
        lastTap = null;
        if (isImg()) toggleZoom(e.clientX, e.clientY);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
        if (g.touch) tapTimer = setTimeout(() => { if (state) { state.chrome = !state.chrome; root().classList.toggle("bare", !state.chrome); } }, 300);
      }
    }
    g = null;
  };
  st.addEventListener("pointerup", end);
  st.addEventListener("pointercancel", end);

  // 滚轮 / 触控板双指：以指针为中心缩放
  st.addEventListener("wheel", (e) => {
    if (!isImg()) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    zoomBy(f, e.clientX, e.clientY, false);
  }, { passive: false });
}

// ---------- 操作 ----------

async function act(name) {
  const a = state.items[state.i];
  if (name === "close") return closeViewer();
  if (name === "prev") return step(-1);
  if (name === "next") return step(1);
  if (name === "zin") return zoomBy(1.5);
  if (name === "zout") return zoomBy(1 / 1.5);
  if (name === "rot") return rotate();
  if (name === "live") return startLive(false);
  if (name === "fit") return state.z && (state.z.s > 1.01 ? zoomTo(1) : zoomTo(1 / state.z.fit));
  if (name === "info") { state.info = !state.info; if (!mobile()) savePrefInfo(state.info); return render(); }
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
  const go = e.target.closest("#viewer [data-go]");
  if (go) return goTo(+go.dataset.go);
  const b = e.target.closest("#viewer [data-act]");
  if (b) act(b.dataset.act);
});
document.addEventListener("keydown", (e) => {
  if (!state || e.target.matches?.("input, textarea") || $("#sheetRoot").children.length) return;
  const k = e.key;
  if (k === "Escape") closeViewer();
  else if (k === "ArrowLeft") step(-1);
  else if (k === "ArrowRight") step(1);
  else if (k === "i" || k === "I") act("info");
  else if (k === "+" || k === "=") zoomBy(1.5);
  else if (k === "-" || k === "_") zoomBy(1 / 1.5);
  else if (k === "0") zoomTo(1);
  else if (k === "1") state.z && zoomTo(1 / state.z.fit);
  else if (k === "r" || k === "R") rotate();
  else if (k === "l" || k === "L") startLive(false);
  else return;
  e.preventDefault();
});
addEventListener("resize", () => { if (state?.z) refit(); });
