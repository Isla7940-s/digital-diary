// 正文编辑（飞书文档式）：转写纸质日记，并在文中插入本篇的照片、视频、录音
import { $, $$, api, esc, entryHead, imgAttrs, ICON, debounce, toast, emit, copy, sheet, fmtDate, weekday, fmtNum } from "../lib.js";
import { createEditor } from "../editor.js";
import { bodyHash } from "../md.js";
import { createGallery } from "../gallery.js";
import { openViewer } from "../viewer.js";
import { uploadFiles } from "../upload.js";
import { setUploadTarget } from "../main.js";

const SIDE_KEY = "write.side";
const HINT = "方向键移动 · 回车选中 · 空格插入，也可以直接点选";

export async function render({ app, params: [rawId] }) {
  let e;
  try { e = await api(`/entries/${encodeURIComponent(rawId)}`); }
  catch (err) {
    if (err.status !== 404) throw err;
    app.innerHTML = `<div class="empty"><div class="art">${ICON.search}</div><h3>找不到编号 <span class="idpill">${esc(rawId)}</span></h3><a class="btn" href="#/entries">全部日记</a></div>`;
    return;
  }
  const id = e.id;
  if (e.deleted_at) {
    app.innerHTML = `<div class="empty"><div class="art">${ICON.trash}</div><h3>这篇日记在回收站中</h3><p>恢复后才能编辑正文。</p><a class="btn" href="#/e/${esc(id)}">返回日记</a></div>`;
    return;
  }

  let byId = new Map([...e.media, ...e.pages].map((a) => [a.id, a]));
  let pages = e.pages;
  let side = false;
  try { side = localStorage.getItem(SIDE_KEY) === "1" && pages.length > 0 && innerWidth > 1100; } catch { /* 忽略 */ }

  document.body.classList.add("doc-mode");
  app.innerHTML = `
    ${entryHead(id, "write", {
      state: `<span class="doc-state" id="wrState"><i></i><span>已保存</span></span>`,
      right: `<button class="btn sm ghost ${side ? "on" : ""}" id="wrSideBtn" ${pages.length ? "" : "hidden"}>${ICON.page}<span>原稿对照</span></button>
        <button class="btn sm ghost" id="wrMediaBtn">${ICON.image}<span>插入影像</span></button>
        <a class="btn sm ghost" href="#/read/${esc(id)}">${ICON.book}<span>阅读</span></a>
        <button class="icon-btn" id="wrMore" title="更多">${ICON.menu}</button>`,
    })}
    <div class="doc-layout ${side ? "with-side" : ""}" id="wrLayout">
      <article class="doc">
        <textarea class="doc-title" id="wrTitle" rows="1" maxlength="200" placeholder="请输入标题">${esc(e.title)}</textarea>
        <div class="doc-meta">
          <span>${fmtDate(e.date)} ${weekday(e.date)}</span>
          <span class="idpill">${esc(id)}</span>
          <span id="wrCount"></span>
          ${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}
        </div>
        <div id="wrEditor"></div>
        <section class="doc-tray" id="wrTray" hidden></section>
      </article>
      <aside class="doc-side" id="wrSide">
        <div class="ds-head"><b>${ICON.page}纸质原稿</b><span class="muted">${pages.length} 页</span><span class="grow"></span>
          <button class="icon-btn" id="wrSideClose" title="关闭">${ICON.close}</button></div>
        <div class="ds-pages" id="wrPages"></div>
      </aside>
    </div>
    <div class="doc-mbar" id="wrMbar">
      <button data-m="insert">${ICON.plus}</button>
      <button data-m="h2"><span class="gl">H</span></button>
      <button data-m="ul"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg></button>
      <button data-m="todo"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg></button>
      <button data-m="media">${ICON.image}</button>
      <button data-m="pages" ${pages.length ? "" : "hidden"}>${ICON.page}</button>
      <button data-m="undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
    </div>`;

  // ---------- 原稿对照 ----------
  const renderPages = () => {
    $("#wrPages").innerHTML = pages.map((p, i) => `<figure data-id="${p.id}"><img loading="lazy" decoding="async" ${imgAttrs(p, "(max-width: 860px) 100vw, 34vw")} alt="第 ${i + 1} 页"${p.width && p.height ? ` width="${p.width}" height="${p.height}"` : ""}><figcaption>第 ${i + 1} 页</figcaption></figure>`).join("");
  };
  renderPages();
  const setSide = (on) => {
    side = on;
    $("#wrLayout").classList.toggle("with-side", on);
    $("#wrSideBtn").classList.toggle("on", on);
    try { localStorage.setItem(SIDE_KEY, on ? "1" : "0"); } catch { /* 忽略 */ }
  };
  $("#wrSideBtn").addEventListener("click", () => setSide(!side));
  $("#wrSideClose").addEventListener("click", () => setSide(false));
  $("#wrPages").addEventListener("click", (ev) => { const f = ev.target.closest("figure"); if (f) openViewer(pages, f.dataset.id); });

  // ---------- 编辑器 ----------
  const reloadEntry = async () => {
    const fresh = await api(`/entries/${encodeURIComponent(id)}`);
    byId = new Map([...fresh.media, ...fresh.pages].map((a) => [a.id, a]));
    pages = fresh.pages;
    e = { ...fresh, body: e.body };
    renderPages();
    ed.refreshMedia();
    renderTray();
  };

  const ed = createEditor($("#wrEditor"), {
    markdown: e.body,
    getMedia: (mid) => byId.get(mid),
    onChange: () => { markDirty(); renderCountLater(); renderTrayLater(); },
    pickMedia: () => pickMediaDialog(),
    visibleBand,
    uploadFiles: (files) => files.map((f) => uploadFiles([f], { entryId: id, role: "media" }).then(async (r) => {
      if (!r[0]) throw new Error("上传失败");
      byId.set(r[0].id, r[0]);
      e.media = [...e.media, r[0]];
      return r[0];
    })),
  });
  setUploadTarget({ entryId: id, role: "media", label: "上传后插入到正文", onFiles: (files, ev) => ed.dropFiles(files, ev) });

  // ---------- 标题 ----------
  const title = $("#wrTitle");
  const fit = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  fit();
  title.addEventListener("input", () => { fit(); markDirty(); });
  title.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === "ArrowDown") { ev.preventDefault(); ed.root.focus(); const first = ed.root.firstElementChild; if (first) { const r = document.createRange(); r.setStart(first, 0); getSelection().removeAllRanges(); getSelection().addRange(r); } }
  });

  // ---------- 自动保存 ----------
  // 基准是编辑器实际载入后的内容（而不是服务器原文），没动过就永远不会保存；
  // 每次保存都带上服务器版本的指纹，版本对不上说明别处改过，暂停保存并让用户选择
  const stateEl = $("#wrState");
  const setState = (cls, text) => { stateEl.className = `doc-state ${cls}`; $("span", stateEl).textContent = text; };
  const current = () => ({ body: ed.getMarkdown(), title: title.value.trim() });
  let saved = current();
  let base = bodyHash(e.body ?? "");
  let saving = Promise.resolve(), failTimer, conflicted = false;
  const tooOld = typeof e.body !== "string";  // 服务器还是不支持正文的旧版本
  if (tooOld) setState("err", "服务器版本过旧，正文无法保存，请重启服务");
  const dirty = () => { const c = current(); return c.body !== saved.body || c.title !== saved.title; };
  const save = () => (saving = saving.then(async () => {
    if (conflicted || tooOld) return;
    const c = current();
    if (c.body === saved.body && c.title === saved.title) { setState("ok", "已保存"); return; }
    setState("busy", "保存中…");
    try {
      await api(`/entries/${encodeURIComponent(id)}`, { method: "PATCH", body: { ...c, body_base: base } });
      saved = c;
      base = bodyHash(c.body);
      e.body = c.body;
      const t = new Date();
      setState("ok", `已保存 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`);
    } catch (err) {
      if (err.status === 409) { conflicted = true; setState("err", "有冲突，点此处理"); return resolveConflict(err.data?.body ?? ""); }
      setState("err", `保存失败：${err.message}`);
      clearTimeout(failTimer);
      failTimer = setTimeout(save, 5000);
    }
  }));
  const saveSoon = debounce(save, 800);
  function markDirty() { if (conflicted || tooOld) return; setState("busy", "编辑中…"); saveSoon(); }

  /** 服务器上的正文已被别处修改：让用户决定用哪一份 */
  let latestRemote = "";
  async function resolveConflict(remote) {
    latestRemote = remote;
    const choice = await sheet({
      html: `<div class="sheet-body"><h2>这篇文章在别处被修改过</h2>
          <p class="hint">可能是另一个打开着的页面或 AI 改动了它。为了不互相覆盖，这里已暂停自动保存。</p>
          <p class="hint">服务器上现在有 ${fmtNum(remote.replace(/\s/g, "").length)} 个字符，这里有 ${fmtNum(ed.getMarkdown().replace(/\s/g, "").length)} 个。</p></div>
        <div class="sheet-actions"><button class="btn" data-v="mine">保留这里的内容（覆盖）</button><button class="btn primary" data-v="remote" autofocus>载入最新内容</button></div>`,
      mount: (el, close) => el.addEventListener("click", (ev) => { const b = ev.target.closest("[data-v]"); if (b) close(b.dataset.v); }),
    });
    if (!choice) return;  // 关掉了弹窗：保持暂停，点状态可以再打开
    conflicted = false;
    base = bodyHash(remote);
    if (choice === "remote") {
      ed.setMarkdown(remote);
      e.body = remote;
      saved = { ...current(), title: saved.title };
      setState("ok", "已载入最新内容");
    } else save();
  }
  stateEl.addEventListener("click", () => { if (conflicted) resolveConflict(latestRemote); });

  /** 离开页面时用 keepalive 把最后的修改发出去（同样带版本指纹，旧页面不会覆盖新内容） */
  const flush = () => {
    if (conflicted || tooOld || !dirty()) return;
    fetch(`/api/entries/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current(), body_base: base }), keepalive: true,
    });
  };
  addEventListener("beforeunload", flush);
  addEventListener("pagehide", flush);

  // ---------- 字数 / 未插入的影像 ----------
  const renderCount = () => {
    const n = ed.plainText().replace(/\s/g, "").length;
    const m = ed.usedMedia().size;
    $("#wrCount").textContent = `${fmtNum(n)} 字${m ? ` · ${m} 个影像` : ""}`;
  };
  const renderTray = () => {
    const used = ed.usedMedia();
    const rest = e.media.filter((a) => !used.has(a.id));
    const tray = $("#wrTray");
    tray.hidden = !rest.length;
    if (!rest.length) return;
    tray.innerHTML = `<div class="dt-head">${ICON.image}<span>还有 ${rest.length} 项本篇影像没有放进正文</span><span class="muted">点击插入到光标处</span></div>
      <div class="dt-list">${rest.map((a) => `<button class="dt-item k-${a.kind}" data-id="${a.id}" title="${esc(a.caption || a.original_name)}">
        ${a.thumb ? `<img loading="lazy" src="/thumbs/${a.id}" alt="">` : `<span>${ICON[a.kind] || ICON.file}</span>`}
        ${a.kind === "video" ? `<i>${ICON.play}</i>` : ""}</button>`).join("")}</div>`;
  };
  const renderTrayLater = debounce(renderTray, 300);
  const renderCountLater = debounce(() => renderCount(), 400);  // 字数需要整篇序列化，别每个按键都算
  $("#wrTray").addEventListener("mousedown", (ev) => { if (ev.target.closest(".dt-item")) ev.preventDefault(); });
  $("#wrTray").addEventListener("click", (ev) => {
    const b = ev.target.closest(".dt-item");
    if (b) ed.insertMedia([byId.get(b.dataset.id)]);
  });
  renderCount();
  renderTray();

  // ---------- 插入影像弹窗 ----------
  function pickMediaDialog() {
    let gal;
    let tab = e.media.length ? "entry" : "ungrouped";
    return sheet({
      wide: true,
      html: `<div class="sheet-body">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">插入影像</h2>
            <div class="seg" id="pmSeg"><button data-v="entry">本篇 ${e.media.length}</button><button data-v="ungrouped">未归组</button><button data-v="all">全部图库</button></div></div>
          <p class="hint" id="pmHint"></p>
          <div id="pmGal" style="max-height:58vh;overflow:auto;--tile:116px"></div>
        </div>
        <div class="sheet-actions"><span class="muted" id="pmN" style="margin-right:auto;align-self:center">${HINT}</span>
          <button class="btn" data-close>取消</button><button class="btn primary" data-ok disabled>插入</button></div>`,
      mount: (el, close) => {
        const mk = () => {
          gal?.destroy();
          $$("#pmSeg button", el).forEach((b) => b.classList.toggle("on", b.dataset.v === tab));
          $("#pmHint", el).textContent = tab === "entry" ? "这篇日记的富媒体；已在正文中的也可以再插入一次。" : "图库里的文件插入后会自动归入这篇日记。";
          gal = createGallery($("#pmGal", el), {
            groupByDay: tab !== "entry", showGroup: tab === "all", clickSelects: true,
            fetchPage: (offset) => tab === "entry"
              ? Promise.resolve(offset ? { items: [], total: e.media.length } : { items: e.media, total: e.media.length })
              : api(`/media?limit=120&offset=${offset}${tab === "ungrouped" ? "&ungrouped=1" : ""}`),
            onSelect: (s) => { $("#pmN", el).textContent = s.size ? `已选 ${s.size} 项 · 空格插入` : HINT; $("[data-ok]", el).disabled = !s.size; },
            empty: `<p class="hint" style="padding:30px;text-align:center">${tab === "entry" ? "这篇日记还没有富媒体，可以切到「未归组」挑选，或直接上传。" : "没有可选的文件"}</p>`,
          });
        };
        // 键盘：方向键移动，回车选中 / 取消，空格确认插入
        let cur = 0;
        const tiles = () => $$("#pmGal .tile", el);
        const setCur = (i) => {
          const ts = tiles();
          if (!ts.length) return;
          cur = Math.max(0, Math.min(ts.length - 1, i));
          ts.forEach((t, j) => t.classList.toggle("kfocus", j === cur));
          ts[cur].scrollIntoView({ block: "nearest" });
        };
        /** 当前光标所在行的列数（按 offsetTop 判断换行） */
        const cols = () => {
          const ts = tiles();
          const top = ts[cur]?.offsetTop;
          return Math.max(1, ts.filter((t) => t.offsetTop === top).length);
        };
        new MutationObserver(() => { if (!$(".tile.kfocus", el)) setCur(cur); }).observe($("#pmGal", el), { childList: true, subtree: true });
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
        el.addEventListener("keydown", (ev) => {
          if (ev.target.matches("input, textarea") || ev.isComposing) return;
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols(), ArrowDown: cols() }[ev.key];
          if (step) { ev.preventDefault(); return setCur(cur + step); }
          if (ev.key === "Enter") { ev.preventDefault(); return tiles()[cur]?.click(); }
          if (ev.key === " ") {
            ev.preventDefault();
            if (!gal.selected.size) tiles()[cur]?.click();
            if (gal.selected.size) confirm();
          }
        });
        mk();
        $("#pmSeg", el).addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { tab = b.dataset.v; cur = 0; mk(); el.focus({ preventScroll: true }); } });
        // 鼠标点选后，键盘光标跟到那一格
        $("#pmGal", el).addEventListener("click", (ev) => { const t = ev.target.closest(".tile"); if (t) { const i = tiles().indexOf(t); if (i >= 0) setCur(i); } });
        const confirm = async () => {
          // 选中顺序即插入顺序
          const list = [...gal.selected.values()];
          const foreign = list.filter((a) => a.entry_id !== id || a.role !== "media");
          if (foreign.length) {
            await api("/media/assign", { method: "POST", body: { ids: foreign.map((a) => a.id), entry_id: id, role: "media" } });
            emit("data-changed");
            await reloadEntry();
          }
          close(list.map((a) => byId.get(a.id) || a));
        };
        $("[data-ok]", el).addEventListener("click", confirm);
      },
    }).finally(() => gal?.destroy());
  }
  $("#wrMediaBtn").addEventListener("mousedown", (ev) => ev.preventDefault());
  $("#wrMediaBtn").addEventListener("click", async () => {
    const list = await pickMediaDialog();
    if (list?.length) ed.insertMedia(list);
  });

  // ---------- 更多 ----------
  $("#wrMore").addEventListener("click", () => sheet({
    html: `<div class="menu-list">
        <button data-x="ai">${ICON.ai}复制 AI 转写指令</button>
        <button data-x="md">${ICON.text}查看 / 编辑 Markdown 源码</button>
        <a href="#/e/${esc(id)}" data-x="back">${ICON.entries}返回日记详情</a>
        <button data-close>${ICON.close}关闭</button></div>`,
    mount: (el, close) => {
      $("[data-x=back]", el).addEventListener("click", () => close());
      $("[data-x=ai]", el).addEventListener("click", () => {
        close();
        copy(`请用数字日记连接器处理日记 ${id}：先 get_entry 获取它的纸质原稿 pages，再用 get_media 逐页查看手写内容，`
          + `把纸上的文字逐字转写成正文（保留分段，不要润色或编造）；在合适的位置用单独一行 ![说明](media:附件ID) 插入这篇日记 media 里的照片或视频；`
          + `最后用 update_entry 把 body 写回去。`);
      });
      $("[data-x=md]", el).addEventListener("click", () => { close(); sourceDialog(); });
    },
  }));

  function sourceDialog() {
    sheet({
      wide: true,
      html: `<div class="sheet-body"><h2>Markdown 源码</h2>
          <p class="hint">影像写作单独一行 <code>![说明](media:附件ID)</code>。修改后点「应用」，可以撤销。</p>
          <textarea id="mdSrc" class="mono" rows="18" spellcheck="false" style="font-size:13px;line-height:1.7">${esc(ed.getMarkdown())}</textarea></div>
        <div class="sheet-actions"><button class="btn" id="mdCopy">${ICON.copy}复制</button><span style="flex:1"></span><button class="btn" data-close>取消</button><button class="btn primary" data-ok>应用</button></div>`,
      mount: (el, close) => {
        $("#mdCopy", el).addEventListener("click", () => copy($("#mdSrc", el).value));
        $("[data-ok]", el).addEventListener("click", () => { ed.setMarkdown($("#mdSrc", el).value); close(); toast("已应用"); });
      },
    });
  }

  // ---------- 手机底部工具条 ----------
  const mbar = $("#wrMbar");
  mbar.addEventListener("mousedown", (ev) => ev.preventDefault());
  mbar.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-m]");
    if (!b) return;
    const m = b.dataset.m;
    if (m === "insert") ed.openInsertMenu(b.getBoundingClientRect());
    else if (m === "undo") ed.undo();
    else if (m === "pages") setSide(!side);
    else if (m === "media") { const list = await pickMediaDialog(); if (list?.length) ed.insertMedia(list); }
    else ed.setType(m);
  });
  // 软键盘弹出时，让工具条贴在键盘上方
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    mbar.style.transform = `translateY(${-kb}px)`;
    // 文末留出键盘高度，最后几行也能滚到键盘上方
    document.documentElement.style.setProperty("--kb", `${kb}px`);
  };
  vv?.addEventListener("resize", onVV);
  vv?.addEventListener("scroll", onVV);

  /** 编辑区真正可见的上下边界：顶栏以下、底部工具条（已贴在键盘上方）以上 */
  function visibleBand() {
    const head = $(".doc-top")?.getBoundingClientRect();
    const bar = $("#wrMbar");
    const mb = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect() : null;
    return { top: head ? head.bottom : 0, bottom: mb ? mb.top : Infinity };
  }

  // 新建的空正文：直接把光标放进去
  if (!e.body) setTimeout(() => ed.focusEnd(), 50);

  return () => {
    flush();
    clearTimeout(failTimer);
    removeEventListener("beforeunload", flush);
    removeEventListener("pagehide", flush);
    vv?.removeEventListener("resize", onVV);
    vv?.removeEventListener("scroll", onVV);
    document.documentElement.style.removeProperty("--kb");
    document.body.classList.remove("doc-mode");
    ed.destroy();
  };
}
