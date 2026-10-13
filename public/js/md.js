// 正文 Markdown：块结构 ⇄ Markdown 文本 ⇄ HTML
// 只支持日记用得到的子集：标题、段落、列表、待办、引用、代码块、分割线、影像，以及粗体/斜体/删除线/行内代码/链接
// 影像单独一行：![说明](media:附件ID)
import { esc } from "./lib.js";

export const TEXT_TYPES = ["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code"];
export const LIST_TYPES = ["ul", "ol", "todo"];
const MEDIA_RE = /^!\[((?:\\.|[^\]\\])*)\]\(media:([\w-]+)\)\s*$/;

// ---------- 行内 ----------

const PUNCT = /[\\`*_{}[\]()#+\-.!>~|]/;

/** 找到与 tok 匹配的结束位置（跳过转义与行内代码） */
function findClose(s, tok, from) {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "`" && tok !== "`") { const j = s.indexOf("`", k + 1); if (j > k) { k = j; continue; } }
    if (tok === "*" && s.startsWith("**", k)) {
      const j = findClose(s, "**", k + 2);
      if (j > k + 2) { k = j + 1; continue; }
    }
    if (s.startsWith(tok, k)) return k;
  }
  return -1;
}

export function safeUrl(u) {
  const s = String(u).trim();
  return /^(https?:|mailto:|#\/)/i.test(s) ? s : "";
}

/** 行内 Markdown → HTML */
export function inlineHtml(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += esc(s[i + 1]); i += 2; continue; }
    if (c === "\n") { out += "<br>"; i++; continue; }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) { out += `<code>${esc(s.slice(i + 1, j))}</code>`; i = j + 1; continue; }
    }
    if (s.startsWith("**", i)) {
      const j = findClose(s, "**", i + 2);
      if (j > i + 2) { out += `<b>${inlineHtml(s.slice(i + 2, j))}</b>`; i = j + 2; continue; }
    }
    if (s.startsWith("~~", i)) {
      const j = findClose(s, "~~", i + 2);
      if (j > i + 2) { out += `<s>${inlineHtml(s.slice(i + 2, j))}</s>`; i = j + 2; continue; }
    }
    if (c === "*" && s[i + 1] !== "*") {
      const j = findClose(s, "*", i + 1);
      if (j > i + 1) { out += `<i>${inlineHtml(s.slice(i + 1, j))}</i>`; i = j + 1; continue; }
    }
    if (c === "[") {
      const m = s.slice(i).match(/^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/);
      if (m) {
        const href = safeUrl(m[2]);
        out += href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inlineHtml(m[1])}</a>` : inlineHtml(m[1]);
        i += m[0].length; continue;
      }
    }
    out += esc(c); i++;
  }
  return out;
}

const escText = (t) => t.replace(/[\\`*[\]]/g, "\\$&").replace(/~~/g, "\\~\\~");

/** 把首尾空白移到标记外面：「** 粗体 **」不是合法的 Markdown */
function wrap(tok, inner) {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${tok}${m[2]}${tok}${m[3]}` : inner;
}

/** 编辑器 DOM（行内部分）→ 行内 Markdown */
export function inlineMd(node) {
  let out = "";
  const kids = [...node.childNodes];
  kids.forEach((n, idx) => {
    if (n.nodeType === 3) { out += escText(n.nodeValue.replace(/\u200b/g, "").replace(/\u00a0/g, " ")); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === "br") { if (idx < kids.length - 1) out += "\n"; return; }  // 末尾的 <br> 只是占位
    if (n.getAttribute?.("contenteditable") === "false") return;
    const st = n.style || {};
    if (tag === "code") { out += n.textContent ? "`" + n.textContent.replace(/`/g, "'") + "`" : ""; return; }
    let inner = inlineMd(n);
    if (tag === "a") { const h = safeUrl(n.getAttribute("href") || ""); out += h && inner.trim() ? `[${inner}](${h})` : inner; return; }
    if (tag === "b" || tag === "strong" || /^(bold|[6-9]00)$/.test(st.fontWeight)) inner = wrap("**", inner);
    if (tag === "i" || tag === "em" || st.fontStyle === "italic") inner = wrap("*", inner);
    if (tag === "s" || tag === "strike" || tag === "del" || /line-through/.test(st.textDecoration || st.textDecorationLine || "")) inner = wrap("~~", inner);
    if ((tag === "div" || tag === "p") && idx < kids.length - 1) inner += "\n";
    out += inner;
  });
  return out;
}

/** 代码块等纯文本块：<br> 视为换行 */
export function plainOf(node) {
  let out = "";
  const kids = [...node.childNodes];
  kids.forEach((n, idx) => {
    if (n.nodeType === 3) out += n.nodeValue.replace(/\u200b/g, "").replace(/\u00a0/g, " ");
    else if (n.nodeName === "BR") { if (idx < kids.length - 1) out += "\n"; }
    else if (n.nodeType === 1) out += plainOf(n) + (/^(DIV|P)$/.test(n.nodeName) && idx < kids.length - 1 ? "\n" : "");
  });
  return out;
}

// ---------- 块 ----------

/**
 * @typedef {{ t: string, text?: string, indent?: number, checked?: boolean, id?: string, caption?: string, lang?: string }} Block
 */

/** Markdown → 块数组 */
export function parse(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const startsBlock = (l) => /^\s*(#{1,3}\s|[-*+]\s|\d+[.)]\s|>|```|(-{3,}|\*{3,})\s*$)/.test(l) || MEDIA_RE.test(l.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```\s*([\w+-]*)\s*$/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ t: "code", text: buf.join("\n"), lang: m[1] || "" });
      continue;
    }
    if ((m = line.trim().match(MEDIA_RE))) {
      blocks.push({ t: "media", id: m[2], caption: m[1].replace(/\\(.)/g, "$1") });
      i++; continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { blocks.push({ t: `h${m[1].length}`, text: m[2].trim() }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if ((m = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s?(.*)$/))) {
      blocks.push({ t: "todo", text: m[3], checked: m[2] !== " ", indent: Math.min(Math.floor(m[1].length / 2), 4) }); i++; continue;
    }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { blocks.push({ t: "ul", text: m[2], indent: Math.min(Math.floor(m[1].length / 2), 4) }); i++; continue; }
    if ((m = line.match(/^(\s*)\d+[.)]\s+(.*)$/))) { blocks.push({ t: "ol", text: m[2], indent: Math.min(Math.floor(m[1].length / 2), 4) }); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "quote", text: buf.join("\n") });
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++]);
    blocks.push({ t: "p", text: buf.join("\n") });
  }
  return blocks;
}

/** 段落里以列表/标题等符号开头的行，需要转义才不会被当成别的块 */
const escLineStart = (line) => line
  .replace(/^(\s*)(#{1,6}\s|[-+]\s|>)/, "$1\\$2")
  .replace(/^(\s*)(\d+)([.)]\s)/, "$1$2\\$3")
  .replace(/^(\s*)(-{3,}\s*)$/, "$1\\$2")
  .replace(/^```/, "\\`\\`\\`");

/** 有序列表编号：同一层级连续计数，遇到非列表块或更浅的层级时重新开始 */
function olCount(counters, b) {
  if (!LIST_TYPES.includes(b.t)) { counters.length = 0; return 0; }
  const lvl = b.indent || 0;
  counters.length = lvl + 1;
  counters[lvl] = b.t === "ol" ? (counters[lvl] || 0) + 1 : 0;
  return counters[lvl];
}

/** 块数组 → Markdown */
export function serialize(blocks) {
  const out = [];
  const olNo = [];
  let prev = null;
  for (const b of blocks) {
    const ind = "  ".repeat(b.indent || 0);
    let s;
    switch (b.t) {
      case "h1": case "h2": case "h3": s = `${"#".repeat(+b.t[1])} ${b.text.replace(/\n/g, " ").trim()}`; break;
      case "ul": s = `${ind}- ${b.text.replace(/\n/g, " ")}`; break;
      case "todo": s = `${ind}- [${b.checked ? "x" : " "}] ${b.text.replace(/\n/g, " ")}`; break;
      case "ol": s = `${ind}${olCount(olNo, b)}. ${b.text.replace(/\n/g, " ")}`; break;
      case "quote": s = b.text.split("\n").map((l) => `> ${l}`).join("\n"); break;
      case "code": s = "```" + (b.lang || "") + "\n" + b.text.replace(/^```/gm, "\\`\\`\\`") + "\n```"; break;
      case "hr": s = "---"; break;
      case "media": s = `![${(b.caption || "").replace(/[\\\]]/g, "\\$&").replace(/\n/g, " ")}](media:${b.id})`; break;
      default:
        if (!b.text.trim()) continue;  // 空段落不保存
        s = b.text.split("\n").map(escLineStart).join("\n");
    }
    if (b.t !== "ol") olCount(olNo, b);
    const tight = prev && LIST_TYPES.includes(prev.t) && LIST_TYPES.includes(b.t);
    if (out.length) out.push(tight ? "\n" : "\n\n");
    out.push(s);
    prev = b;
  }
  return out.join("");
}

/** 正文指纹（FNV-1a 32 位，与服务器 store.ts 的 bodyHash 一致），保存时用来做冲突检查 */
export function bodyHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 正文里引用的影像 id */
export function refsOf(md) {
  return parse(md).filter((b) => b.t === "media").map((b) => b.id);
}

/** 块的纯文字（用于字数统计） */
export const plainOfBlocks = (blocks) => blocks.map((b) => b.t === "media" ? b.caption || "" : (b.text || "")
  .replace(/\\(.)/g, "$1").replace(/\*\*|~~|`|\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).join("\n");

// ---------- 只读渲染（阅读页、详情页预览） ----------

/**
 * @param {string} md
 * @param {(id:string, caption:string)=>string} mediaHtml 影像块的 HTML
 */
export function renderHtml(md, mediaHtml) {
  const blocks = parse(md);
  let html = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (LIST_TYPES.includes(b.t)) {
      // 连续的列表项合成一组；缩进用 padding 表示，避免嵌套解析
      let items = "";
      const counters = [];
      while (i < blocks.length && LIST_TYPES.includes(blocks[i].t)) {
        const x = blocks[i];
        const n = olCount(counters, x);
        const mark = x.t === "todo" ? `<span class="pk ${x.checked ? "on" : ""}"></span>` : x.t === "ol" ? `<span class="pn">${n}.</span>` : `<span class="pb"></span>`;
        items += `<div class="pli ${x.t} ${x.checked ? "done" : ""}" style="--ind:${x.indent || 0}">${mark}<div>${inlineHtml(x.text)}</div></div>`;
        i++;
      }
      i--;
      html += `<div class="plist">${items}</div>`;
      continue;
    }
    switch (b.t) {
      case "h1": case "h2": case "h3": html += `<${b.t}>${inlineHtml(b.text)}</${b.t}>`; break;
      case "quote": html += `<blockquote>${inlineHtml(b.text)}</blockquote>`; break;
      case "code": html += `<pre><code>${esc(b.text)}</code></pre>`; break;
      case "hr": html += "<hr>"; break;
      case "media": html += mediaHtml(b.id, b.caption || ""); break;
      default: html += `<p>${inlineHtml(b.text)}</p>`;
    }
  }
  return html;
}
