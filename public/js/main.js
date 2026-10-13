// 应用外壳：侧边栏 / 底部标签栏、路由、全局上传与搜索
import { $, $$, api, esc, ICON, on, fmtSize, extractId, looksLikeId, sheet } from "./lib.js";
import { uploadFiles, pickFiles, installDrop } from "./upload.js";
import { closeViewer } from "./viewer.js";

const app = $("#app");

const NAV = [
  { href: "#/", key: "library", icon: "library", label: "图库", count: "media" },
  { href: "#/entries", key: "entries", icon: "entries", label: "日记", count: "entries" },
  { href: "#/read", key: "read", icon: "book", label: "阅读", count: "pages", unit: "页" },
  { href: "#/stats", key: "stats", icon: "stats", label: "统计" },
];
const TOOLS = [
  { href: "#/scan", key: "scan", icon: "scan", label: "扫码 / 输入编号" },
  { href: "#/print", key: "print", icon: "print", label: "打印标签" },
  { href: "#/trash", key: "trash", icon: "trash", label: "回收站", count: "trash" },
  { href: "#/settings", key: "settings", icon: "settings", label: "导出与连接" },
];

const routes = [
  [/^\/?$/, "library", () => import("./views/library.js")],
  [/^\/unsorted$/, "library", () => import("./views/library.js"), { ungrouped: true }],
  [/^\/entries$/, "entries", () => import("./views/entries.js")],
  [/^\/e\/([^/]+)$/, "entries", () => import("./views/entry.js")],
  [/^\/write\/([^/]+)$/, "entries", () => import("./views/write.js")],
  [/^\/read(?:\/([^/]+))?$/, "read", () => import("./views/reader.js")],
  [/^\/stats$/, "stats", () => import("./views/stats.js")],
  [/^\/scan$/, "scan", () => import("./views/scan.js")],
  [/^\/print$/, "print", () => import("./views/print.js")],
  [/^\/trash$/, "trash", () => import("./views/trash.js")],
  [/^\/settings$/, "settings", () => import("./views/settings.js")],
];

let counts = {}, active = "library", cleanup = null;

function renderNav() {
  const cur = location.hash.startsWith("#/unsorted") ? "unsorted" : active;
  const item = (n, sub = false) => {
    const c = n.count ? counts[n.count] : null;
    const badge = c ? `<span class="count">${c}</span>` : "";
    return `<a class="nav-item ${sub ? "nav-sub" : ""} ${n.key === cur ? "active" : ""}" href="${n.href}">${sub ? "" : ICON[n.icon]}<span>${n.label}</span>${badge}</a>`;
  };
  $("#sideNav").innerHTML = NAV.map((n) => item(n) + (n.key === "library"
    ? item({ href: "#/unsorted", key: "unsorted", label: "未归组", count: "ungrouped" }, true) : "")).join("")
    + `<div class="group-label">工具</div>` + TOOLS.map((n) => item(n)).join("");
  $("#tabbar").innerHTML = [NAV[0], NAV[1], { href: "#/scan", key: "scan", icon: "scan", label: "扫码" }, NAV[2], NAV[3]]
    .map((n) => `<a href="${n.href}" class="${n.key === active ? "active" : ""} ${n.key === "scan" ? "scan" : ""}">
      ${n.key === "scan" ? `<span class="ring">${ICON.scan}</span>` : ICON[n.icon]}<span>${n.label}</span></a>`).join("");
}

async function refreshCounts() {
  try {
    counts = await api("/counts");
    renderNav();
    const s = await api("/stats").catch(() => null);
    if (s) {
      const total = s.kinds.reduce((t, k) => t + k.bytes, 0) + s.pages.bytes;
      const part = (k) => (s.kinds.find((x) => x.kind === k)?.bytes || 0);
      const seg = (v, c) => total ? `<i style="width:${(v / total) * 100}%;background:${c}"></i>` : "";
      $("#sideFoot").innerHTML = `<div style="display:flex;justify-content:space-between"><span>${ICON.hdd.replace("<svg", '<svg style="width:14px;height:14px;vertical-align:-2px"')} 媒体占用</span><b style="color:var(--ink-2)">${fmtSize(total)}</b></div>
        <div class="meter">${seg(part("image"), "var(--k-image)")}${seg(part("video"), "var(--k-video)")}${seg(part("audio"), "var(--k-audio)")}${seg(part("text") + part("file") + s.pages.bytes, "var(--k-other)")}</div>
        <div>${s.streak ? `已连续记录 <b style="color:var(--accent-ink)">${s.streak}</b> 天` : "今天还没有新日记"}</div>`;
    }
  } catch { /* 离线时忽略 */ }
}

// ---------- 上传目标：当前页面可以覆盖（例如日记详情页上传即归入该日记） ----------
let uploadTarget = null;
export function setUploadTarget(t) { uploadTarget = t; }
const currentTarget = () => uploadTarget || { label: "文件会放入图库「未归组」" };
installDrop(currentTarget);
const doUpload = async () => {
  const files = await pickFiles({ accept: uploadTarget?.accept || "" });
  if (!files.length) return;
  if (uploadTarget?.onFiles) uploadTarget.onFiles(files);
  else uploadFiles(files, currentTarget());
};
$("#sideUpload").addEventListener("click", doUpload);
$("#mUpload").addEventListener("click", doUpload);

// ---------- 手机：禁止整页双指缩放（iOS Safari 不认 user-scalable=no）；图像查看器有自己的缩放 ----------
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---------- 搜索 ----------
$("#sideSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (!q) return;
  if (looksLikeId(q)) location.hash = `#/e/${extractId(q)}`;
  else location.hash = `#/entries?q=${encodeURIComponent(q)}`;
  e.target.q.blur();
});
addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.target.matches("input, textarea, select") && !e.target.isContentEditable && $("#viewer").hidden) {
    e.preventDefault();
    $("#sideSearch input").focus();
  }
});

// ---------- 手机「更多」菜单 ----------
$("#mMore").addEventListener("click", () => sheet({
  html: `<div class="menu-list">
      <a href="#/unsorted" data-x>${ICON.library}未归组<span class="muted" style="margin-left:auto">${counts.ungrouped ?? ""}</span></a>
      ${TOOLS.filter((t) => t.key !== "scan").map((t) => `<a href="${t.href}" data-x>${ICON[t.icon]}${t.label}</a>`).join("")}
      <button data-close>${ICON.close}关闭</button></div>`,
  mount: (el, close) => $$("[data-x]", el).forEach((a) => a.addEventListener("click", () => close())),
}));

// ---------- 路由 ----------
function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

let navGen = 0;
async function router() {
  const my = ++navGen;
  if (cleanup) { try { cleanup(); } catch { /* 忽略 */ } cleanup = null; }
  closeViewer();
  $("#sheetRoot").innerHTML = "";
  $("#selectBar").hidden = true;
  uploadTarget = null;
  document.body.classList.remove("doc-mode", "entry-mode");
  const { path, query } = parseHash();
  for (const [re, key, load, extra] of routes) {
    const m = path.match(re);
    if (!m) continue;
    active = key;
    renderNav();
    try {
      const mod = await load();
      if (my !== navGen) return;
      app.innerHTML = "";
      const c = await mod.render({ app, params: m.slice(1).map((x) => x && decodeURIComponent(x)), query, ...extra });
      if (my !== navGen) { c?.(); return; }
      cleanup = c || null;
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty"><div class="art">${ICON.info}</div><h3>出错了</h3><p>${esc(e.message)}</p><a class="btn" href="#/">返回图库</a></div>`;
    }
    return;
  }
  location.hash = "#/";
}

addEventListener("hashchange", () => { router(); scrollTo(0, 0); });
on("data-changed", refreshCounts);
on("uploaded", () => { clearTimeout(window.__ct); window.__ct = setTimeout(refreshCounts, 400); });
refreshCounts();
router();
