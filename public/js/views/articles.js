// 文章列表：不对应纸质本的独立文章，点开直接进入编辑页（没有单独的查看页）
import { $, api, esc, ICON, debounce, toast, emit, fmtDate, fmtNum } from "../lib.js";

/** 2026-10-14T08:03:00Z → 今天 16:03 / 10月12日 / 2025年3月1日 */
function when(iso) {
  const d = new Date(iso), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const row = (e) => `<a class="arow" href="#/a/${encodeURIComponent(e.id)}">
    <div class="ar-main">
      <div class="ar-title ${e.title ? "" : "none"}">${esc(e.title || "未命名")}</div>
      ${e.excerpt ? `<div class="ar-ex">${esc(e.excerpt)}</div>` : ""}
      <div class="ar-meta"><span>${when(e.updated_at)} 编辑</span><span>${fmtDate(e.date, false)} 创建</span>
        <span>${fmtNum(e.body_chars)} 字</span>${e.media_count ? `<span>${ICON.image}${e.media_count}</span>` : ""}</div>
    </div>
    ${e.cover ? `<img class="ar-cover" loading="lazy" src="/thumbs/${e.cover.id}" alt="">` : ""}
  </a>`;

export async function render({ app }) {
  let q = "";
  app.innerHTML = `
    <div class="page-head">
      <div><h1>文章</h1><div class="sub" id="arSub">&nbsp;</div></div>
      <div class="actions"><button class="btn primary" id="arNew">${ICON.plus}新建文章</button></div>
    </div>
    <div class="toolbar">
      <div class="search">${ICON.search}<input type="search" id="arQ" placeholder="标题、正文…"></div>
    </div>
    <div class="alist" id="arList"></div>
    <div class="load-sentinel" id="arMore"></div>`;

  let offset = 0, total = Infinity, loading = false, gen = 0;
  const list = $("#arList");
  const load = async (reset) => {
    if (reset) { gen++; offset = 0; total = Infinity; loading = false; list.innerHTML = ""; }
    if (loading || offset >= total) return;
    loading = true;
    const my = gen;
    const p = new URLSearchParams({ kind: "article", limit: "40", offset: String(offset) });
    if (q) p.set("q", q);
    const r = await api(`/entries?${p}`);
    if (my !== gen) return;
    total = r.total; offset += r.items.length; loading = false;
    $("#arSub").textContent = q ? `找到 ${fmtNum(total)} 篇` : `共 ${fmtNum(total)} 篇 · 按最近编辑排序`;
    list.insertAdjacentHTML("beforeend", r.items.map(row).join(""));
    if (!total) {
      list.innerHTML = q
        ? `<div class="empty"><div class="art">${ICON.search}</div><h3>没有找到匹配的文章</h3></div>`
        : `<div class="empty"><div class="art">${ICON.pen}</div><h3>还没有文章</h3>
          <p>文章不对应纸质本，适合随手写点东西，也可以插入图库里的照片和视频。</p>
          <button class="btn primary" data-new>${ICON.plus}写第一篇</button></div>`;
    }
  };
  const io = new IntersectionObserver((es) => es[0].isIntersecting && load(false), { rootMargin: "600px" });
  io.observe($("#arMore"));
  load(true);

  let creating = false;
  const create = async () => {
    if (creating) return;
    creating = true;
    try {
      const e = await api("/entries", { method: "POST", body: { kind: "article" } });
      emit("data-changed");
      location.hash = `#/a/${encodeURIComponent(e.id)}`;
    } catch (err) { toast(`新建失败：${err.message}`); creating = false; }
  };
  $("#arNew").addEventListener("click", create);
  list.addEventListener("click", (ev) => { if (ev.target.closest("[data-new]")) create(); });
  $("#arQ").addEventListener("input", debounce((ev) => { q = ev.target.value.trim(); load(true); }, 250));
  return () => io.disconnect();
}
