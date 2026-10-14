// 日记详情（原稿与影像）：编号与二维码、纸质原稿、富媒体组、备注；顶部可切换到「转写」
import { $, api, esc, entryHead, ICON, on, debounce, toast, emit, copy, confirmSheet, fmtDate, weekday, parseTags } from "../lib.js";
import { createGallery } from "../gallery.js";
import { openViewer } from "../viewer.js";
import { uploadFiles, pickFiles } from "../upload.js";
import { pickEntryDialog, pickFromLibraryDialog } from "../dialogs.js";
import { setUploadTarget } from "../main.js";

export async function render({ app, params: [rawId] }) {
  let e;
  try { e = await api(`/entries/${encodeURIComponent(rawId)}`); }
  catch (err) {
    if (err.status !== 404) throw err;
    app.innerHTML = `<div class="empty"><div class="art">${ICON.search}</div><h3>找不到编号 <span class="idpill">${esc(rawId)}</span></h3>
      <p>检查一下纸上的编号是否写对了。</p><div style="display:flex;gap:8px"><a class="btn" href="#/">返回图库</a><a class="btn" href="#/entries">全部日记</a></div></div>`;
    return;
  }
  // 文章没有详情页，直接进编辑页
  if (e.kind === "article") { location.replace(`#/a/${encodeURIComponent(e.id)}`); return; }
  const id = e.id;
  const trashed = !!e.deleted_at;
  setUploadTarget({ entryId: id, role: "media", label: `将加入 ${id} 的富媒体` });
  document.body.classList.add("entry-mode");  // 与「转写」页共用顶栏布局，切换时不跳动

  app.innerHTML = `
    ${entryHead(id, "e", {
      right: `<a class="btn sm ghost" href="#/read/${encodeURIComponent(id)}">${ICON.book}<span>阅读</span></a>`,
    })}
    ${trashed ? `<div class="trash-banner"><span>这篇日记在回收站中，内容暂时隐藏。</span><button class="btn sm" id="enRestore">恢复</button></div>` : ""}
    <section class="card hero">
      <div style="min-width:0">
        <div class="eyebrow">${fmtDate(e.date)} · ${weekday(e.date)}</div>
        <div class="big-id">${esc(id)}<button class="btn sm ghost" id="copyId" title="复制编号">${ICON.copy}</button></div>
        <input class="title-input" type="text" id="enTitle" value="${esc(e.title)}" placeholder="给这篇日记起个标题…" maxlength="200" ${trashed ? "disabled" : ""}>
        <div class="meta-row">
          ${ICON.tag}<input class="tags-input" type="text" id="enTags" value="${esc(e.tags.join(" "))}" placeholder="标签，空格分隔" ${trashed ? "disabled" : ""}>
          <span class="save-state" id="saveState"></span>
        </div>
      </div>
      <div class="qr-card">
        <img src="/api/qr/${encodeURIComponent(id)}.svg" alt="编号二维码">
      </div>
    </section>

    <div class="section-title">
      <h2>${ICON.page}纸质原稿 <span class="count" id="pgCount"></span></h2><span class="grow"></span>
      ${e.pages.length ? `<a class="btn sm" href="#/read/${encodeURIComponent(id)}">${ICON.book}阅读</a>` : ""}
      ${trashed ? "" : `<button class="btn sm" id="pgFromLib">${ICON.library}从图库选择</button>`}
    </div>
    <div class="pages-strip" id="pages"></div>

    <div class="section-title">
      <h2>${ICON.image}富媒体 <span class="count" id="mdCount"></span></h2><span class="grow"></span>
      ${trashed ? "" : `<button class="btn sm" id="mdFromLib">${ICON.library}从图库添加</button><button class="btn sm primary" id="mdUpload">${ICON.upload}上传</button>`}
    </div>
    <div id="mdGal" style="--tile:150px"></div>

    <div class="section-title"><h2>${ICON.text}备注</h2></div>
    <div class="card note-card"><textarea id="enNote" rows="4" placeholder="可选：不属于正文的补充说明，例如写作背景、待补的内容…" ${trashed ? "disabled" : ""}>${esc(e.note)}</textarea></div>

    ${trashed ? "" : `<div style="display:flex;justify-content:flex-end;margin-top:28px"><button class="btn danger sm" id="enDelete">${ICON.trash}删除这篇日记</button></div>`}`;


  // ---------- 基本信息 ----------
  $("#copyId").addEventListener("click", () => copy(id));
  $("#enRestore")?.addEventListener("click", async () => { await api(`/entries/${id}/restore`, { method: "POST" }); emit("data-changed"); toast("已恢复"); dispatchEvent(new HashChangeEvent("hashchange")); });
  const state = $("#saveState");
  const save = debounce(async () => {
    try {
      await api(`/entries/${id}`, { method: "PATCH", body: { title: $("#enTitle").value, note: $("#enNote").value, tags: parseTags($("#enTags").value) } });
      state.textContent = "已保存";
    } catch (err) { state.textContent = `保存失败：${err.message}`; }
  }, 600);
  for (const sel of ["#enTitle", "#enTags", "#enNote"]) $(sel).addEventListener("input", () => { state.textContent = "保存中…"; save(); });
  $("#enDelete")?.addEventListener("click", async () => {
    if (!(await confirmSheet(`删除 ${id}？`, "日记连同其中的原稿和媒体会移入回收站，可以随时恢复。编号不会被重复使用。", "移入回收站", true))) return;
    await api(`/entries/${id}`, { method: "DELETE" });
    emit("data-changed");
    toast("已移入回收站");
    location.hash = "#/entries";
  });

  // ---------- 纸质原稿 ----------
  let pages = e.pages;
  const renderPages = () => {
    $("#pgCount").textContent = pages.length ? `${pages.length} 页` : "";
    $("#pages").innerHTML = pages.map((a, i) => `<div class="page-thumb" data-id="${a.id}">
        <div class="paper">${a.thumb ? `<img loading="lazy" src="/thumbs/${a.id}" alt="">` : ""}</div>
        <div class="pn">${trashed ? "" : `<button data-mv="-1" title="前移">‹</button>`}第 ${i + 1} 页${trashed ? "" : `<button data-mv="1" title="后移">›</button>`}</div>
      </div>`).join("")
      + (trashed ? "" : `<div class="page-add" id="pgAdd">${ICON.plus}<span>上传原稿照片</span><small class="muted">可多选，按顺序排列</small></div>`);
  };
  renderPages();
  const reloadEntry = async () => {
    const fresh = await api(`/entries/${encodeURIComponent(id)}`);
    pages = fresh.pages;
    renderPages();
    mediaGal.reload();
  };
  $("#pages").addEventListener("click", async (ev) => {
    if (ev.target.closest("#pgAdd")) {
      const files = await pickFiles({ accept: "image/*" });
      if (!files.length) return;
      // 按文件名排序，保证页序
      await uploadFiles(files.sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true })), { entryId: id, role: "page" });
      return reloadEntry();
    }
    const mv = ev.target.closest("[data-mv]");
    const card = ev.target.closest(".page-thumb");
    if (!card) return;
    const i = pages.findIndex((p) => p.id === card.dataset.id);
    if (mv) {
      const j = i + Number(mv.dataset.mv);
      if (j < 0 || j >= pages.length) return;
      [pages[i], pages[j]] = [pages[j], pages[i]];
      renderPages();
      await api(`/entries/${id}/order`, { method: "PUT", body: { ids: pages.map((p) => p.id) } });
      return;
    }
    if (ev.target.closest(".paper")) openViewer(pages, card.dataset.id, { onChanged: reloadEntry });
  });
  $("#pgFromLib")?.addEventListener("click", async () => {
    const list = await pickFromLibraryDialog({ title: "选择原稿照片", role: "page" });
    if (!list?.length) return;
    await api("/media/assign", { method: "POST", body: { ids: list.map((a) => a.id), entry_id: id, role: "page" } });
    toast(`已添加 ${list.length} 页原稿`);
    emit("data-changed");
    reloadEntry();
  });

  // ---------- 富媒体 ----------
  const mediaGal = createGallery($("#mdGal"), {
    groupByDay: false, showGroup: false, selectable: !trashed,
    fetchPage: async (offset) => {
      if (offset) return { items: [], total: 0 };
      const fresh = await api(`/entries/${encodeURIComponent(id)}`);
      $("#mdCount").textContent = fresh.media.length ? `${fresh.media.length} 项` : "";
      return { items: fresh.media, total: fresh.media.length };
    },
    onOpen: (a, items) => openViewer(items, a.id, { onChanged: reloadEntry }),
    onSelect: (sel) => renderBar(sel),
    empty: `<div class="empty" style="padding:36px"><div class="art">${ICON.image}</div><h3>还没有富媒体</h3><p>拖入文件，或从图库挑选这一天的照片、视频和录音。</p></div>`,
  });
  $("#mdUpload")?.addEventListener("click", async () => {
    const files = await pickFiles();
    if (files.length) { await uploadFiles(files, { entryId: id, role: "media" }); reloadEntry(); }
  });
  $("#mdFromLib")?.addEventListener("click", async () => {
    const list = await pickFromLibraryDialog({ title: `添加到 ${id}` });
    if (!list?.length) return;
    await api("/media/assign", { method: "POST", body: { ids: list.map((a) => a.id), entry_id: id, role: "media" } });
    toast(`已添加 ${list.length} 项`);
    emit("data-changed");
    reloadEntry();
  });

  const bar = $("#selectBar");
  function renderBar(sel) {
    if (!sel.size) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<span class="n">已选 ${sel.size} 项</span><div class="acts">
      <button data-b="page">${ICON.page}改为原稿</button>
      <button data-b="move">${ICON.link}移到其他日记</button>
      <button data-b="unassign">${ICON.unlink}移出（回到图库）</button>
      <button class="warn" data-b="trash">${ICON.trash}删除</button>
      <button data-b="cancel" aria-label="取消">${ICON.close}</button></div>`;
  }
  bar.onclick = async (ev) => {
    const b = ev.target.closest("[data-b]"); if (!b) return;
    const ids = [...mediaGal.selected.keys()];
    const act = b.dataset.b;
    if (act === "cancel") return mediaGal.clearSelection();
    if (act === "page") await api("/media/assign", { method: "POST", body: { ids, entry_id: id, role: "page" } });
    else if (act === "move") {
      const r = await pickEntryDialog({ title: "移到其他日记", exclude: id });
      if (!r) return;
      await api("/media/assign", { method: "POST", body: { ids, entry_id: r.id, role: r.role } });
    } else if (act === "unassign") await api("/media/unassign", { method: "POST", body: { ids } });
    else if (act === "trash") {
      if (!(await confirmSheet(`删除 ${ids.length} 个文件？`, "文件会移入回收站，可以随时恢复。", "移入回收站", true))) return;
      await api("/media/trash", { method: "POST", body: { ids } });
    }
    mediaGal.clearSelection();
    emit("data-changed");
    reloadEntry();
  };

  const off = on("uploaded", (ev) => { if (ev.detail?.entry_id === id) debounceReload(); });
  const debounceReload = debounce(reloadEntry, 500);
  return () => { off(); mediaGal.destroy(); bar.hidden = true; bar.onclick = null; };
}
