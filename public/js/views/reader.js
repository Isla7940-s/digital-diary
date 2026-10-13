// 阅读：按时间顺序翻阅纸质原稿，每篇下方附上同一编号的富媒体
import { $, $$, api, esc, ICON, fmtDate, weekday } from "../lib.js";
import { tileHtml, hydrateText } from "../gallery.js";
import { openViewer } from "../viewer.js";

const LAST = "reader.last";

export async function render({ app, params: [targetId] }) {
  // 目录：所有已上传原稿的日记，按日期正序
  const list = [];
  for (let offset = 0; ; offset += 500) {
    const r = await api(`/entries?pages=1&limit=500&offset=${offset}`);
    list.push(...r.items);
    if (list.length >= r.total || !r.items.length) break;
  }
  list.reverse();

  if (!list.length) {
    app.innerHTML = `<div class="page-head"><div><h1>阅读</h1></div></div>
      <div class="empty"><div class="art">${ICON.book}</div><h3>还没有可阅读的原稿</h3>
      <p>把纸质日记拍照，在日记详情页的「纸质原稿」里上传；或在图库里选中照片，点「作为原稿」。</p>
      <a class="btn" href="#/entries">去日记列表</a></div>`;
    return;
  }

  let toc = "", lastMonth = "";
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (m !== lastMonth) { lastMonth = m; toc += `<h4>${m.slice(0, 4)}年${+m.slice(5)}月</h4>`; }
    toc += `<a href="#/read/${esc(e.id)}" data-id="${esc(e.id)}"><span class="dd">${+e.date.slice(8)}日</span><span class="tt">${esc(e.title || e.id)}</span><span class="pp">${esc(e.id)} · ${e.page_count} 页</span></a>`;
  }
  const totalPages = list.reduce((t, e) => t + e.page_count, 0);
  app.innerHTML = `
    <div class="page-head">
      <div><h1>阅读</h1><div class="sub">${list.length} 篇日记 · ${totalPages} 页原稿</div></div>
      <div class="actions"><button class="btn toc-toggle" id="tocBtn">${ICON.list}目录</button></div>
    </div>
    <div class="reader">
      <nav class="toc" id="toc">${toc}</nav>
      <div class="book" id="book">${list.map((e) => `<article class="chapter" id="ch-${esc(e.id)}" data-id="${esc(e.id)}" style="min-height:${Math.min(e.page_count, 3) * 600}px"></article>`).join("")}</div>
    </div>`;

  const loaded = new Map();
  const fill = async (el) => {
    const id = el.dataset.id;
    if (loaded.has(id)) return;
    loaded.set(id, null);
    const e = await api(`/entries/${encodeURIComponent(id)}`);
    loaded.set(id, e);
    el.style.minHeight = "";
    el.innerHTML = `
      <header class="chapter-head">
        <span class="cw">${weekday(e.date)}</span>
        <span class="cd">${fmtDate(e.date)}</span>
        ${e.title ? `<span class="ct">${esc(e.title)}</span>` : ""}
        <a class="idpill" href="#/e/${esc(e.id)}">${esc(e.id)}</a>
        <span class="orn"></span>
      </header>
      ${e.pages.map((p, i) => `<figure class="sheet-page" data-page="${p.id}" style="margin-left:auto;margin-right:auto${p.width && p.height ? `;aspect-ratio:${p.width}/${p.height}` : ""}">
        <img loading="lazy" src="/files/${p.id}" alt="第 ${i + 1} 页"><span class="pno">${i + 1} / ${e.pages.length}</span></figure>`).join("")}
      ${e.media.length ? `<div class="mixin">
        <div class="mh">${ICON.image}<span>同一篇日记的影像 · ${e.media.length} 项</span><span class="grow"></span><span style="font-size:12px">图文混排将在后续版本支持</span></div>
        <div class="grid">${e.media.map((a) => tileHtml(a, { showGroup: false })).join("")}</div></div>` : ""}`;
    hydrateText(el);
  };

  const book = $("#book");
  book.addEventListener("click", (ev) => {
    const ch = ev.target.closest(".chapter");
    const e = ch && loaded.get(ch.dataset.id);
    if (!e) return;
    const pg = ev.target.closest(".sheet-page");
    if (pg) return openViewer(e.pages, pg.dataset.page);
    const t = ev.target.closest(".tile");
    if (t) openViewer(e.media, t.dataset.id);
  });

  // 懒加载章节
  const lazy = new IntersectionObserver((es) => es.forEach((x) => x.isIntersecting && fill(x.target)), { rootMargin: "1200px 0px" });
  $$(".chapter", book).forEach((c) => lazy.observe(c));

  // 目录高亮 + 记住阅读位置
  const setActive = (id) => {
    $$("#toc a").forEach((a) => a.classList.toggle("on", a.dataset.id === id));
    $(`#toc a[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    try { localStorage.setItem(LAST, id); } catch { /* 忽略 */ }
  };
  const spy = new IntersectionObserver((es) => {
    const vis = es.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) setActive(vis.target.dataset.id);
  }, { rootMargin: "-20% 0px -60% 0px" });
  $$(".chapter", book).forEach((c) => spy.observe(c));

  const jump = async (id) => {
    const el = document.getElementById(`ch-${id}`);
    if (!el) return;
    await fill(el);
    el.scrollIntoView({ block: "start" });
    setActive(id);
  };
  $("#toc").addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-id]"); if (!a) return;
    ev.preventDefault();
    history.replaceState(null, "", `#/read/${a.dataset.id}`);
    $("#toc").classList.remove("open");
    jump(a.dataset.id);
  });
  $("#tocBtn").addEventListener("click", () => $("#toc").classList.toggle("open"));

  let start = targetId;
  if (!start) { try { start = localStorage.getItem(LAST); } catch { /* 忽略 */ } }
  if (start && list.some((e) => e.id === start)) requestAnimationFrame(() => jump(start));
  else setActive(list[0].id);

  return () => { lazy.disconnect(); spy.disconnect(); };
}
