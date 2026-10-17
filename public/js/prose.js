// 正文的只读排版（阅读页、日记详情）与影像块，编辑器也复用影像块的外观
import { $$, esc, ICON, waveSvg, fmtDur, imgAttrs } from "./lib.js";
import { renderHtml } from "./md.js";
import { isLive, liveTag } from "./live.js";

/**
 * 正文里的一个影像
 * @param {any} a 附件；找不到时显示「不可用」
 * @param {string} caption 正文里写的说明
 * @param {{ edit?: boolean }} opts 编辑器里说明可直接编辑
 */
export function mediaFigure(a, caption, { edit = false } = {}) {
  // 编辑器里用 <input>：嵌套的 contenteditable 在各浏览器里焦点和光标都不可靠
  const cap = edit
    ? `<figcaption><input class="cap" type="text" value="${esc(caption)}" placeholder="添加说明…" maxlength="300" spellcheck="false"></figcaption>`
    : caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
  if (!a) return `<figure class="pm missing"><div class="mbox">${ICON.image}<span>影像不可用：已移出这篇日记或已删除</span></div>${cap}</figure>`;
  let box;
  switch (a.kind) {
    case "image":
      box = `<img ${imgAttrs(a, "(max-width: 860px) 100vw, 780px")} alt="${esc(caption)}" loading="lazy" decoding="async" draggable="false"${a.width && a.height ? ` width="${a.width}" height="${a.height}"` : ""}>`;
      break;
    case "video":
      box = `<video src="/files/${a.id}" controls preload="metadata" playsinline${a.thumb ? ` poster="/thumbs/${a.id}"` : ""}></video>`;
      break;
    case "audio":
      box = `<div class="pa">${waveSvg(a.id, 40)}<div class="pa-n">${ICON.mic}<span>${esc(a.caption || a.original_name)}</span><small>${fmtDur(a.duration)}</small></div>
        <audio src="/files/${a.id}" controls preload="none"></audio></div>`;
      break;
    case "text":
      box = `<pre class="pt" data-full-text="${a.id}">…</pre>`;
      break;
    default:
      box = `<a class="pf" href="/files/${a.id}" target="_blank" rel="noopener">${ICON.file}<span>${esc(a.original_name)}</span></a>`;
  }
  const live = isLive(a) ? ` data-live="${a.id}"` : "";
  return `<figure class="pm k-${a.kind}" data-id="${a.id}"><div class="mbox"${live}>${box}${live ? liveTag() : ""}</div>${cap}</figure>`;
}

/** 文字类影像在正文里显示全文 */
export function hydrateProse(root) {
  $$("pre[data-full-text]", root).forEach((pre) => {
    const id = pre.dataset.fullText;
    pre.removeAttribute("data-full-text");
    fetch(`/files/${id}`).then((r) => r.text()).then((t) => { pre.textContent = t || "（空）"; }).catch(() => { pre.textContent = "（无法读取）"; });
  });
}

/** 正文 Markdown → HTML；byId 为本篇可用的附件 */
export function renderProse(md, byId) {
  return renderHtml(md, (id, caption) => mediaFigure(byId.get(id), caption));
}
