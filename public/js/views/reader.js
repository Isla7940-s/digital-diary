// 阅读：按时间顺序翻阅日记。「转写」模式显示图文混排的正文，「原稿」模式翻阅手写页的照片；
// 没有放进正文的影像附在每篇末尾
import { $, $$, api, esc, ICON, fmtDate, weekday, imgAttrs } from "../lib.js";
import { tileHtml, hydrateText } from "../gallery.js";
import { openViewer } from "../viewer.js";
import { renderProse, hydrateProse } from "../prose.js";
import { refsOf } from "../md.js";

const LAST = "reader.last";
const MODE = "reader.mode";

export async function render({ app, params: [targetId] }) {
  // 目录：有原稿或正文的日记，最新的在前
  const list = [];
  for (let offset = 0; ; offset += 500) {
    const r = await api(`/entries?readable=1&limit=500&offset=${offset}`);
    list.push(...r.items);
    if (list.length >= r.total || !r.items.length) break;
  }

  if (!list.length) {
    app.innerHTML = `<div class="page-head"><div><h1>阅读</h1></div></div>
      <div class="empty"><div class="art">${ICON.book}</div><h3>还没有可阅读的日记</h3>
      <p>在日记详情页上传纸质原稿的照片，或者把纸上的文字转写成正文（可以和照片混排）。</p>
      <a class="btn" href="#/entries">去日记列表</a></div>`;
    return;
  }

  let mode = "text";
  try { mode = localStorage.getItem(MODE) === "page" ? "page" : "text"; } catch { /* 忽略 */ }

  // 目录：按月分组的时间线
  const months = new Map();
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(e);
  }
  let toc = "";
  for (const [m, es] of months) {
    toc += `<section class="toc-m"><h4><b>${+m.slice(5)}月</b><span>${m.slice(0, 4)}</span><em>${es.length} 篇</em></h4>`;
    for (const e of es) {
      const info = [e.id, e.body_chars ? `${e.body_chars} 字` : "未转写", e.page_count ? `${e.page_count} 页` : ""].filter(Boolean).join(" · ");
      toc += `<a class="toc-e" href="#/read/${esc(e.id)}" data-id="${esc(e.id)}">
        <span class="d"><b>${+e.date.slice(8)}</b><small>${weekday(e.date)}</small></span>
        <span class="t">${esc(e.title || e.excerpt || "未命名")}</span><span class="m">${esc(info)}</span></a>`;
    }
    toc += `</section>`;
  }
  const totalPages = list.reduce((t, e) => t + e.page_count, 0);
  const written = list.filter((e) => e.body_chars).length;
  app.innerHTML = `
    <div class="page-head">
      <div><h1>阅读</h1><div class="sub">${list.length} 篇日记 · ${written} 篇已转写 · ${totalPages} 页原稿</div></div>
      <div class="actions">
        <div class="seg" id="modeSeg"><button data-v="text">${ICON.text}转写</button><button data-v="page">${ICON.page}原稿</button></div>
        <button class="btn toc-toggle" id="tocBtn">${ICON.list}目录</button>
      </div>
    </div>
    <div class="reader">
      <nav class="toc" id="toc">
        <div class="toc-head"><b>目录</b><span>${list.length} 篇</span><button class="icon-btn" id="tocClose" aria-label="关闭目录">${ICON.close}</button></div>
        <div class="toc-list">${toc}</div>
      </nav>
      <div class="toc-back" id="tocBack" hidden></div>
      <div class="book" id="book">${list.map((e) => `<article class="chapter" id="ch-${esc(e.id)}" data-id="${esc(e.id)}" style="min-height:${Math.max(Math.min(e.page_count, 3) * 600, e.body_chars ? 500 : 0)}px"></article>`).join("")}</div>
    </div>`;

  const loaded = new Map();

  /** 一篇日记在当前模式下显示的内容；返回点击影像时可翻看的列表 */
  const chapterHtml = (e, m) => {
    const byId = new Map([...e.media, ...e.pages].map((a) => [a.id, a]));
    const useText = e.body && (m === "text" || !e.pages.length);
    const used = new Set(useText ? refsOf(e.body) : []);
    const rest = e.media.filter((a) => !used.has(a.id));
    let main;
    if (useText) {
      main = `<div class="prose reading">${renderProse(e.body, byId)}</div>`;
    } else if (e.pages.length) {
      main = e.pages.map((p, i) => `<figure class="sheet-page" data-page="${p.id}" style="margin-left:auto;margin-right:auto${p.width && p.height ? `;aspect-ratio:${p.width}/${p.height}` : ""}">
        <img loading="lazy" decoding="async" ${imgAttrs(p, "(max-width: 860px) 100vw, 860px")} alt="第 ${i + 1} 页"><span class="pno">${i + 1} / ${e.pages.length}</span></figure>`).join("");
      if (!e.body) main += `<p class="chapter-note">这篇还没有转写。<a href="#/write/${esc(e.id)}">去转写 →</a></p>`;
    } else main = "";
    const switchHint = useText && e.pages.length ? `<button class="btn sm ghost" data-flip="page">${ICON.page}看原稿 ${e.pages.length} 页</button>`
      : !useText && e.body ? `<button class="btn sm ghost" data-flip="text">${ICON.text}看转写</button>` : "";
    return `
      <header class="chapter-head">
        <span class="cw">${weekday(e.date)}</span>
        <span class="cd">${fmtDate(e.date)}</span>
        ${e.title ? `<span class="ct">${esc(e.title)}</span>` : ""}
        <span class="cm"><a class="idpill" href="#/e/${esc(e.id)}">${esc(e.id)}</a>${switchHint}</span>
        <span class="orn"></span>
      </header>
      ${main}
      ${rest.length ? `<div class="mixin">
        <div class="mh">${ICON.image}<span>${useText ? "未放进正文的影像" : "同一篇日记的影像"} · ${rest.length} 项</span><span class="grow"></span>
          ${useText ? "" : e.body ? "" : `<a href="#/write/${esc(e.id)}" style="font-size:12px">在正文中图文混排 →</a>`}</div>
        <div class="grid">${rest.map((a) => tileHtml(a, { showGroup: false })).join("")}</div></div>` : ""}`;
  };

  const fill = async (el, force = false) => {
    const id = el.dataset.id;
    if (loaded.has(id) && !force) return;
    if (!loaded.get(id)) {
      loaded.set(id, null);
      loaded.set(id, await api(`/entries/${encodeURIComponent(id)}`));
    }
    const e = loaded.get(id);
    el.style.minHeight = "";
    el.innerHTML = chapterHtml(e, el.dataset.flip || mode);
    hydrateText(el);
    hydrateProse(el);
  };

  const book = $("#book");
  book.addEventListener("click", (ev) => {
    const ch = ev.target.closest(".chapter");
    const e = ch && loaded.get(ch.dataset.id);
    if (!e) return;
    const flip = ev.target.closest("[data-flip]");
    if (flip) { ch.dataset.flip = flip.dataset.flip; return fill(ch, true); }
    const pg = ev.target.closest(".sheet-page");
    if (pg) return openViewer(e.pages, pg.dataset.page);
    const t = ev.target.closest(".tile");
    if (t) return openViewer(e.media, t.dataset.id);
    const f = ev.target.closest(".pm[data-id]");
    if (f && !ev.target.closest("video, audio, a")) {
      const shown = $$(".pm[data-id]", ch).map((x) => x.dataset.id);
      const items = [...new Set(shown)].map((id) => [...e.media, ...e.pages].find((a) => a.id === id)).filter(Boolean);
      openViewer(items, f.dataset.id);
    }
  });

  // 切换模式：重新渲染已加载的章节
  const renderSeg = () => $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
  renderSeg();
  $("#modeSeg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.dataset.v === mode) return;
    mode = b.dataset.v;
    try { localStorage.setItem(MODE, mode); } catch { /* 忽略 */ }
    renderSeg();
    $$(".chapter", book).forEach((c) => { delete c.dataset.flip; if (loaded.get(c.dataset.id)) fill(c, true); });
  });

  // 懒加载章节
  const lazy = new IntersectionObserver((es) => es.forEach((x) => x.isIntersecting && fill(x.target)), { rootMargin: "1200px 0px" });
  $$(".chapter", book).forEach((c) => lazy.observe(c));

  // 目录高亮 + 记住阅读位置
  const tocList = $(".toc-list");
  /** 只滚动目录列表本身（scrollIntoView 会连带滚动整页） */
  const revealActive = () => {
    const a = $("#toc a.on");
    if (!a || !tocList.clientHeight) return;
    const lr = tocList.getBoundingClientRect(), ar = a.getBoundingClientRect();
    if (ar.top < lr.top + 36 || ar.bottom > lr.bottom - 8) tocList.scrollTop += ar.top - lr.top - lr.height / 3;
  };
  const setActive = (id) => {
    $$("#toc a").forEach((a) => a.classList.toggle("on", a.dataset.id === id));
    revealActive();
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
    setToc(false);
    jump(a.dataset.id);
  });
  // 手机：目录是底部抽屉
  const setToc = (open) => {
    $("#toc").classList.toggle("open", open);
    $("#tocBack").hidden = !open;
    if (open) requestAnimationFrame(revealActive);
  };
  $("#tocBtn").addEventListener("click", () => setToc(!$("#toc").classList.contains("open")));
  $("#tocClose").addEventListener("click", () => setToc(false));
  $("#tocBack").addEventListener("click", () => setToc(false));

  let start = targetId;
  if (!start) { try { start = localStorage.getItem(LAST); } catch { /* 忽略 */ } }
  if (start && list.some((e) => e.id === start)) requestAnimationFrame(() => jump(start));
  else setActive(list[0].id);

  return () => { lazy.disconnect(); spy.disconnect(); };
}
