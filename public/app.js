// 数字日记前端：无构建步骤的原生 JS 单页应用

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");

const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 16-5-5-8 8"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h11"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
};
const KIND_LABEL = { image: "图片", audio: "音频", video: "视频", text: "文字", file: "文件" };
const WEEK = "日一二三四五六";

// ---------- 工具 ----------

async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, init);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || `请求失败 ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const weekday = (date) => "周" + WEEK[new Date(`${date}T00:00:00`).getDay()];
const fmtDate = (date) => { const [y, m, d] = date.split("-"); return `${y}年${+m}月${+d}日`; };
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const parseTags = (s) => [...new Set(String(s).split(/[\s,，、;；]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean))];
const extOf = (name) => (name.split(".").pop() || "").slice(0, 5);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** 从扫码结果或手输内容中提取编号：兼容纯编号、带空格/全角横线、或包含 #/e/编号 的链接 */
function extractId(raw) {
  const s = String(raw).trim();
  const m = s.match(/#\/e\/([^/?#\s]+)/) || s.match(/(\d{6})\s*[-－—–_ ]\s*(\d+)/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : decodeURIComponent(m[1]);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("已复制"); }
  catch { prompt("复制下面的内容：", text); }
}

// ---------- 路由 ----------

let cleanup = null;
const routes = [
  [/^\/?$/, renderHome],
  [/^\/e\/([^/]+)$/, (m) => renderEntry(decodeURIComponent(m[1]))],
  [/^\/scan$/, renderScan],
  [/^\/print$/, renderPrint],
  [/^\/trash$/, renderTrash],
  [/^\/more$/, renderMore],
];

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

async function router() {
  if (cleanup) { cleanup(); cleanup = null; }
  closeLightbox();
  const { path, query } = parseHash();
  $$(".nav-btn").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${path}`));
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { await fn(m, query); } catch (e) { app.innerHTML = `<div class="empty">${ICON.book}<p>${esc(e.message)}</p><a class="btn" href="#/">返回首页</a></div>`; }
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", () => { router(); window.scrollTo(0, 0); });

// ---------- 首页 ----------

const homeState = { q: "", tag: "", month: "" };

async function renderHome() {
  app.innerHTML = `
    <div class="toolbar">
      <div class="search">${ICON.search}<input type="search" id="q" placeholder="搜索编号、标题、标签、附件名…" value="${esc(homeState.q)}"></div>
      <input type="month" id="month" class="month-input" value="${esc(homeState.month)}" title="按月份筛选">
    </div>
    <div class="chips" id="tags"></div>
    <div id="list"></div>
    <div class="more-row" id="moreRow"></div>`;

  let offset = 0;
  const list = $("#list");
  let lastDay = null, dayBox = null;

  const load = async (reset) => {
    if (reset) { offset = 0; list.innerHTML = ""; lastDay = null; }
    const p = new URLSearchParams({ limit: "40", offset: String(offset) });
    if (homeState.q) p.set("q", homeState.q);
    if (homeState.tag) p.set("tag", homeState.tag);
    if (homeState.month) {
      const [y, m] = homeState.month.split("-").map(Number);
      p.set("from", `${homeState.month}-01`);
      p.set("to", `${homeState.month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`);
    }
    const r = await api(`/entries?${p}`);
    offset += r.items.length;
    if (!r.total) {
      list.innerHTML = homeState.q || homeState.tag || homeState.month
        ? `<div class="empty">${ICON.search}<p>没有找到匹配的日记</p></div>`
        : `<div class="empty">${ICON.book}<p>还没有日记。<br>写完纸质日记后点右上角「新建」，把得到的编号写在本子上即可关联。</p></div>`;
    }
    for (const e of r.items) {
      if (e.date !== lastDay) {
        lastDay = e.date;
        const sec = document.createElement("section");
        sec.className = "day";
        sec.innerHTML = `<div class="day-head"><span class="d">${fmtDate(e.date)}</span><span class="w">${weekday(e.date)}</span></div><div class="entries"></div>`;
        list.append(sec);
        dayBox = $(".entries", sec);
      }
      dayBox.insertAdjacentHTML("beforeend", entryCard(e));
    }
    $("#moreRow").innerHTML = offset < r.total ? `<button class="btn" id="loadMore">加载更多（剩余 ${r.total - offset}）</button>` : "";
    $("#loadMore")?.addEventListener("click", () => load(false));
  };

  const renderTags = async () => {
    const tags = await api("/tags");
    $("#tags").innerHTML = tags.map((t) =>
      `<button class="chip ${t.tag === homeState.tag ? "on" : ""}" data-tag="${esc(t.tag)}">#${esc(t.tag)}<span class="n">${t.count}</span></button>`).join("");
  };

  $("#q").addEventListener("input", debounce((ev) => { homeState.q = ev.target.value.trim(); load(true); }, 250));
  $("#q").addEventListener("keydown", (ev) => {
    const id = ev.key === "Enter" && extractId(ev.target.value);
    if (id && /^\d{6}-\d+$/.test(id)) location.hash = `#/e/${id}`;
  });
  $("#month").addEventListener("change", (ev) => { homeState.month = ev.target.value; load(true); });
  $("#tags").addEventListener("click", (ev) => {
    const b = ev.target.closest(".chip"); if (!b) return;
    homeState.tag = homeState.tag === b.dataset.tag ? "" : b.dataset.tag;
    $$(".chip", $("#tags")).forEach((c) => c.classList.toggle("on", c.dataset.tag === homeState.tag));
    load(true);
  });
  await Promise.all([load(true), renderTags()]);
}

function entryCard(e) {
  const counts = Object.entries(e.counts).filter(([, n]) => n).map(([k, n]) => `<span>${ICON[k]}${n}</span>`).join("");
  return `<a class="card entry-card" href="#/e/${esc(e.id)}">
    <div class="entry-top"><span class="idtag">${esc(e.id)}</span>
      <span class="entry-title ${e.title ? "" : "none"}">${esc(e.title || "无标题")}</span></div>
    ${e.preview.length ? `<div class="thumbs">${e.preview.map((a) => `<img loading="lazy" src="/thumbs/${a.id}" alt="">`).join("")}</div>` : ""}
    <div class="meta">${counts || "<span>暂无附件</span>"}
      ${e.tags.length ? `<span class="tags">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</span>` : ""}</div>
  </a>`;
}

// ---------- 新建 ----------

const newDialog = $("#newDialog");
$("#newBtn").addEventListener("click", () => {
  const f = $("#newForm");
  f.reset();
  f.date.value = today();
  newDialog.showModal();
  setTimeout(() => f.title.focus(), 50);
});
$("[data-close]", newDialog).addEventListener("click", () => newDialog.close());
$("#newForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const e = await api("/entries", { method: "POST", body: { date: f.date.value, title: f.title.value, tags: parseTags(f.tags.value) } });
    newDialog.close();
    location.hash = `#/e/${e.id}`;
    toast(`已创建 ${e.id}，记得写在纸上`);
  } catch (err) { toast(err.message); }
});

// ---------- 日记详情 ----------

async function renderEntry(id) {
  let e;
  try { e = await api(`/entries/${encodeURIComponent(id)}`); }
  catch (err) {
    if (err.status === 404) {
      app.innerHTML = `<div class="empty">${ICON.search}<p>找不到编号 <b class="idtag">${esc(id)}</b> 的日记</p><a class="btn" href="#/scan">重新扫码</a> <a class="btn" href="#/">返回首页</a></div>`;
      return;
    }
    throw err;
  }
  const trashed = !!e.deleted_at;
  app.innerHTML = `
    <a class="back" href="#/">${ICON.back}全部日记</a>
    ${trashed ? `<div class="banner"><span>这篇日记在回收站中。</span><button class="btn small" id="restore">恢复</button></div>` : ""}
    <section class="card entry-head">
      <div>
        <div class="id-row"><span class="big-id">${esc(e.id)}</span><button class="btn small ghost" id="copyId" title="复制编号">复制</button></div>
        <div class="entry-date">${fmtDate(e.date)} ${weekday(e.date)}</div>
      </div>
      <div class="qr-box">
        <img src="/api/qr/${encodeURIComponent(e.id)}.svg" alt="编号二维码">
        <a class="btn small" href="#/print?ids=${encodeURIComponent(e.id)}">打印标签</a>
      </div>
      <div class="fields">
        <label>标题<input type="text" id="title" value="${esc(e.title)}" placeholder="给这篇日记起个名字（可选）" maxlength="200" ${trashed ? "disabled" : ""}></label>
        <label>标签<input type="text" id="tags" value="${esc(e.tags.join(" "))}" placeholder="空格分隔，如：旅行 家人" ${trashed ? "disabled" : ""}></label>
        <label>文字备注<textarea id="note" placeholder="可选：补充说明、摘录或转写的文字" ${trashed ? "disabled" : ""}>${esc(e.note)}</textarea></label>
        <div class="save-state" id="saveState"></div>
      </div>
      ${trashed ? "" : `<div class="entry-actions"><button class="btn danger small" id="delEntry">${ICON.trash}移入回收站</button></div>`}
    </section>

    <div class="section-head">
      <h2>附件 <small id="attCount"></small></h2>
    </div>
    ${trashed ? "" : `
    <div class="dropzone" id="drop">${ICON.upload}点击选择或拖入文件 · 支持图片、音频、视频、文字等，可多选
      <input type="file" id="fileInput" multiple hidden>
    </div>
    <div class="uploads" id="uploads"></div>`}
    <div class="atts" id="atts"></div>`;

  $("#copyId").addEventListener("click", () => copy(e.id));
  $("#restore")?.addEventListener("click", async () => { await api(`/entries/${e.id}/restore`, { method: "POST" }); toast("已恢复"); router(); });
  $("#delEntry")?.addEventListener("click", async () => {
    if (!confirm(`把 ${e.id} 移入回收站？之后可以在回收站恢复。`)) return;
    await api(`/entries/${e.id}`, { method: "DELETE" });
    toast("已移入回收站");
    location.hash = "#/";
  });

  // 自动保存
  const state = $("#saveState");
  const save = debounce(async () => {
    try {
      state.textContent = "保存中…";
      await api(`/entries/${e.id}`, { method: "PATCH", body: { title: $("#title").value, note: $("#note").value, tags: parseTags($("#tags").value) } });
      state.textContent = "已保存";
    } catch (err) { state.textContent = `保存失败：${err.message}`; }
  }, 600);
  for (const sel of ["#title", "#tags", "#note"]) $(sel).addEventListener("input", () => { state.textContent = "…"; save(); });

  const atts = e.attachments;
  const renderAtts = () => {
    const live = atts.filter((a) => !a.deleted_at);
    $("#attCount").textContent = live.length ? `${live.length} 个` : "";
    $("#atts").innerHTML = live.length || trashed ? live.map((a) => attCard(a, trashed)).join("") : "";
    live.filter((a) => a.kind === "text").forEach(async (a) => {
      const pre = $(`[data-att="${a.id}"] pre`);
      if (!pre) return;
      const txt = await fetch(`/files/${a.id}`).then((r) => r.text()).catch(() => "");
      pre.textContent = txt.slice(0, 400) || "（空）";
    });
  };
  renderAtts();

  $("#atts").addEventListener("click", async (ev) => {
    const card = ev.target.closest("[data-att]"); if (!card) return;
    const a = atts.find((x) => x.id === card.dataset.att);
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "del") {
      await api(`/attachments/${a.id}`, { method: "DELETE" });
      a.deleted_at = new Date().toISOString();
      renderAtts();
      toast("已移入回收站");
    } else if (ev.target.closest(".att-media") && a.kind !== "audio") {
      if (a.kind === "file") window.open(`/files/${a.id}`, "_blank");
      else openLightbox(atts.filter((x) => !x.deleted_at && ["image", "video", "text"].includes(x.kind)), a.id);
    }
  });
  $("#atts").addEventListener("change", async (ev) => {
    if (!ev.target.matches(".att-caption")) return;
    const id = ev.target.closest("[data-att]").dataset.att;
    await api(`/attachments/${id}`, { method: "PATCH", body: { caption: ev.target.value } });
    atts.find((x) => x.id === id).caption = ev.target.value;
    toast("说明已保存");
  });

  if (trashed) return;

  // 上传
  const drop = $("#drop"), input = $("#fileInput");
  drop.addEventListener("click", (ev) => { if (ev.target !== input) input.click(); });
  input.addEventListener("change", () => { uploadFiles([...input.files]); input.value = ""; });
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => { ev.preventDefault(); drop.classList.remove("over"); uploadFiles([...ev.dataTransfer.files]); });
  const onPaste = (ev) => { const fs = [...(ev.clipboardData?.files || [])]; if (fs.length) uploadFiles(fs); };
  document.addEventListener("paste", onPaste);
  cleanup = () => document.removeEventListener("paste", onPaste);

  async function uploadFiles(files) {
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "upload-row";
      row.innerHTML = `<span class="name">${esc(file.name)}</span><span class="bar"><i></i></span><small>${fmtSize(file.size)}</small>`;
      $("#uploads").append(row);
      try {
        const [a] = await uploadOne(e.id, file, (p) => { $(".bar i", row).style.width = `${Math.round(p * 100)}%`; });
        atts.push(a);
        renderAtts();
        row.remove();
      } catch (err) {
        row.querySelector("small").textContent = "失败";
        toast(`${file.name} 上传失败：${err.message}`);
      }
    }
  }
}

function uploadOne(entryId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("files", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/entries/${encodeURIComponent(entryId)}/attachments`);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(fd);
  });
}

function attCard(a, readonly) {
  let media;
  if (a.kind === "image") media = `<div class="att-media"><img loading="lazy" src="${a.thumb ? `/thumbs/${a.id}` : `/files/${a.id}`}" alt="${esc(a.caption)}"></div>`;
  else if (a.kind === "video") media = `<div class="att-media">${a.thumb ? `<img loading="lazy" src="/thumbs/${a.id}" alt="">` : ""}<span class="play">${ICON.play}</span></div>`;
  else if (a.kind === "audio") media = `<div class="att-media audio"><span class="ficon">${ICON.audio}</span><audio controls preload="none" src="/files/${a.id}"></audio></div>`;
  else if (a.kind === "text") media = `<div class="att-media text"><pre>加载中…</pre></div>`;
  else media = `<div class="att-media"><span class="ficon">${ICON.file}${esc(extOf(a.original_name))}</span></div>`;
  return `<div class="card att" data-att="${a.id}">
    ${media}
    <div class="att-body">
      <input class="att-caption" type="text" value="${esc(a.caption)}" placeholder="添加说明…" ${readonly ? "disabled" : ""}>
      <div class="att-name" title="${esc(a.original_name)}">${KIND_LABEL[a.kind]} · ${esc(a.original_name)} · ${fmtSize(a.size)}</div>
      <div class="att-tools">
        <a class="btn small ghost" href="/files/${a.id}?download=1" title="下载原文件">${ICON.dl}</a>
        ${readonly ? "" : `<button class="btn small ghost danger" data-act="del" title="移入回收站">${ICON.trash}</button>`}
      </div>
    </div>
  </div>`;
}

// ---------- 灯箱 ----------

const lb = $("#lightbox");
let lbItems = [], lbIndex = 0;

function openLightbox(items, id) {
  lbItems = items;
  lbIndex = Math.max(0, items.findIndex((x) => x.id === id));
  lb.hidden = false;
  document.body.style.overflow = "hidden";
  showLb();
}
function closeLightbox() {
  if (lb.hidden) return;
  $(".lb-stage", lb).innerHTML = "";
  lb.hidden = true;
  document.body.style.overflow = "";
}
async function showLb() {
  const a = lbItems[lbIndex];
  const stage = $(".lb-stage", lb);
  $(".lb-prev", lb).hidden = $(".lb-next", lb).hidden = lbItems.length < 2;
  $(".lb-caption", lb).textContent = [a.caption, `${lbIndex + 1} / ${lbItems.length}`].filter(Boolean).join(" · ");
  if (a.kind === "image") stage.innerHTML = `<img src="/files/${a.id}" alt="">`;
  else if (a.kind === "video") stage.innerHTML = `<video src="/files/${a.id}" controls autoplay playsinline></video>`;
  else {
    stage.innerHTML = "<pre>加载中…</pre>";
    const txt = await fetch(`/files/${a.id}`).then((r) => r.text());
    if (lbItems[lbIndex] === a) $("pre", stage).textContent = txt;
  }
}
const lbStep = (d) => { lbIndex = (lbIndex + d + lbItems.length) % lbItems.length; showLb(); };
$(".lb-close", lb).addEventListener("click", closeLightbox);
$(".lb-prev", lb).addEventListener("click", () => lbStep(-1));
$(".lb-next", lb).addEventListener("click", () => lbStep(1));
lb.addEventListener("click", (ev) => { if (ev.target === lb || ev.target.classList.contains("lb-stage")) closeLightbox(); });
document.addEventListener("keydown", (ev) => {
  if (lb.hidden) return;
  if (ev.key === "Escape") closeLightbox();
  if (ev.key === "ArrowLeft") lbStep(-1);
  if (ev.key === "ArrowRight") lbStep(1);
});
let touchX = null;
lb.addEventListener("touchstart", (ev) => { touchX = ev.touches[0].clientX; }, { passive: true });
lb.addEventListener("touchend", (ev) => {
  if (touchX === null || lbItems.length < 2) return;
  const dx = ev.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50 && lbItems[lbIndex].kind === "image") lbStep(dx > 0 ? -1 : 1);
  touchX = null;
});

// ---------- 扫码 ----------

async function renderScan() {
  const canCamera = window.isSecureContext && navigator.mediaDevices?.getUserMedia;
  app.innerHTML = `
    <div class="scan-wrap">
      <section class="card">
        <h2 style="font-size:17px;margin-bottom:10px">输入编号</h2>
        <form class="id-form" id="idForm">
          <input type="text" id="idInput" placeholder="例如 261013-1" inputmode="text" autocomplete="off" autofocus>
          <button class="btn primary">打开</button>
        </form>
      </section>
      <section class="card">
        <h2 style="font-size:17px;margin-bottom:10px">扫描二维码</h2>
        ${canCamera ? `<div class="viewfinder"><video id="video" playsinline muted></video></div>
          <p class="hint" id="scanHint" style="margin-top:8px">把纸上的二维码对准取景框</p>`
        : `<p class="hint">当前是 http 访问，浏览器不允许直接打开摄像头。可以用下面的「拍照识别」，或通过 https 访问后使用实时扫码。</p>`}
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn">${ICON.image}拍照 / 选图识别<input type="file" id="photo" accept="image/*" capture="environment" hidden></label>
        </div>
      </section>
    </div>`;

  const go = (raw) => {
    const id = extractId(raw);
    if (!id) { toast(`无法识别编号：${String(raw).slice(0, 40)}`); return false; }
    location.hash = `#/e/${id}`;
    return true;
  };
  $("#idForm").addEventListener("submit", (ev) => { ev.preventDefault(); go($("#idInput").value); });
  $("#photo").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const text = await decodeImage(await createImageBitmap(f));
    text ? go(text) : toast("没有在图片中找到二维码，请靠近一些重拍");
    ev.target.value = "";
  });

  if (!canCamera) return;
  let stream, stopped = false;
  cleanup = () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
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
    $("#scanHint").textContent = `无法打开摄像头：${err.message}。可以改用拍照识别。`;
  }
}

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

// ---------- 打印标签 ----------

async function renderPrint(_m, query) {
  const selected = new Set((query.get("ids") || "").split(",").filter(Boolean));
  const t = today();
  const monthStart = `${t.slice(0, 8)}01`;
  app.innerHTML = `
    <a class="back no-print" href="#/">${ICON.back}全部日记</a>
    <section class="card print-controls no-print">
      <h2 style="font-size:17px">打印二维码标签</h2>
      <p class="hint">二维码只包含编号本身。打印后剪下贴在纸质日记对应页上。</p>
      <div class="row">
        <label>从<input type="date" id="pFrom" value="${monthStart}"></label>
        <label>到<input type="date" id="pTo" value="${t}"></label>
        <button class="btn" id="pLoad">列出</button>
      </div>
      <div class="pick-list" id="pick"></div>
      <div class="row">
        <label>尺寸<select id="pSize"><option value="20">小 · 20mm</option><option value="30" selected>中 · 30mm</option><option value="40">大 · 40mm</option></select></label>
        <label>每个编号份数<input type="text" inputmode="numeric" id="pCopies" value="1"></label>
        <button class="btn primary" id="pPrint">打印</button>
      </div>
    </section>
    <div class="sheet" id="sheet"></div>`;

  const pick = $("#pick");
  const renderSheet = () => {
    const size = Number($("#pSize").value);
    const copies = Math.min(Math.max(parseInt($("#pCopies").value) || 1, 1), 50);
    const ids = [...selected];
    const sheet = $("#sheet");
    sheet.style.setProperty("--lw", `${size}mm`);
    sheet.style.setProperty("--lf", `${size <= 20 ? 7 : size <= 30 ? 9 : 11}pt`);
    sheet.innerHTML = ids.length
      ? ids.flatMap((id) => Array(copies).fill(`<div class="label"><img src="/api/qr/${encodeURIComponent(id)}.svg" alt=""><div class="lid">${esc(id)}</div></div>`)).join("")
      : `<p class="hint" style="padding:20px">勾选上面的日记以生成标签</p>`;
  };
  const loadList = async () => {
    const r = await api(`/entries?from=${$("#pFrom").value}&to=${$("#pTo").value}&limit=200`);
    const known = new Set(r.items.map((e) => e.id));
    const extra = [...selected].filter((id) => !known.has(id)).map((id) => ({ id, title: "" }));
    const items = [...extra, ...r.items];
    pick.innerHTML = items.length
      ? `<label><input type="checkbox" id="pAll"> <b>全选</b></label>` + items.map((e) =>
        `<label><input type="checkbox" value="${esc(e.id)}" ${selected.has(e.id) ? "checked" : ""}> <span class="idtag">${esc(e.id)}</span> ${esc(e.title || "")}</label>`).join("")
      : `<p class="hint" style="padding:8px">这段时间没有日记</p>`;
  };
  pick.addEventListener("change", (ev) => {
    if (ev.target.id === "pAll") {
      $$("input[value]", pick).forEach((c) => { c.checked = ev.target.checked; c.checked ? selected.add(c.value) : selected.delete(c.value); });
    } else if (ev.target.value) ev.target.checked ? selected.add(ev.target.value) : selected.delete(ev.target.value);
    renderSheet();
  });
  $("#pLoad").addEventListener("click", loadList);
  $("#pSize").addEventListener("change", renderSheet);
  $("#pCopies").addEventListener("input", renderSheet);
  $("#pPrint").addEventListener("click", () => window.print());
  await loadList();
  renderSheet();
}

// ---------- 回收站 ----------

async function renderTrash() {
  const t = await api("/trash");
  const empty = !t.entries.length && !t.attachments.length;
  app.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <h2>回收站</h2>
      ${empty ? "" : `<button class="btn danger" id="emptyTrash">${ICON.trash}清空回收站</button>`}
    </div>
    <p class="hint" style="margin-bottom:14px">通过网页或 MCP 删除的内容都会先放在这里。只有在这里点「永久删除」才会真正删除文件。</p>
    ${empty ? `<div class="empty">${ICON.trash}<p>回收站是空的</p></div>` : ""}
    ${t.entries.length ? `<h3 style="font-size:15px;margin:16px 2px 8px">日记（连同其附件）</h3><div class="list">${t.entries.map((e) => `
      <div class="card list-item" data-type="entries" data-id="${esc(e.id)}">
        <span class="idtag">${esc(e.id)}</span>
        <div class="grow"><div>${esc(e.title || "无标题")}</div><div class="sub">删除于 ${new Date(e.deleted_at).toLocaleString()}</div></div>
        <a class="btn small" href="#/e/${esc(e.id)}">查看</a>
        <button class="btn small" data-act="restore">恢复</button>
        <button class="btn small danger" data-act="purge">永久删除</button>
      </div>`).join("")}</div>` : ""}
    ${t.attachments.length ? `<h3 style="font-size:15px;margin:20px 2px 8px">附件</h3><div class="list">${t.attachments.map((a) => `
      <div class="card list-item" data-type="attachments" data-id="${a.id}">
        ${a.thumb ? `<img src="/thumbs/${a.id}" alt="">` : `<span class="ficon">${ICON[a.kind]}</span>`}
        <div class="grow"><div>${esc(a.original_name)}</div><div class="sub">来自 <a href="#/e/${esc(a.entry_id)}">${esc(a.entry_id)}</a> · ${fmtSize(a.size)} · 删除于 ${new Date(a.deleted_at).toLocaleString()}</div></div>
        <button class="btn small" data-act="restore">恢复</button>
        <button class="btn small danger" data-act="purge">永久删除</button>
      </div>`).join("")}</div>` : ""}`;

  app.addEventListener("click", trashClick);
  cleanup = () => app.removeEventListener("click", trashClick);
  async function trashClick(ev) {
    if (ev.target.id === "emptyTrash") {
      if (!confirm("永久删除回收站中的全部内容？此操作无法撤销。")) return;
      const r = await api("/trash", { method: "DELETE" });
      toast(`已永久删除 ${r.purged_entries} 篇日记、${r.purged_attachments} 个附件`);
      return router();
    }
    const btn = ev.target.closest("[data-act]"); if (!btn) return;
    const item = btn.closest("[data-id]");
    const { type, id } = item.dataset;
    if (btn.dataset.act === "restore") {
      await api(`/${type}/${encodeURIComponent(id)}/restore`, { method: "POST" });
      toast("已恢复");
    } else {
      if (!confirm("永久删除后无法恢复，确定吗？")) return;
      await api(`/${type}/${encodeURIComponent(id)}/purge`, { method: "DELETE" });
      toast("已永久删除");
    }
    router();
  }
}

// ---------- 更多 ----------

async function renderMore() {
  const s = await api("/stats");
  const origin = location.origin;
  const claudeCode = `claude mcp add --transport http diary ${origin}/mcp`;
  const desktop = JSON.stringify({ mcpServers: { diary: { command: "npx", args: ["-y", "mcp-remote", `${origin}/mcp`, "--allow-http"] } } }, null, 2);
  app.innerHTML = `
    <div class="stats">
      <div class="card stat"><b>${s.entries}</b><span>篇日记</span></div>
      <div class="card stat"><b>${s.attachments}</b><span>个附件</span></div>
      <div class="card stat"><b>${fmtSize(s.bytes)}</b><span>媒体占用</span></div>
      <div class="card stat"><b>${s.trash}</b><span>回收站</span></div>
    </div>
    <section class="card panel">
      <h2>导出全部数据</h2>
      <p class="hint">打包为 zip：每篇日记一个文件夹（entry.md + 原始附件），附 index.json。回收站中的内容不导出。</p>
      <div><a class="btn primary" href="/api/export.zip">${ICON.dl}下载导出包</a></div>
    </section>
    <section class="card panel">
      <h2>连接 AI（MCP）</h2>
      <p class="hint">MCP 端点：<code>${esc(origin)}/mcp</code>（Streamable HTTP）。Agent 可增删改查，但删除只会进回收站。</p>
      <div><b style="font-size:14px">Claude Code</b></div>
      <div class="code-wrap"><pre class="code">${esc(claudeCode)}</pre><button class="btn small" data-copy="${esc(claudeCode)}">复制</button></div>
      <div><b style="font-size:14px">Claude Desktop</b> <small>（claude_desktop_config.json）</small></div>
      <div class="code-wrap"><pre class="code">${esc(desktop)}</pre><button class="btn small" data-copy="${esc(desktop)}">复制</button></div>
    </section>`;
  $$("[data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));
}

router();
