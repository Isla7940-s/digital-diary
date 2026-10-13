// 相册式网格：按天分组、无限滚动、多选（Shift 连选 / 手机长按）
import { $, $$, esc, ICON, fmtDur, fmtDay, weekday, extOf, waveSvg } from "./lib.js";

export function tileHtml(a, { showGroup = true } = {}) {
  const cls = ["tile", a.kind, a.caption ? "has-caption" : ""].join(" ");
  const group = showGroup && a.entry_id ? `<span class="tl ${a.role === "page" ? "page" : ""}">${esc(a.entry_id)}</span>` : "";
  const check = `<span class="check">${ICON.check}</span>`;
  const attrs = `class="${cls}" data-id="${a.id}" title="${esc(a.caption || a.original_name)}"`;
  if (a.kind === "image" || (a.kind === "video" && a.thumb)) {
    const src = a.thumb ? `/thumbs/${a.id}` : `/files/${a.id}`;
    const dur = a.kind === "video" ? `<span class="br">${ICON.play}${fmtDur(a.duration)}</span>` : "";
    return `<div ${attrs}><img loading="lazy" decoding="async" src="${src}" alt="">${group}${dur}${check}</div>`;
  }
  if (a.kind === "video") return `<div ${attrs} style="display:grid;place-items:center;color:var(--accent-ink)">${ICON.video}${group}<span class="br">${ICON.play}${fmtDur(a.duration)}</span>${check}</div>`;
  if (a.kind === "audio") {
    return `<div ${attrs}>${waveSvg(a.id)}<span class="an">${esc(a.caption || a.original_name)}</span>${group}<span class="br">${ICON.mic}${fmtDur(a.duration)}</span>${check}</div>`;
  }
  if (a.kind === "text") return `<div ${attrs}><pre data-text="${a.id}">…</pre>${group}${check}</div>`;
  return `<div ${attrs}>${ICON.file}${esc(extOf(a.original_name))}${group}${check}</div>`;
}

const textCache = new Map();
export function hydrateText(root) {
  $$("pre[data-text]", root).forEach(async (pre) => {
    const id = pre.dataset.text;
    pre.removeAttribute("data-text");
    if (!textCache.has(id)) textCache.set(id, fetch(`/files/${id}`).then((r) => r.text()).then((t) => t.slice(0, 300)).catch(() => ""));
    pre.textContent = (await textCache.get(id)) || "（空）";
  });
}

/**
 * @param {HTMLElement} root
 * @param {{ fetchPage: (offset:number)=>Promise<{items:any[], total:number}>, groupByDay?: boolean, selectable?: boolean,
 *           showGroup?: boolean, onOpen?: (item:any, all:any[])=>void, onSelect?: (sel:Map)=>void, empty?: string, pageSize?: number }} opts
 */
export function createGallery(root, opts) {
  const { groupByDay = true, selectable = true, showGroup = true } = opts;
  let items = [], total = Infinity, loading = false, gen = 0;
  const sel = new Map();
  let anchor = null, selectMode = false;

  root.innerHTML = `<div class="gal-body"></div><div class="load-sentinel"></div>`;
  const body = $(".gal-body", root), sentinel = $(".load-sentinel", root);
  let currentDay = null, currentGrid = null;

  const append = (list) => {
    for (const a of list) {
      const day = a.taken_at.slice(0, 10);
      if (!currentGrid || (groupByDay && day !== currentDay)) {
        currentDay = day;
        const g = document.createElement("section");
        g.className = "day-group";
        g.dataset.day = day;
        g.innerHTML = (groupByDay ? `<div class="day-head"><span class="d">${fmtDay(day)}</span><span class="w">${weekday(day)}</span>
          ${selectable ? `<button class="sel-day" data-day="${day}">选择</button>` : ""}</div>` : "") + `<div class="grid"></div>`;
        body.append(g);
        currentGrid = $(".grid", g);
      }
      currentGrid.insertAdjacentHTML("beforeend", tileHtml(a, { showGroup }));
      if (sel.has(a.id)) currentGrid.lastElementChild.classList.add("sel");
    }
    hydrateText(body);
  };

  const loadMore = async () => {
    if (loading || items.length >= total) return;
    loading = true;
    const my = gen;
    sentinel.innerHTML = `<div class="spinner"></div>`;
    try {
      const r = await opts.fetchPage(items.length);
      if (my !== gen) return;
      total = r.total;
      items.push(...r.items);
      append(r.items);
      if (!items.length) body.innerHTML = opts.empty || "";
    } finally {
      if (my === gen) { loading = false; sentinel.innerHTML = ""; }
    }
    // 首屏不够高时继续加载
    if (my === gen && items.length < total && sentinel.getBoundingClientRect().top < innerHeight + 600) loadMore();
  };

  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "800px" });
  io.observe(sentinel);

  const notify = () => {
    root.classList.toggle("selecting", selectMode || sel.size > 0);
    opts.onSelect?.(sel);
  };
  const setSel = (id, on) => {
    const a = items.find((x) => x.id === id);
    if (!a) return;
    on ? sel.set(id, a) : sel.delete(id);
    $$(`.tile[data-id="${id}"]`, body).forEach((t) => t.classList.toggle("sel", on));
  };
  const toggle = (id, range) => {
    if (range && anchor) {
      const i = items.findIndex((x) => x.id === anchor), j = items.findIndex((x) => x.id === id);
      const [s, e] = i < j ? [i, j] : [j, i];
      for (let k = s; k <= e; k++) setSel(items[k].id, true);
    } else setSel(id, !sel.has(id));
    anchor = id;
    notify();
  };

  // 长按进入多选（手机）
  let pressTimer = null, pressed = false;
  root.addEventListener("touchstart", (e) => {
    const t = e.target.closest(".tile");
    if (!t || !selectable) return;
    pressed = false;
    pressTimer = setTimeout(() => { pressed = true; toggle(t.dataset.id); navigator.vibrate?.(15); }, 450);
  }, { passive: true });
  const cancelPress = () => clearTimeout(pressTimer);
  root.addEventListener("touchmove", cancelPress, { passive: true });
  root.addEventListener("touchend", cancelPress);
  root.addEventListener("contextmenu", (e) => { if (e.target.closest(".tile") && selectable) e.preventDefault(); });

  root.addEventListener("click", (e) => {
    const dayBtn = e.target.closest(".sel-day");
    if (dayBtn) {
      const ids = items.filter((x) => x.taken_at.startsWith(dayBtn.dataset.day)).map((x) => x.id);
      const all = ids.every((id) => sel.has(id));
      ids.forEach((id) => setSel(id, !all));
      notify();
      return;
    }
    const t = e.target.closest(".tile");
    if (!t) return;
    if (pressed) { pressed = false; return; }
    const id = t.dataset.id;
    if (selectable && (opts.clickSelects || selectMode || sel.size > 0 || e.target.closest(".check") || e.shiftKey || e.metaKey || e.ctrlKey)) {
      toggle(id, e.shiftKey);
      return;
    }
    const a = items.find((x) => x.id === id);
    opts.onOpen?.(a, items);
  });

  const api = {
    get items() { return items; },
    get total() { return total; },
    selected: sel,
    reload() {
      gen++;
      items = []; total = Infinity; loading = false; currentDay = null; currentGrid = null;
      body.innerHTML = "";
      return loadMore();
    },
    get selectMode() { return selectMode; },
    setSelectMode(v) { selectMode = v; if (!v) { [...sel.keys()].forEach((id) => setSel(id, false)); anchor = null; } notify(); },
    clearSelection() { [...sel.keys()].forEach((id) => setSel(id, false)); anchor = null; notify(); },
    selectAll() { items.forEach((a) => setSel(a.id, true)); notify(); },
    destroy() { io.disconnect(); gen++; },
  };
  api.reload();
  return api;
}
