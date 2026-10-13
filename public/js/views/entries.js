// 日记列表：每张卡片对应一个编号（一篇纸质日记）
import { $, $$, api, esc, ICON, debounce, fmtDate, weekday, fmtNum } from "../lib.js";
import { newEntryDialog } from "../dialogs.js";

const state = { tag: "", month: "" };

export function entryCard(e) {
  const imgs = e.preview.slice(0, 3);
  const cover = imgs.length
    ? `<div class="cover n${Math.min(imgs.length, 3)}">${imgs.map((a) => `<img loading="lazy" src="/thumbs/${a.id}" alt="">`).join("")}</div>`
    : e.cover ? `<div class="cover n1"><img loading="lazy" src="/thumbs/${e.cover.id}" alt=""></div>`
      : `<div class="cover none">${ICON.entries}</div>`;
  const s = [];
  if (e.page_count) s.push(`<span>${ICON.page}${e.page_count} 页原稿</span>`);
  if (e.counts.image) s.push(`<span>${ICON.image}${e.counts.image}</span>`);
  if (e.counts.video) s.push(`<span>${ICON.video}${e.counts.video}</span>`);
  if (e.counts.audio) s.push(`<span>${ICON.audio}${e.counts.audio}</span>`);
  if (e.counts.text + e.counts.file) s.push(`<span>${ICON.file}${e.counts.text + e.counts.file}</span>`);
  return `<a class="card ecard" href="#/e/${esc(e.id)}">${cover}
    <div class="body">
      <div class="top"><span class="idpill">${esc(e.id)}</span><span class="date">${fmtDate(e.date, false)} ${weekday(e.date)}</span></div>
      <div class="title ${e.title ? "" : "none"}">${esc(e.title || "未命名")}</div>
      <div class="stats-line">${s.join("") || "<span>还没有内容</span>"}</div>
      ${e.tags.length ? `<div class="stats-line">${e.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
    </div></a>`;
}

export async function render({ app, query }) {
  let q = query.get("q") || "";
  app.innerHTML = `
    <div class="page-head">
      <div><h1>日记</h1><div class="sub" id="enSub">&nbsp;</div></div>
      <div class="actions"><button class="btn primary" id="enNew">${ICON.plus}新建日记</button></div>
    </div>
    <div class="toolbar">
      <div class="search">${ICON.search}<input type="search" id="enQ" placeholder="编号、标题、标签、备注…" value="${esc(q)}"></div>
      <select id="enMonth" style="width:auto" title="按月筛选"><option value="">全部月份</option></select>
      <span class="spacer"></span>
    </div>
    <div class="toolbar" id="enTags"></div>
    <div class="entry-grid" id="enGrid"></div>
    <div class="load-sentinel" id="enMore"></div>`;

  let offset = 0, total = Infinity, loading = false, gen = 0, lastMonth = null;
  const grid = $("#enGrid");
  const load = async (reset) => {
    if (reset) { gen++; offset = 0; total = Infinity; loading = false; lastMonth = null; grid.innerHTML = ""; }
    if (loading || offset >= total) return;
    loading = true;
    const my = gen;
    const p = new URLSearchParams({ limit: "36", offset: String(offset) });
    if (q) p.set("q", q);
    if (state.tag) p.set("tag", state.tag);
    if (state.month) {
      const [y, m] = state.month.split("-").map(Number);
      p.set("from", `${state.month}-01`);
      p.set("to", `${state.month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`);
    }
    const r = await api(`/entries?${p}`);
    if (my !== gen) return;
    total = r.total; offset += r.items.length; loading = false;
    $("#enSub").textContent = q || state.tag || state.month ? `找到 ${fmtNum(total)} 篇` : `共 ${fmtNum(total)} 篇纸质日记已编号`;
    let html = "";
    for (const e of r.items) {
      const m = e.date.slice(0, 7);
      if (m !== lastMonth) { lastMonth = m; html += `<div class="month-label">${m.slice(0, 4)}年${+m.slice(5)}月</div>`; }
      html += entryCard(e);
    }
    grid.insertAdjacentHTML("beforeend", html);
    if (!total) {
      grid.innerHTML = q || state.tag || state.month
        ? `<div class="empty" style="grid-column:1/-1"><div class="art">${ICON.search}</div><h3>没有找到匹配的日记</h3></div>`
        : `<div class="empty" style="grid-column:1/-1"><div class="art">${ICON.entries}</div><h3>还没有日记</h3>
          <p>在图库里选中一组照片、视频或录音，点「分配编号」；或先点「新建日记」拿到编号，写在纸质本上。</p></div>`;
    }
  };
  const io = new IntersectionObserver((es) => es[0].isIntersecting && load(false), { rootMargin: "600px" });
  io.observe($("#enMore"));
  load(true);

  // 月份下拉：从第一篇日记到本月
  api("/stats").then((st) => {
    if (!st.first_entry) return;
    const opts = [];
    const d = new Date(), end = st.first_entry.slice(0, 7);
    for (let i = 0; i < 240; i++) {
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      opts.push(`<option value="${m}" ${m === state.month ? "selected" : ""}>${d.getFullYear()}年${d.getMonth() + 1}月</option>`);
      if (m <= end) break;
      d.setDate(1); d.setMonth(d.getMonth() - 1);
    }
    $("#enMonth").insertAdjacentHTML("beforeend", opts.join(""));
  });
  const tags = await api("/tags");
  $("#enTags").innerHTML = tags.length ? tags.map((t) => `<button class="chip ${t.tag === state.tag ? "on" : ""}" data-t="${esc(t.tag)}">#${esc(t.tag)}<span class="n">${t.count}</span></button>`).join("") : "";
  $("#enTags").hidden = !tags.length;
  $("#enTags").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.tag = state.tag === b.dataset.t ? "" : b.dataset.t;
    $$(".chip", $("#enTags")).forEach((c) => c.classList.toggle("on", c.dataset.t === state.tag));
    load(true);
  });
  $("#enQ").addEventListener("input", debounce((e) => { q = e.target.value.trim(); load(true); }, 250));
  $("#enMonth").addEventListener("change", (e) => { state.month = e.target.value; load(true); });
  $("#enNew").addEventListener("click", () => newEntryDialog());
  return () => io.disconnect();
}
