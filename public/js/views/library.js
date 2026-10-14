// 图库：相册式浏览全部媒体，多选后分配编号 / 加入日记
import { $, $$, api, ICON, on, debounce, toast, emit, confirmSheet, fmtNum } from "../lib.js";
import { createGallery } from "../gallery.js";
import { openViewer } from "../viewer.js";
import { uploadFiles, pickFiles } from "../upload.js";
import { newEntryDialog, pickEntryDialog } from "../dialogs.js";

const state = { kind: "", q: "" };
const getZoom = () => { try { return Number(localStorage.getItem("lib.zoom")) || 150; } catch { return 150; } };

export async function render({ app, ungrouped = false }) {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>${ungrouped ? "未归组" : "图库"}</h1><div class="sub" id="libSub">&nbsp;</div></div>
      <div class="actions">
        <button class="btn" id="libSelect">${ICON.select}选择</button>
        <button class="btn primary hide-m" id="libUpload">${ICON.upload}上传</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="seg" id="libKind">
        <button data-k="">全部</button><button data-k="image">${ICON.image}照片</button>
        <button data-k="video">${ICON.video}视频</button><button data-k="audio">${ICON.audio}录音</button>
      </div>
      <div class="search">${ICON.search}<input type="search" id="libQ" placeholder="文件名、说明或编号" value=""></div>
      <span class="spacer"></span>
      <label class="zoom" title="缩略图大小">${ICON.image}<input type="range" id="libZoom" min="90" max="260" step="10"></label>
    </div>
    <div id="libGal" style="--tile:${getZoom()}px"></div>`;

  $$("#libKind button").forEach((b) => b.classList.toggle("on", b.dataset.k === state.kind));
  $("#libQ").value = state.q;
  $("#libZoom").value = getZoom();

  const emptyHtml = () => ungrouped
    ? `<div class="empty"><div class="art">${ICON.check}</div><h3>都整理好了</h3><p>所有文件都已归入日记。</p></div>`
    : state.kind || state.q
      ? `<div class="empty"><div class="art">${ICON.search}</div><h3>没有匹配的文件</h3></div>`
      : `<div class="empty"><div class="art">${ICON.library}</div><h3>图库还是空的</h3>
         <p>把照片、视频、录音拖进窗口，或点「上传」。之后多选一组内容，分配一个编号写回纸质日记。</p>
         <button class="btn primary" data-up>${ICON.upload}上传文件</button></div>`;

  let gal;
  const make = () => {
    gal?.destroy();
    gal = createGallery($("#libGal"), {
      fetchPage: async (offset) => {
        const p = new URLSearchParams({ limit: "150", offset: String(offset) });
        if (state.kind) p.set("kind", state.kind);
        if (state.q) p.set("q", state.q);
        if (ungrouped) p.set("ungrouped", "1");
        const r = await api(`/media?${p}`);
        if (!offset) updateSub(r.total);
        return r;
      },
      onOpen: (a, items) => openViewer(items, a.id, { onChanged: refreshSoon }),
      onSelect: renderBar,
      empty: emptyHtml(),
    });
  };
  const updateSub = async (total) => {
    const s = await api("/counts");
    $("#libSub").textContent = ungrouped
      ? `${fmtNum(total)} 个文件尚未归入任何日记`
      : `共 ${fmtNum(total)} 项${state.kind ? "" : ` · ${fmtNum(s.ungrouped)} 项未归组`}`;
  };
  const refreshSoon = debounce(() => make(), 300);
  make();

  // ---------- 工具栏 ----------
  $("#libKind").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.kind = b.dataset.k;
    $$("#libKind button").forEach((x) => x.classList.toggle("on", x === b));
    make();
  });
  $("#libQ").addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); make(); }, 250));
  $("#libZoom").addEventListener("input", (e) => {
    $("#libGal").style.setProperty("--tile", `${e.target.value}px`);
    try { localStorage.setItem("lib.zoom", e.target.value); } catch { /* 忽略 */ }
  });
  const upload = async () => { const f = await pickFiles(); if (f.length) uploadFiles(f); };
  $("#libUpload").addEventListener("click", upload);
  $("#libGal").addEventListener("click", (e) => { if (e.target.closest("[data-up]")) upload(); });
  $("#libSelect").addEventListener("click", () => gal.setSelectMode(!gal.selectMode));

  // ---------- 选择栏 ----------
  const bar = $("#selectBar");
  function renderBar(sel) {
    const mode = gal?.selectMode || sel.size > 0;
    $("#libSelect").innerHTML = mode ? `${ICON.check}完成` : `${ICON.select}选择`;
    if (!mode) { bar.hidden = true; return; }
    const list = [...sel.values()];
    const grouped = list.some((a) => a.entry_id);
    const dis = sel.size ? "" : "disabled";
    bar.hidden = false;
    bar.innerHTML = `<span class="n">${sel.size ? `已选 ${sel.size} 项` : "点选文件"}</span><div class="acts">
      <button class="hl" data-b="new" ${dis}>${ICON.sparkle}分配编号</button>
      <button data-b="add" ${dis}>${ICON.link}加入日记</button>
      <button data-b="page" ${dis}>${ICON.page}作为原稿</button>
      ${grouped ? `<button data-b="unassign">${ICON.unlink}移出日记</button>` : ""}
      <button class="warn" data-b="trash" ${dis}>${ICON.trash}删除</button>
      <button data-b="all">${ICON.select}全选</button>
      <button data-b="cancel" aria-label="取消">${ICON.close}</button></div>`;
  }
  bar.onclick = async (e) => {
    const b = e.target.closest("[data-b]"); if (!b) return;
    const list = [...gal.selected.values()];
    const ids = list.map((a) => a.id);
    const act = b.dataset.b;
    if (act === "cancel") return gal.setSelectMode(false);
    if (act === "all") return gal.selectAll();
    if (act === "new") {
      const entry = await newEntryDialog({ media: list });
      if (!entry) return;
    } else if (act === "add" || act === "page") {
      const r = await pickEntryDialog({ title: act === "page" ? "作为哪篇日记的纸质原稿？" : "加入日记", defaultRole: act === "page" ? "page" : "media", askRole: act !== "page" });
      if (!r) return;
      await api("/media/assign", { method: "POST", body: { ids, entry_id: r.id, role: r.role } });
      toast(`已将 ${ids.length} 项加入 ${r.id}`);
    } else if (act === "unassign") {
      await api("/media/unassign", { method: "POST", body: { ids } });
      toast(`已移出 ${ids.length} 项`);
    } else if (act === "trash") {
      if (!(await confirmSheet(`删除 ${ids.length} 个文件？`, "文件会移入回收站，可以随时恢复。", "移入回收站", true))) return;
      await api("/media/trash", { method: "POST", body: { ids } });
      toast(`已移入回收站`);
    }
    gal.setSelectMode(false);
    emit("data-changed");
    make();
  };

  const off = on("uploaded", refreshSoon);
  const onKey = (e) => {
    if (e.target.matches("input, textarea") || !$("#viewer").hidden || $("#sheetRoot").children.length) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "a") { e.preventDefault(); gal.selectAll(); }
    if (e.key === "Escape" && (gal.selected.size || gal.selectMode)) gal.setSelectMode(false);
  };
  addEventListener("keydown", onKey);
  return () => { off(); gal.destroy(); bar.hidden = true; bar.onclick = null; removeEventListener("keydown", onKey); };
}
