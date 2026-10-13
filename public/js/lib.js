// 通用工具：请求、格式化、图标、提示、弹层

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, init);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || `请求失败 ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- 事件总线：数据变化后刷新侧边栏计数等 ----------
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => { bus.addEventListener(name, fn); return () => bus.removeEventListener(name, fn); };

// ---------- 格式化 ----------
const WEEK = "日一二三四五六";
const pad = (n) => String(n).padStart(2, "0");
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const weekday = (date) => "周" + WEEK[new Date(`${date.slice(0, 10)}T00:00:00`).getDay()];
export const fmtDate = (date, withYear = true) => {
  const [y, m, d] = date.slice(0, 10).split("-");
  return withYear ? `${y}年${+m}月${+d}日` : `${+m}月${+d}日`;
};
export const fmtDay = (date) => {
  const t = today();
  const y = dayKey(new Date(Date.now() - 86400000));
  const k = date.slice(0, 10);
  if (k === t) return "今天";
  if (k === y) return "昨天";
  return fmtDate(k, k.slice(0, 4) !== t.slice(0, 4));
};
export const fmtTime = (iso) => iso.slice(11, 16);
export const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const fmtDur = (s) => {
  if (s == null) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};
export const fmtHours = (s) => s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.round(s / 60)} 分钟` : `${(s / 3600).toFixed(1)} 小时`;
export const fmtNum = (n) => Number(n || 0).toLocaleString("zh-CN");
export const parseTags = (s) => [...new Set(String(s).split(/[\s,，、;；]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean))];
export const extOf = (name) => (name.split(".").pop() || "").slice(0, 5);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** 从扫码结果或手输内容中提取编号：兼容纯编号、空格/全角横线、或包含 #/e/编号 的链接 */
export function extractId(raw) {
  const s = String(raw).trim();
  const m = s.match(/#\/e\/([^/?#\s]+)/) || s.match(/^\D*(\d{6})\s*[-－—–_ ]\s*(\d+)\D*$/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : decodeURIComponent(m[1]);
}
export const looksLikeId = (s) => /^\s*\d{6}\s*[-－—–_ ]\s*\d+\s*$/.test(s);

// ---------- 图标 ----------
const I = (d, extra = "") => `<svg viewBox="0 0 24 24" ${extra}>${d}</svg>`;
export const ICON = {
  library: I('<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.6"/>'),
  book: I('<path d="M4.5 5.5c2.6-1 5.2-1 7.5.6 2.3-1.6 4.9-1.6 7.5-.6v13c-2.6-1-5.2-1-7.5.6-2.3-1.6-4.9-1.6-7.5-.6z"/><path d="M12 6.1v13"/>'),
  entries: I('<path d="M6 3.5h9.5L19 7v13.5H6z"/><path d="M15 3.5V7h4"/><path d="M9 12h6M9 15.5h4"/>'),
  stats: I('<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>'),
  scan: I('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/>'),
  print: I('<path d="M7 8V3.5h10V8"/><rect x="3.5" y="8" width="17" height="8.5" rx="2"/><path d="M7 14h10v6.5H7z"/>'),
  trash: I('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 13h9.2l.9-13"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  search: I('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  upload: I('<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  image: I('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 16-5-5-8 8"/>'),
  audio: I('<path d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>'),
  video: I('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>'),
  text: I('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/>'),
  file: I('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>'),
  page: I('<path d="M6.5 3.5h11v17h-11z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>'),
  back: I('<path d="m15 18-6-6 6-6"/>'),
  next: I('<path d="m9 18 6-6-6-6"/>'),
  close: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  tag: I('<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.5 1.5 0 0 1 0 2.1l-6 6a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>'),
  link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  unlink: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/>'),
  dl: I('<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'),
  info: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'),
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11.5a6 6 0 0 0 12 0h-1.6a4.4 4.4 0 0 1-8.8 0z"/></svg>',
  sparkle: I('<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8-5.7-1.9L10.2 9z"/>'),
  ai: I('<rect x="4.5" y="7" width="15" height="12" rx="3"/><path d="M12 3.5V7M9 12.5v1M15 12.5v1M2.5 12v3M21.5 12v3"/>'),
  copy: I('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  select: I('<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 3 3 5-6"/>'),
  fire: I('<path d="M12 21c4 0 6.5-2.7 6.5-6.2 0-3.6-2.6-5.7-3.8-8.8-.9 1.9-2 3-3.3 3.4.2-2.6-.8-4.8-2.6-6.4C8.7 6.6 5.5 9.4 5.5 14.6 5.5 18.2 8 21 12 21z"/>'),
  hdd: I('<rect x="3.5" y="13" width="17" height="6.5" rx="2"/><path d="M5 13l2.3-7.2A1.5 1.5 0 0 1 8.7 4.7h6.6a1.5 1.5 0 0 1 1.4 1.1L19 13M16.5 16.3h.01"/>'),
  menu: I('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  list: I('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
};
// ---------- 图片尺寸 ----------
// 服务器提供 /files/:id?w=800|1600|2560 的 WebP 浏览版；只列出比原图窄的档位（不放大），原图很小时直接用原图
const VIEW_WIDTHS = [800, 1600, 2560];
export function viewWidths(a) {
  const nat = a.width || 4000;
  return VIEW_WIDTHS.filter((w) => w < nat);
}
/** 能覆盖 px 像素宽度的最小浏览版地址（不够就用原图） */
export function viewUrl(a, px) {
  const w = viewWidths(a).find((x) => x >= px);
  return w ? `/files/${a.id}?w=${w}` : `/files/${a.id}`;
}
/** <img> 的 src + srcset + sizes 属性串，浏览器按显示宽度与屏幕密度自己挑 */
export function imgAttrs(a, sizes) {
  const ws = viewWidths(a);
  if (!ws.length) return `src="/files/${a.id}"`;
  return `src="/files/${a.id}?w=${ws[Math.min(1, ws.length - 1)]}" srcset="${ws.map((w) => `/files/${a.id}?w=${w} ${w}w`).join(", ")}" sizes="${sizes}"`;
}

/** 一篇日记的两个页面：原稿与影像（详情）⇄ 文章（编辑），放在页面顶部切换 */
export const entryTabs = (id, active) => `<nav class="seg entry-tabs">${[
  ["e", "原稿 · 影像", ICON.library], ["write", "文章", ICON.entries],
].map(([k, label, icon]) => `<a href="#/${k}/${encodeURIComponent(id)}" class="${k === active ? "on" : ""}">${icon}<span class="lb" data-t="${label}">${label}</span></a>`).join("")}</nav>`;

/**
 * 日记两个页面共用的顶栏：左侧（返回、编号、切换）完全一致，切换时不会跳动
 * @param {{ state?: string, right?: string }} slots state 放在切换按钮后，right 放在最右侧
 */
export const entryHead = (id, active, { state = "", right = "" } = {}) => `<header class="doc-top">
    <a class="icon-btn" href="#/entries" title="全部日记">${ICON.back}</a>
    <nav class="crumb"><a href="#/entries">日记</a><span>/</span><b class="mono">${esc(id)}</b></nav>
    ${entryTabs(id, active)}${state}<span class="grow"></span>${right}
  </header>`;

export const KIND_LABEL = { image: "照片", video: "视频", audio: "录音", text: "文字", file: "文件" };

/** 由文件 id 生成稳定的「声波」图案，用于录音缩略图 */
export function waveSvg(seed, bars = 28) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
  const w = 100 / bars;
  let r = "";
  for (let i = 0; i < bars; i++) {
    const env = Math.sin((i / (bars - 1)) * Math.PI) * 0.7 + 0.3;
    const v = Math.max(0.12, env * (0.35 + rnd() * 0.65));
    r += `<rect x="${(i * w + w * 0.2).toFixed(2)}" y="${(50 - v * 50).toFixed(2)}" width="${(w * 0.6).toFixed(2)}" height="${(v * 100).toFixed(2)}" rx="${(w * 0.3).toFixed(2)}"/>`;
  }
  return `<svg class="wave" viewBox="0 0 100 100" preserveAspectRatio="none">${r}</svg>`;
}

// ---------- 提示 ----------
let toastTimer;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("已复制"); }
  catch { window.prompt("复制下面的内容：", text); }
}

/** 悬浮提示（图表用） */
let tipEl;
export function showTip(x, y, html) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; document.body.append(tipEl); }
  tipEl.innerHTML = html;
  tipEl.style.left = `${Math.min(Math.max(x, 80), innerWidth - 80)}px`;
  tipEl.style.top = `${y}px`;
  tipEl.hidden = false;
}
export const hideTip = () => { if (tipEl) tipEl.hidden = true; };

// ---------- 弹层 ----------
/**
 * 打开一个弹层。render(close) 返回 { html, mount? }；返回 Promise，close(value) 时 resolve
 */
export function sheet({ html, wide = false, mount }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "sheet-back";
    back.innerHTML = `<div class="sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
    $("#sheetRoot").append(back);
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(undefined); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(undefined); });
    back.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close(undefined)));
    mount?.(back.firstElementChild, close);
    back.querySelector("[autofocus]")?.focus();
  });
}

export function confirmSheet(title, message, okText = "确定", danger = false) {
  return sheet({
    html: `<div class="sheet-body"><h2>${esc(title)}</h2><p class="hint">${esc(message)}</p></div>
      <div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn ${danger ? "danger" : "primary"}" data-ok autofocus>${esc(okText)}</button></div>`,
    mount: (el, close) => $("[data-ok]", el).addEventListener("click", () => close(true)),
  }).then(Boolean);
}
