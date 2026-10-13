// 业务弹层：分配编号、编号生成成功、选择日记、从图库挑选
import { $, $$, api, esc, sheet, today, fmtDate, weekday, parseTags, copy, ICON, emit, debounce, toast } from "./lib.js";
import { createGallery } from "./gallery.js";

const thumbOf = (a) => a.thumb ? `<img src="/thumbs/${a.id}" alt="">` : `<span class="ph">${ICON[a.kind] || ICON.file}</span>`;

function selPreview(list) {
  const shown = list.slice(0, 7);
  return `<div class="sel-preview">${shown.map(thumbOf).join("")}${list.length > shown.length ? `<span class="more">+${list.length - shown.length}</span>` : ""}</div>`;
}

/** 选中媒体中出现最多的拍摄日期，作为日记日期的默认值 */
function guessDate(list) {
  const c = new Map();
  for (const a of list) { const d = a.taken_at.slice(0, 10); c.set(d, (c.get(d) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || today();
}

/** 新建日记（分配编号）。media/pages 为已选文件 */
export async function newEntryDialog({ media = [], pages = [] } = {}) {
  const all = [...media, ...pages];
  const entry = await sheet({
    html: `<form class="sheet-body" id="neForm">
        <h2>${all.length ? "为这组内容分配编号" : "新建日记"}</h2>
        <p class="hint">${all.length ? `已选 ${all.length} 项，将作为一篇日记的${pages.length && !media.length ? "纸质原稿" : "富媒体"}。生成编号后写回纸质本，或打印二维码贴上。` : "先拿到编号写在纸上，之后再往里添加照片、录音和原稿。"}</p>
        ${all.length ? selPreview(all) : ""}
        <div class="row2">
          <label class="field">日记日期<input type="date" name="date" required value="${guessDate(all)}"></label>
          <label class="field"><span>标签 <small>空格分隔</small></span><input type="text" name="tags" placeholder="旅行 家人"></label>
        </div>
        <label class="field"><span>标题 <small>可选</small></span><input type="text" name="title" maxlength="200" placeholder="例如：秋天的第一场雨" autofocus></label>
      </form>
      <div class="sheet-actions"><button class="btn" data-close>取消</button><button class="btn primary" data-ok>${ICON.sparkle}生成编号</button></div>`,
    mount: (el, close) => {
      const submit = async (e) => {
        e?.preventDefault();
        const f = $("#neForm", el);
        if (!f.reportValidity()) return;
        try {
          const r = await api("/entries", { method: "POST", body: {
            date: f.date.value, title: f.title.value, tags: parseTags(f.tags.value),
            media_ids: media.map((a) => a.id), page_ids: pages.map((a) => a.id),
          } });
          close(r);
        } catch (err) { toast(err.message); }
      };
      $("#neForm", el).addEventListener("submit", submit);
      $("[data-ok]", el).addEventListener("click", submit);
    },
  });
  if (entry) { emit("data-changed"); await createdDialog(entry); }
  return entry;
}

/** 编号生成成功：大号编号 + 二维码，提醒写回本子 */
export function createdDialog(e) {
  return sheet({
    html: `<div class="created">
        <span class="ok">${ICON.check}编号已生成</span>
        <div class="cid">${esc(e.id)}</div>
        <img src="/api/qr/${encodeURIComponent(e.id)}.svg" alt="二维码">
        <p>${fmtDate(e.date)} ${weekday(e.date)}${e.title ? ` · ${esc(e.title)}` : ""}<br>把编号写在纸质日记上，或打印二维码贴上</p>
      </div>
      <div class="sheet-actions" style="justify-content:center">
        <button class="btn" data-copy>${ICON.copy}复制编号</button>
        <a class="btn" href="#/print?ids=${encodeURIComponent(e.id)}" data-go>${ICON.print}打印标签</a>
        <a class="btn primary" href="#/e/${encodeURIComponent(e.id)}" data-go>查看日记</a>
      </div>`,
    mount: (el, close) => {
      $("[data-copy]", el).addEventListener("click", () => copy(e.id));
      $$("[data-go]", el).forEach((a) => a.addEventListener("click", () => close()));
    },
  });
}

/** 选择一篇已有日记（可选：作为富媒体或原稿）。返回 { id, role } */
export function pickEntryDialog({ title = "加入日记", askRole = true, defaultRole = "media", exclude } = {}) {
  return sheet({
    html: `<div class="sheet-body">
        <h2>${esc(title)}</h2>
        ${askRole ? `<div class="radio-row">
          <label><input type="radio" name="role" value="media" ${defaultRole === "media" ? "checked" : ""}><div><b>富媒体</b><span>照片、视频、录音</span></div></label>
          <label><input type="radio" name="role" value="page" ${defaultRole === "page" ? "checked" : ""}><div><b>纸质原稿</b><span>手写页的照片，用于阅读</span></div></label>
        </div>` : ""}
        <div class="search">${ICON.search}<input type="search" placeholder="搜索编号或标题" autofocus></div>
        <div class="pick-list"><div class="spinner"></div></div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>取消</button></div>`,
    mount: (el, close) => {
      const list = $(".pick-list", el);
      const load = async (q = "") => {
        const r = await api(`/entries?limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`);
        const items = r.items.filter((x) => x.id !== exclude);
        list.innerHTML = items.length ? items.map((x) => `<div class="pick-item" data-id="${esc(x.id)}">
          ${x.cover ? `<img src="/thumbs/${x.cover.id}" alt="">` : `<span class="ph"></span>`}
          <div class="grow"><div><span class="idpill">${esc(x.id)}</span> ${esc(x.title)}</div>
          <div class="s">${fmtDate(x.date)} · ${x.media_count} 项媒体 · ${x.page_count} 页原稿</div></div></div>`).join("")
          : `<p class="hint" style="padding:20px;text-align:center">没有找到日记</p>`;
      };
      load();
      $("input[type=search]", el).addEventListener("input", debounce((e) => load(e.target.value.trim()), 200));
      list.addEventListener("click", (e) => {
        const it = e.target.closest(".pick-item");
        if (it) close({ id: it.dataset.id, role: $("input[name=role]:checked", el)?.value || defaultRole });
      });
    },
  });
}

/** 从图库挑选（默认只看未归组），返回选中的文件 */
export function pickFromLibraryDialog({ title = "从图库添加", role = "media" } = {}) {
  let gal;
  return sheet({
    wide: true,
    html: `<div class="sheet-body">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">${esc(title)}</h2>
          <div class="seg" id="pkSeg"><button class="on" data-v="1">未归组</button><button data-v="0">全部</button></div></div>
        <div id="pkGal" style="max-height:60vh;overflow:auto;--tile:110px"></div>
      </div>
      <div class="sheet-actions"><span class="muted" id="pkN" style="margin-right:auto;align-self:center">点选要添加的${role === "page" ? "原稿照片" : "文件"}</span>
        <button class="btn" data-close>取消</button><button class="btn primary" data-ok disabled>添加</button></div>`,
    mount: (el, close) => {
      let ungrouped = true;
      const mk = () => {
        gal?.destroy();
        gal = createGallery($("#pkGal", el), {
          fetchPage: (offset) => api(`/media?limit=120&offset=${offset}${ungrouped ? "&ungrouped=1" : ""}${role === "page" ? "&kind=image" : ""}`),
          clickSelects: true,
          onSelect: (s) => { $("#pkN", el).textContent = s.size ? `已选 ${s.size} 项` : "点选要添加的文件"; $("[data-ok]", el).disabled = !s.size; },
          empty: `<p class="hint" style="padding:30px;text-align:center">${ungrouped ? "没有未归组的文件" : "图库是空的"}</p>`,
        });
      };
      mk();
      $("#pkSeg", el).addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        $$("button", b.parentElement).forEach((x) => x.classList.toggle("on", x === b));
        ungrouped = b.dataset.v === "1";
        mk();
      });
      $("[data-ok]", el).addEventListener("click", () => close([...gal.selected.values()]));
    },
  }).finally(() => gal?.destroy());
}
