// 块编辑器（飞书文档式）：每一行是一个块，悬停显示「+ / ⋮⋮」手柄，「/」唤起插入菜单，
// 选中文字出现浮动工具栏，Markdown 快捷输入（# 、- 、1. 、[] 、> 、``` 、---），影像块可写说明。
// 内容以 Markdown 存储（见 md.js）。撤销/重做自己维护，因为结构性操作不在浏览器原生的撤销栈里。
import { $, $$, esc, ICON } from "./lib.js";
import { parse, serialize, inlineHtml, inlineMd, plainOf, plainOfBlocks, LIST_TYPES } from "./md.js";
import { mediaFigure, hydrateProse } from "./prose.js";

const TEXT = ["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code"];
const ATOMS = ["media", "hr"];
const MAX_INDENT = 4;
const PH_DOC = "开始转写纸上的文字。输入「/」插入标题、列表、照片…";
const PH = {
  p: "输入「/」插入标题、列表、影像…", h1: "一级标题", h2: "二级标题", h3: "三级标题",
  ul: "列表", ol: "列表", todo: "待办事项", quote: "引用", code: "代码",
};

const G = (s) => `<span class="gl">${s}</span>`;
const TYPE_ITEMS = [
  { k: "p", label: "正文", icon: G("T"), kw: "p text zw zhengwen 正文 文本" },
  { k: "h1", label: "一级标题", icon: G("H1"), kw: "h1 bt biaoti heading 标题" },
  { k: "h2", label: "二级标题", icon: G("H2"), kw: "h2 bt biaoti heading 标题" },
  { k: "h3", label: "三级标题", icon: G("H3"), kw: "h3 bt biaoti heading 标题" },
  { k: "ul", label: "无序列表", icon: `<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>`, kw: "ul list lb liebiao wuxu 列表" },
  { k: "ol", label: "有序列表", icon: G("1."), kw: "ol list lb liebiao youxu 列表 1" },
  { k: "todo", label: "待办", icon: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>`, kw: "todo db daiban check 任务" },
  { k: "quote", label: "引用", icon: `<svg viewBox="0 0 24 24"><path d="M5 5v14M9 8h10M9 12h10M9 16h6"/></svg>`, kw: "quote yy yinyong 引文" },
  { k: "code", label: "代码块", icon: G("&lt;/&gt;"), kw: "code dm daima 代码" },
];
const INSERT_ITEMS = [
  { k: "media", label: "本篇影像", icon: ICON.image, kw: "media img image tp tupian zp zhaopian sp shipin yx yingxiang photo video 图片 照片 视频 录音" },
  { k: "upload", label: "上传图片 / 视频", icon: ICON.upload, kw: "upload sc shangchuan tp tupian 上传 图片" },
  { k: "hr", label: "分割线", icon: `<svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg>`, kw: "hr fgx fengexian divider line 分割线" },
];

/**
 * @param {HTMLElement} host
 * @param {{ markdown: string, getMedia: (id:string)=>any, onChange?: ()=>void,
 *           pickMedia?: ()=>Promise<any[]|null>, uploadFiles?: (files:File[])=>Promise<any>[], placeholder?: string }} opts
 */
export function createEditor(host, opts) {
  host.classList.add("ed");
  host.innerHTML = `<div class="ed-root" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true"></div>
    <div class="ed-handle" hidden><button type="button" class="eh-plus" title="插入">${ICON.plus}</button><button type="button" class="eh-drag" title="拖动移动 / 点击打开菜单"><svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/></svg></button></div>
    <div class="ed-dropline" hidden></div>
    <div class="ed-ph" hidden aria-hidden="true"></div>`;
  const root = $(".ed-root", host);
  const placeholder = $(".ed-ph", host);
  const handle = $(".ed-handle", host);
  const dropLine = $(".ed-dropline", host);
  const pop = document.createElement("div");
  pop.className = "ed-pop";
  pop.hidden = true;
  const bar = document.createElement("div");
  bar.className = "ed-bar";
  bar.hidden = true;
  document.body.append(pop, bar);

  // ---------- 块 DOM ----------

  const isAtom = (el) => !!el && ATOMS.includes(el.dataset.t);
  const isText = (el) => !!el && TEXT.includes(el.dataset.t);
  const blocks = () => [...root.children];

  function fillEmpty(el) {
    if (!isText(el)) return;
    // 空块需要一个 <br> 占位才有高度、能放光标
    if (!el.textContent && el.lastChild?.nodeName !== "BR") el.append(document.createElement("br"));
  }

  function mediaInner(id, caption) {
    return mediaFigure(opts.getMedia(id), caption, { edit: true });
  }

  function makeBlock(b) {
    const el = document.createElement("div");
    el.className = "blk";
    el.dataset.t = b.t;
    if (LIST_TYPES.includes(b.t)) el.dataset.indent = String(b.indent || 0);
    if (b.t === "todo" && b.checked) el.dataset.checked = "1";
    if (b.t === "code") {
      el.textContent = b.text || "";
      if (b.lang) el.dataset.lang = b.lang;
    } else if (b.t === "hr") {
      el.contentEditable = "false";
      el.innerHTML = "<hr>";
    } else if (b.t === "media") {
      el.contentEditable = "false";
      el.dataset.id = b.id;
      el.innerHTML = mediaInner(b.id, b.caption || "");
    } else if (b.t === "uploading") {
      el.contentEditable = "false";
      el.innerHTML = `<div class="ed-uploading"><span class="spinner"></span><span>正在上传 ${esc(b.name || "")}…</span></div>`;
    } else {
      el.innerHTML = inlineHtml(b.text || "");
    }
    fillEmpty(el);
    return el;
  }

  function toBlock(el) {
    const t = el.dataset.t;
    if (t === "media") return { t, id: el.dataset.id, caption: ($("input.cap", el)?.value || "").replace(/\s+/g, " ").trim() };
    if (t === "hr") return { t };
    if (!isText(el)) return null;
    const b = { t, text: t === "code" ? plainOf(el) : inlineMd(el) };
    if (LIST_TYPES.includes(t)) b.indent = +el.dataset.indent || 0;
    if (t === "todo") b.checked = el.dataset.checked === "1";
    if (t === "code" && el.dataset.lang) b.lang = el.dataset.lang;
    return b;
  }

  function setContent(md) {
    root.innerHTML = "";
    const list = parse(md);
    for (const b of list) root.append(makeBlock(b));
    normalize();
    hydrateProse(root);
  }

  const isEmpty = (el) => isText(el) && !el.textContent.replace(/​/g, "") && !el.querySelector("img");

  function normalize() {
    for (const n of [...root.childNodes]) {
      if (n.nodeType === 1 && n.classList.contains("blk") && n.dataset.t) continue;
      if (n.nodeType === 3 && !n.nodeValue.trim()) { n.remove(); continue; }
      // 浏览器偶尔会在根节点下直接生成文字或 <div>：包成段落
      const b = makeBlock({ t: "p" });
      b.innerHTML = "";
      if (n.nodeType === 1 && /^(DIV|P)$/.test(n.nodeName)) { while (n.firstChild) b.append(n.firstChild); n.replaceWith(b); }
      else { n.replaceWith(b); b.append(n); }
      fillEmpty(b);
    }
    if (!root.firstElementChild) root.append(makeBlock({ t: "p" }));
    if (isAtom(root.lastElementChild) || root.lastElementChild.dataset.t === "uploading") root.append(makeBlock({ t: "p" }));
    for (const el of root.children) {
      if (isText(el)) {
        // 清掉空的行内元素，避免光标卡在里面
        $$("b,i,s,strike,em,strong,span,a,code,font", el).forEach((x) => { if (!x.textContent && !x.querySelector("br")) x.remove(); });
        fillEmpty(el);
      }
    }
  }

  // ---------- 选区工具 ----------

  const sel = () => getSelection();
  function blockOf(node) {
    while (node && node !== root) {
      if (node.parentNode === root) return node.nodeType === 1 ? node : null;
      node = node.parentNode;
    }
    return null;
  }
  const inRoot = () => { const s = sel(); return s.rangeCount > 0 && root.contains(s.anchorNode); };
  const curBlock = () => (inRoot() ? blockOf(sel().anchorNode) : null);

  /** 光标相对块开头的字符数（<br> 计 1） */
  function caretOffset(block, atEnd = false) {
    const r = sel().getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(atEnd ? r.endContainer : r.startContainer, atEnd ? r.endOffset : r.startOffset);
    return lenOf(pre.cloneContents());
  }
  function lenOf(node) {
    let n = 0;
    for (const c of node.childNodes) {
      if (c.nodeType === 3) n += c.length;
      else if (c.nodeName === "BR") n += 1;
      else if (c.nodeType === 1) n += lenOf(c);
    }
    return n;
  }
  /** 块内容长度（不计结尾占位的 <br>） */
  const blen = (block) => lenOf(block) - (block.lastChild?.nodeName === "BR" ? 1 : 0);

  function setCaret(block, off) {
    const r = document.createRange();
    let rem = off, done = false;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (done) return;
        if (c.nodeType === 3) {
          if (rem <= c.length) { r.setStart(c, rem); done = true; return; }
          rem -= c.length;
        } else if (c.nodeName === "BR") {
          if (rem === 0) { r.setStartBefore(c); done = true; return; }
          rem -= 1;
        } else if (c.nodeType === 1) walk(c);
      }
    };
    if (isText(block)) walk(block);
    if (!done) {
      if (block.lastChild?.nodeName === "BR") r.setStartBefore(block.lastChild);
      else { r.selectNodeContents(block); r.collapse(false); }
    }
    r.collapse(true);
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
    if (document.activeElement !== root) root.focus({ preventScroll: true });
    keepCaretVisible();
  }
  const caretEnd = (block) => setCaret(block, blen(block));

  /**
   * 真正能看到的区域：手机软键盘弹出时只剩 visualViewport 那一块，
   * 还要减去顶栏和贴在键盘上方的工具条（由页面通过 opts.visibleBand 提供）
   */
  function visibleBand() {
    const vv = window.visualViewport;
    const band = { top: vv ? vv.offsetTop : 0, bottom: vv ? vv.offsetTop + vv.height : innerHeight };
    const extra = opts.visibleBand?.();
    if (extra) { band.top = Math.max(band.top, extra.top); band.bottom = Math.min(band.bottom, extra.bottom); }
    return band;
  }

  /** 光标（或选中的块）被键盘、工具条或顶栏挡住时滚动到可见处 */
  function ensureVisible() {
    if (!inRoot()) return;
    const atom = selectedAtom();
    let rect;
    if (atom) rect = atom.getBoundingClientRect();
    else {
      const r = sel().getRangeAt(0);
      rect = r.getClientRects()[0];
      if (!rect || !rect.height) {
        const b = curBlock();
        if (!b) return;
        const br = b.getBoundingClientRect();
        rect = { top: br.top, bottom: Math.min(br.bottom, br.top + 32) };
      }
    }
    const band = visibleBand();
    const margin = 24;
    if (rect.bottom > band.bottom - margin) scrollBy(0, rect.bottom - band.bottom + margin);
    else if (rect.top < band.top + 8) scrollBy(0, rect.top - band.top - margin);
  }
  let caretRaf = 0;
  const keepCaretVisible = () => { cancelAnimationFrame(caretRaf); caretRaf = requestAnimationFrame(ensureVisible); };
  const scrollIntoViewIfNeeded = keepCaretVisible;

  /** 选中整个原子块（影像 / 分割线） */
  function selectAtom(el) {
    const r = document.createRange();
    r.selectNode(el);
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
    root.focus({ preventScroll: true });
    scrollIntoViewIfNeeded(el);
    refreshAtomSel();
  }
  function selectedAtom() {
    if (!inRoot()) return null;
    const r = sel().getRangeAt(0);
    if (r.startContainer === root && r.endContainer === root && r.endOffset - r.startOffset === 1) {
      const el = root.childNodes[r.startOffset];
      return isAtom(el) ? el : null;
    }
    return null;
  }
  function refreshAtomSel() {
    const a = selectedAtom();
    $$(".blk.sel", root).forEach((x) => x !== a && x.classList.remove("sel"));
    a?.classList.add("sel");
  }

  // ---------- 撤销 / 重做 ----------

  const undoStack = [], redoStack = [];
  let burst = false, burstTimer;
  function saveSel() {
    if (!inRoot()) return null;
    const atom = selectedAtom();
    if (atom) return { bi: blocks().indexOf(atom), atom: true };
    const b = curBlock();
    if (!b) return null;
    return { bi: blocks().indexOf(b), off: caretOffset(b) };
  }
  function restoreSel(s) {
    if (!s) return;
    const b = blocks()[Math.min(s.bi, root.children.length - 1)];
    if (!b) return;
    if (s.atom && isAtom(b)) selectAtom(b);
    else setCaret(b, s.off ?? 0);
  }
  const snapshot = () => ({ html: root.innerHTML, sel: saveSel() });
  function checkpoint() {
    undoStack.push(snapshot());
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    burst = false;
  }
  function restore(snap) {
    root.innerHTML = snap.html;
    $$(".blk.sel", root).forEach((x) => x.classList.remove("sel"));
    normalize();
    restoreSel(snap.sel);
    changed();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); burst = false; }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); burst = false; }

  // ---------- 变更通知 ----------

  let changeQueued = false;
  function changed() {
    if (changeQueued) return;
    changeQueued = true;
    queueMicrotask(() => {
      changeQueued = false;
      normalize();
      markCurrent();
      opts.onChange?.();
    });
  }

  /** 当前所在的空行显示占位提示 */
  function markCurrent() {
    const b = curBlock();
    $$(".blk.cur", root).forEach((x) => x !== b && x.classList.remove("cur", "empty"));
    if (b && isText(b)) { b.classList.add("cur"); b.classList.toggle("empty", isEmpty(b)); }
    const docEmpty = root.children.length === 1 && isEmpty(root.firstElementChild) && root.firstElementChild.dataset.t === "p";
    root.classList.toggle("is-empty", docEmpty);
    placePlaceholder(docEmpty ? root.firstElementChild : b && isText(b) && isEmpty(b) ? b : null, docEmpty);
  }

  /**
   * 占位提示画在编辑区外面的浮层上：若用 ::before/::after 伪元素，
   * Chrome 会把空行的光标画到提示文字后面
   */
  function placePlaceholder(el, docEmpty) {
    if (!el) { placeholder.hidden = true; return; }
    const cs = getComputedStyle(el);
    const hr = host.getBoundingClientRect(), br = el.getBoundingClientRect();
    placeholder.textContent = docEmpty ? PH_DOC : PH[el.dataset.t] || PH.p;
    placeholder.style.left = `${br.left - hr.left + parseFloat(cs.paddingLeft)}px`;
    placeholder.style.top = `${br.top - hr.top + parseFloat(cs.paddingTop)}px`;
    placeholder.style.width = `${Math.max(0, br.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))}px`;
    placeholder.style.font = cs.font;
    placeholder.style.lineHeight = cs.lineHeight;
    placeholder.hidden = false;
  }

  // ---------- 结构操作 ----------

  function setType(b, t, { checkpointed = false } = {}) {
    if (!b || !isText(b)) return;
    const cur = b.dataset.t;
    if (!checkpointed) checkpoint();
    if (t === "code" && cur !== "code") {
      const text = plainOf(b);
      b.textContent = text;
    } else if (cur === "code" && t !== "code") {
      const text = plainOf(b);
      b.innerHTML = text.split("\n").map(esc).join("<br>");
      delete b.dataset.lang;
    }
    b.dataset.t = t;
    if (LIST_TYPES.includes(t)) b.dataset.indent = b.dataset.indent || "0";
    else delete b.dataset.indent;
    if (t !== "todo") delete b.dataset.checked;
    if (/^h\d$/.test(t)) b.innerHTML = b.innerHTML.replace(/<br>(?!$)/g, " ");
    fillEmpty(b);
    changed();
  }

  function indent(b, d) {
    if (!b || !LIST_TYPES.includes(b.dataset.t)) return false;
    const n = Math.max(0, Math.min(MAX_INDENT, (+b.dataset.indent || 0) + d));
    if (n === +b.dataset.indent) return true;
    checkpoint();
    b.dataset.indent = String(n);
    changed();
    return true;
  }

  function stripTrailingBr(el) { if (el.lastChild?.nodeName === "BR") el.lastChild.remove(); }

  /** 回车：在光标处把块一分为二 */
  function splitBlock() {
    const b = curBlock();
    if (!b) return;
    if (!isText(b)) return;
    checkpoint();
    const r = sel().getRangeAt(0);
    if (!r.collapsed) r.deleteContents();
    const t = b.dataset.t;
    const raw = b.textContent.trim();
    // 「---」「```」回车：转成分割线 / 代码块
    if (t === "p" && /^(-{3,}|\*{3,})$/.test(raw)) {
      const hr = makeBlock({ t: "hr" });
      const p = makeBlock({ t: "p" });
      b.replaceWith(hr);
      hr.after(p);
      setCaret(p, 0);
      return changed();
    }
    if (t === "p" && /^```[\w+-]*$/.test(raw)) {
      const code = makeBlock({ t: "code", text: "", lang: raw.slice(3) });
      b.replaceWith(code);
      setCaret(code, 0);
      return changed();
    }
    if ((LIST_TYPES.includes(t) || t === "quote") && isEmpty(b)) {
      if (+b.dataset.indent > 0) b.dataset.indent = String(+b.dataset.indent - 1);
      else setType(b, "p", { checkpointed: true });
      setCaret(b, 0);
      return changed();
    }
    const off = caretOffset(b);
    if (/^h\d$/.test(t) && off === 0 && !isEmpty(b)) {
      b.before(makeBlock({ t: "p" }));
      setCaret(b, 0);
      return changed();
    }
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(b, b.childNodes.length);
    const frag = tail.extractContents();
    const nt = LIST_TYPES.includes(t) ? t : "p";
    const nb = makeBlock({ t: nt, indent: +b.dataset.indent || 0 });
    nb.innerHTML = "";
    nb.append(frag);
    $$("b,i,s,strike,em,strong,span,a,code", nb).forEach((x) => { if (!x.textContent) x.remove(); });
    $$("b,i,s,strike,em,strong,span,a,code", b).forEach((x) => { if (!x.textContent) x.remove(); });
    if (!nb.textContent) nb.innerHTML = "";
    fillEmpty(b);
    fillEmpty(nb);
    b.after(nb);
    setCaret(nb, 0);
    changed();
  }

  /** Shift+回车 / 代码块里的回车：块内换行 */
  function insertBr() {
    checkpoint();
    const r = sel().getRangeAt(0);
    r.deleteContents();
    const br = document.createElement("br");
    r.insertNode(br);
    const next = br.nextSibling;
    if (!next || (next.nodeType === 3 && !next.nodeValue && !next.nextSibling)) br.after(document.createElement("br"));
    const nr = document.createRange();
    nr.setStartAfter(br);
    nr.collapse(true);
    sel().removeAllRanges();
    sel().addRange(nr);
    changed();
  }

  /** 在块开头退格 */
  function backspaceAtStart(b) {
    const t = b.dataset.t;
    if (t !== "p") {
      if (+b.dataset.indent > 0) indent(b, -1);
      else setType(b, "p");
      setCaret(b, 0);
      return;
    }
    const prev = b.previousElementSibling;
    if (!prev) return;
    checkpoint();
    if (isAtom(prev)) {
      if (isEmpty(b)) b.remove();
      selectAtom(prev);
      return changed();
    }
    if (!isText(prev)) return;
    mergeInto(prev, b);
  }

  function mergeInto(a, b) {
    const off = blen(a);
    stripTrailingBr(a);
    if (a.dataset.t === "code") {
      a.append(document.createTextNode(plainOf(b)));
    } else {
      stripTrailingBr(b);
      while (b.firstChild) a.append(b.firstChild);
    }
    b.remove();
    fillEmpty(a);
    setCaret(a, off);
    changed();
  }

  function deleteAtEnd(b) {
    const next = b.nextElementSibling;
    if (!next) return;
    checkpoint();
    if (isAtom(next)) {
      if (isEmpty(b)) { b.remove(); }
      selectAtom(next);
      return changed();
    }
    if (isText(next)) mergeInto(b, next);
  }

  function removeAtom(a, dir) {
    checkpoint();
    const prev = a.previousElementSibling, next = a.nextElementSibling;
    a.remove();
    normalize();
    const target = dir < 0 ? (prev || next) : (next || prev);
    if (!target || !target.isConnected) setCaret(root.firstElementChild, 0);
    else if (isAtom(target)) selectAtom(target);
    else if (target === prev) caretEnd(target);
    else setCaret(target, 0);
    changed();
  }

  /** 在某块之后插入一批块；空段落会被替换掉 */
  function insertBlocksAfter(ref, list) {
    let last = ref;
    const els = list.map((b) => makeBlock(b));
    for (const el of els) { last.after(el); last = el; }
    if (ref && isEmpty(ref) && ref.dataset.t === "p" && ref !== last) ref.remove();
    hydrateProse(root);
    normalize();
    return els;
  }

  /** 把正文插入到光标处（粘贴多行内容时用） */
  function insertBlocksAtCaret(list) {
    if (!list.length) return;
    checkpoint();
    let b = curBlock() || root.lastElementChild;
    let tail = null;
    if (isText(b) && inRoot() && !selectedAtom()) {
      const r = sel().getRangeAt(0);
      r.deleteContents();
      const tr = document.createRange();
      tr.setStart(r.startContainer, r.startOffset);
      tr.setEnd(b, b.childNodes.length);
      const frag = tr.extractContents();
      tail = makeBlock({ t: b.dataset.t === "code" ? "code" : LIST_TYPES.includes(b.dataset.t) ? b.dataset.t : "p", indent: +b.dataset.indent || 0 });
      tail.innerHTML = "";
      tail.append(frag);
      fillEmpty(b);
      fillEmpty(tail);
      b.after(tail);
    }
    const els = list.map((x) => makeBlock(x));
    let last = b;
    for (const el of els) { last.after(el); last = el; }
    if (isEmpty(b) && b.dataset.t === "p") b.remove();
    if (tail && isEmpty(tail)) tail.remove();
    hydrateProse(root);
    normalize();
    const end = els[els.length - 1];
    if (isAtom(end)) selectAtom(end); else caretEnd(end);
    changed();
  }

  // ---------- 影像 ----------

  let lastPos = null;  // 弹窗打开时编辑器失焦，记住插入位置
  const rememberPos = () => { const b = curBlock() || selectedAtom(); if (b) lastPos = b; };

  function insertMedia(list, ref) {
    if (!list?.length) return;
    checkpoint();
    const at = ref && ref.isConnected ? ref : lastPos?.isConnected ? lastPos : root.lastElementChild;
    const els = insertBlocksAfter(at, list.map((a) => ({ t: "media", id: a.id, caption: a.caption || "" })));
    const last = els[els.length - 1];
    const next = last.nextElementSibling;
    if (next && isText(next)) setCaret(next, 0); else selectAtom(last);
    changed();
  }

  async function uploadAndInsert(files, ref) {
    if (!files?.length || !opts.uploadFiles) return;
    checkpoint();
    const at = ref && ref.isConnected ? ref : curBlock() || lastPos || root.lastElementChild;
    const holders = insertBlocksAfter(at, [...files].map((f) => ({ t: "uploading", name: f.name })));
    changed();
    const jobs = opts.uploadFiles([...files]);
    await Promise.all(jobs.map(async (p, i) => {
      const a = await p.catch(() => null);
      const h = holders[i];
      if (!h.isConnected) return;
      if (a) {
        const el = makeBlock({ t: "media", id: a.id, caption: "" });
        h.replaceWith(el);
        hydrateProse(el);
      } else h.remove();
      changed();
    }));
  }

  // ---------- 事件：输入 ----------

  root.addEventListener("beforeinput", (e) => {
    if (e.target !== root) return;  // 影像说明输入框自己处理
    const t = e.inputType;
    if (t === "historyUndo") { e.preventDefault(); return undo(); }
    if (t === "historyRedo") { e.preventDefault(); return redo(); }
    const atom = selectedAtom();
    if (atom) {
      e.preventDefault();
      if (t === "deleteContentBackward" || t === "deleteContentForward" || t === "deleteByCut") removeAtom(atom, t === "deleteContentBackward" ? -1 : 1);
      else if (t === "insertParagraph") { checkpoint(); const p = makeBlock({ t: "p" }); atom.after(p); setCaret(p, 0); changed(); }
      return;
    }
    const b = curBlock();
    const r = sel().rangeCount ? sel().getRangeAt(0) : null;
    if (t === "insertParagraph") {
      e.preventDefault();
      if (b?.dataset.t === "code") {
        // 代码块：末尾连续两次回车退出
        if (r.collapsed && caretOffset(b) === blen(b) && /\n$/.test(plainOf(b))) {
          checkpoint();
          const brs = $$("br", b);
          brs[brs.length - 1]?.remove();
          const tailBr = b.lastChild;
          if (tailBr?.nodeName === "BR" && tailBr.previousSibling?.nodeName === "BR") tailBr.remove();
          fillEmpty(b);
          const p = makeBlock({ t: "p" });
          b.after(p);
          setCaret(p, 0);
          return changed();
        }
        return insertBr();
      }
      return splitBlock();
    }
    if (t === "insertLineBreak") {
      e.preventDefault();
      if (b && ["p", "quote", "code"].includes(b.dataset.t)) return insertBr();
      return splitBlock();
    }
    if ((t === "deleteContentBackward" || t === "deleteWordBackward" || t === "deleteSoftLineBackward") && b && r?.collapsed && caretOffset(b) === 0) {
      e.preventDefault();
      return backspaceAtStart(b);
    }
    if ((t === "deleteContentForward" || t === "deleteWordForward") && b && r?.collapsed && caretOffset(b) >= blen(b)) {
      e.preventDefault();
      return deleteAtEnd(b);
    }
    if (t.startsWith("delete") && r && !r.collapsed && coversAll(r)) {
      e.preventDefault();
      checkpoint();
      root.innerHTML = "";
      normalize();
      setCaret(root.firstElementChild, 0);
      return changed();
    }
    if (t.startsWith("format") || t.startsWith("delete") || t === "insertFromPaste" || t === "insertFromDrop") { checkpoint(); return; }
    if (!burst) { checkpoint(); burst = true; }
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { burst = false; }, 700);
  });

  const coversAll = (r) => {
    const all = document.createRange();
    all.selectNodeContents(root);
    return r.compareBoundaryPoints(Range.START_TO_START, all) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, all) >= 0
      || (blockOf(r.startContainer) === root.firstElementChild && blockOf(r.endContainer) === root.lastElementChild
        && caretAt(r.startContainer, r.startOffset, root.firstElementChild) === 0
        && caretAt(r.endContainer, r.endOffset, root.lastElementChild) >= blen(root.lastElementChild));
  };
  function caretAt(container, offset, block) {
    if (!block || !block.contains(container) && container !== block) return -1;
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(container, offset);
    return lenOf(pre.cloneContents());
  }

  const SHORTCUTS = [
    [/^#$/, "h1"], [/^##$/, "h2"], [/^###$/, "h3"],
    [/^[-*+•]$/, "ul"], [/^1[.)。．]$/, "ol"],
    [/^(\[ ?\]|【】|【 】)$/, "todo"], [/^\[[xX]\]$/, "todo+"],
    [/^[>》]$/, "quote"],
  ];

  root.addEventListener("input", (e) => {
    if (e.target !== root) {
      // 影像说明：同步到 value 属性，撤销快照（innerHTML）才能带上
      if (e.target.matches?.("input.cap")) { e.target.setAttribute("value", e.target.value); opts.onChange?.(); }
      return;
    }
    const b = curBlock();
    if (e.inputType === "insertText" && b && isText(b)) {
      const d = e.data || "";
      // Markdown 快捷输入：行首「# 」「- 」「1. 」「[] 」「> 」
      if ((d === " " || d === " ") && b.dataset.t === "p") {
        const off = caretOffset(b);
        const before = b.textContent.slice(0, off).replace(/ /g, " ");
        const prefix = before.slice(0, -1);
        if (before.length <= 5 && before.endsWith(" ")) {
          const hit = SHORTCUTS.find(([re]) => re.test(prefix));
          if (hit) {
            checkpoint();
            const r = document.createRange();
            r.setStart(b, 0);
            const s = sel().getRangeAt(0);
            r.setEnd(s.startContainer, s.startOffset);
            r.deleteContents();
            const t = hit[1] === "todo+" ? "todo" : hit[1];
            setType(b, t, { checkpointed: true });
            if (hit[1] === "todo+") b.dataset.checked = "1";
            setCaret(b, 0);
            return changed();
          }
        }
      }
      if ((d === "/" || d === "、") && b.dataset.t !== "code") openSlash(b);
    }
    if (menu?.mode === "slash") updateSlash();
    changed();
    keepCaretVisible();
  });

  root.addEventListener("keydown", (e) => {
    if (e.target.matches?.("input.cap")) {
      // 说明框里回车：跳到图片下方继续写；Esc：回到选中图片
      const b = blockOf(e.target);
      if (e.key === "Enter" && !e.isComposing && b) {
        e.preventDefault();
        const next = b.nextElementSibling;
        if (next && isEmpty(next) && next.dataset.t === "p") setCaret(next, 0);
        else { checkpoint(); const p = makeBlock({ t: "p" }); b.after(p); setCaret(p, 0); changed(); }
      } else if (e.key === "Escape" && b) { e.preventDefault(); selectAtom(b); }
      return;
    }
    if (e.target !== root) return;
    if (menu && handleMenuKey(e)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === "y") { e.preventDefault(); return redo(); }
    if (mod && e.shiftKey && k === "x") { e.preventDefault(); return format("strike"); }
    if (mod && k === "e") { e.preventDefault(); return format("code"); }
    if (mod && k === "k") { e.preventDefault(); return format("link"); }
    if (mod && e.altKey && /^[0-3]$/.test(e.key)) { e.preventDefault(); return setType(curBlock(), e.key === "0" ? "p" : `h${e.key}`); }
    if (mod && k === "enter") {
      const b = curBlock();
      if (b?.dataset.t === "todo") { e.preventDefault(); checkpoint(); b.dataset.checked = b.dataset.checked === "1" ? "" : "1"; return changed(); }
      if (b) { e.preventDefault(); checkpoint(); const p = makeBlock({ t: "p" }); b.after(p); setCaret(p, 0); return changed(); }
    }
    const atom = selectedAtom();
    if (atom) {
      if (k === "arrowup" || k === "arrowleft") {
        e.preventDefault();
        const p = atom.previousElementSibling;
        if (!p) { checkpoint(); const n = makeBlock({ t: "p" }); atom.before(n); setCaret(n, 0); return changed(); }
        return isAtom(p) ? selectAtom(p) : caretEnd(p);
      }
      if (k === "arrowdown" || k === "arrowright") {
        e.preventDefault();
        const n = atom.nextElementSibling;
        return n ? (isAtom(n) ? selectAtom(n) : setCaret(n, 0)) : undefined;
      }
      if (k === "backspace" || k === "delete") { e.preventDefault(); return removeAtom(atom, k === "backspace" ? -1 : 1); }
      if (k === "enter") { e.preventDefault(); checkpoint(); const p = makeBlock({ t: "p" }); atom.after(p); setCaret(p, 0); return changed(); }
      if (e.key.length === 1 && !mod) { e.preventDefault(); return; }
      return;
    }
    const b = curBlock();
    if (!b) return;
    if (k === "tab") {
      e.preventDefault();
      if (indent(b, e.shiftKey ? -1 : 1)) return;
      if (b.dataset.t === "code" && !e.shiftKey) { checkpoint(); document.execCommand("insertText", false, "  "); }
      return;
    }
    // 方向键越过影像块：选中它
    if ((k === "arrowup" || k === "arrowleft") && sel().isCollapsed && caretOffset(b) === 0 && isAtom(b.previousElementSibling)) {
      if (k === "arrowleft" || isFirstLine(b)) { e.preventDefault(); return selectAtom(b.previousElementSibling); }
    }
    if ((k === "arrowdown" || k === "arrowright") && sel().isCollapsed && caretOffset(b) >= blen(b) && isAtom(b.nextElementSibling)) {
      e.preventDefault();
      return selectAtom(b.nextElementSibling);
    }
  });

  const isFirstLine = (b) => {
    const r = sel().getRangeAt(0).getBoundingClientRect();
    return !r.height || r.top - b.getBoundingClientRect().top < 12;
  };

  // 粘贴：图片文件直接上传插入；多行文字按 Markdown 解析成块；其余一律按纯文字
  root.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd || e.target !== root && !root.contains(e.target) || e.target.matches?.("input.cap")) return;
    const files = [...cd.files];
    e.preventDefault();
    if (files.length) return uploadAndInsert(files);
    const text = (cd.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    if (!text) return;
    if (selectedAtom()) return;
    const b = curBlock();
    if (b?.dataset.t === "code" || !text.includes("\n")) {
      checkpoint();
      const s = text;
      if (b?.dataset.t === "code" && s.includes("\n")) {
        const r = sel().getRangeAt(0);
        r.deleteContents();
        const frag = document.createDocumentFragment();
        s.split("\n").forEach((line, i) => { if (i) frag.append(document.createElement("br")); frag.append(line); });
        const last = frag.lastChild;
        r.insertNode(frag);
        const nr = document.createRange();
        nr.setStartAfter(last);
        sel().removeAllRanges();
        sel().addRange(nr);
      } else document.execCommand("insertText", false, s);
      burst = false;
      return changed();
    }
    // 普通多行文本：每行一段（代码块原样保留）
    const md = text.includes("```") ? text : text.replace(/([^\n])\n(?=[^\n])/g, "$1\n\n");
    insertBlocksAtCaret(parse(md));
  });

  root.addEventListener("copy", (e) => copyAsMarkdown(e, false));
  root.addEventListener("cut", (e) => copyAsMarkdown(e, true));
  /** 复制选中的多个块时，同时放一份 Markdown 到剪贴板，粘贴回来能保留格式 */
  function copyAsMarkdown(e, cut) {
    if (e.target.matches?.("input.cap") || !inRoot() || sel().isCollapsed) return;
    const r = sel().getRangeAt(0);
    const a = blockOf(r.startContainer) || selectedAtom(), z = blockOf(r.endContainer) || a;
    if (!a || a === z && !isAtom(a)) return;  // 块内复制交给浏览器
    const list = blocks();
    const part = list.slice(list.indexOf(a), list.indexOf(z) + 1).map(toBlock).filter(Boolean);
    e.preventDefault();
    e.clipboardData.setData("text/plain", serialize(part));
    if (cut) { checkpoint(); r.deleteContents(); if (selectedAtom()) removeAtom(selectedAtom(), -1); changed(); }
  }

  // ---------- 点击 ----------

  root.addEventListener("mousedown", (e) => {
    const b = blockOf(e.target);
    if (!b) return;
    if (isAtom(b) && !e.target.closest("figcaption, video, audio, a")) {
      e.preventDefault();
      selectAtom(b);
      return;
    }
    // 待办的勾选框（::before 伪元素，按位置判断）
    if (b.dataset.t === "todo") {
      const x = e.clientX - b.getBoundingClientRect().left - (+b.dataset.indent || 0) * 26;
      if (x >= 0 && x < 26) {
        e.preventDefault();
        checkpoint();
        b.dataset.checked = b.dataset.checked === "1" ? "" : "1";
        changed();
      }
    }
  });
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); open(a.href, "_blank", "noopener"); }
  });

  // ---------- 选区变化：工具栏 / 原子块高亮 / 菜单 ----------

  const onSelChange = () => {
    if (!host.isConnected) return;
    refreshAtomSel();
    markCurrent();
    if (inRoot()) rememberPos();
    if (menu?.mode === "slash") updateSlash();
    updateBar();
  };
  document.addEventListener("selectionchange", onSelChange);
  // 图片加载、侧栏开关等会改变排版：跟着重新定位占位提示
  const ro = new ResizeObserver(() => markCurrent());
  ro.observe(root);
  // 软键盘弹出 / 收起：可见区域变了，把光标挪回视野
  const onViewport = () => { if (document.activeElement === root) keepCaretVisible(); };
  window.visualViewport?.addEventListener("resize", onViewport);

  // ---------- 浮动工具栏 ----------

  let barLink = false, savedRange = null;
  function updateBar() {
    if (barLink) return;
    const s = sel();
    if (!inRoot() || s.isCollapsed || selectedAtom()) { bar.hidden = true; return; }
    const r = s.getRangeAt(0);
    const a = blockOf(r.startContainer), z = blockOf(r.endContainer);
    if (!a || !isText(a) || a.dataset.t === "code" || (z && z.dataset.t === "code") || !r.toString().trim()) { bar.hidden = true; return; }
    const st = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    const inCode = !!(r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest("code");
    const inLink = !!(r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest("a");
    const ty = TYPE_ITEMS.find((x) => x.k === a.dataset.t) || TYPE_ITEMS[0];
    bar.innerHTML = `<button data-f="type" class="eb-type" title="转换为">${ty.label}<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button><i></i>
      <button data-f="bold" class="${st("bold") ? "on" : ""}" title="粗体 Ctrl+B"><b>B</b></button>
      <button data-f="italic" class="${st("italic") ? "on" : ""}" title="斜体 Ctrl+I"><i style="font-family:Georgia,serif">I</i></button>
      <button data-f="strike" class="${st("strikeThrough") ? "on" : ""}" title="删除线 Ctrl+Shift+X"><s>S</s></button>
      <button data-f="code" class="${inCode ? "on" : ""}" title="行内代码 Ctrl+E"><span class="mono">&lt;/&gt;</span></button>
      <button data-f="link" class="${inLink ? "on" : ""}" title="${inLink ? "取消链接" : "链接 Ctrl+K"}">${ICON.link}</button>`;
    bar.hidden = false;
    placeFloating(bar, r.getBoundingClientRect(), "above");
  }

  function placeFloating(el, rect, prefer = "below") {
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), innerWidth - w - 8);
    let y = prefer === "above" ? rect.top - h - 8 : rect.bottom + 6;
    if (prefer === "above" && y < 8) y = rect.bottom + 8;
    if (prefer === "below" && y + h > innerHeight - 8) y = Math.max(8, rect.top - h - 6);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  bar.addEventListener("mousedown", (e) => { if (!e.target.closest("input")) e.preventDefault(); });
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    if (b.dataset.f === "type") {
      const blk = blockOf(sel().anchorNode);
      return openMenu({ mode: "type", block: blk, rect: b.getBoundingClientRect(), items: TYPE_ITEMS });
    }
    format(b.dataset.f);
  });

  function format(f) {
    if (!inRoot() || sel().isCollapsed) return;
    const r = sel().getRangeAt(0);
    const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    if (f === "bold" || f === "italic" || f === "strike") {
      checkpoint();
      document.execCommand(f === "strike" ? "strikeThrough" : f);
      changed();
      return updateBar();
    }
    if (f === "code") {
      checkpoint();
      const c = anc.closest("code");
      if (c) c.replaceWith(document.createTextNode(c.textContent));
      else {
        const text = r.toString().replace(/\n/g, " ");
        r.deleteContents();
        const code = document.createElement("code");
        code.textContent = text;
        r.insertNode(code);
        const nr = document.createRange();
        nr.selectNodeContents(code);
        sel().removeAllRanges();
        sel().addRange(nr);
      }
      changed();
      return updateBar();
    }
    if (f === "link") {
      const a = anc.closest("a");
      if (a) { checkpoint(); a.replaceWith(...a.childNodes); changed(); return updateBar(); }
      savedRange = r.cloneRange();
      barLink = true;
      bar.innerHTML = `<form class="eb-link">${ICON.link}<input type="url" placeholder="粘贴或输入链接，回车确认" required><button class="btn sm primary">确定</button></form>`;
      bar.hidden = false;
      placeFloating(bar, r.getBoundingClientRect(), "above");
      const input = $("input", bar);
      input.focus();
      const done = (url) => {
        barLink = false;
        sel().removeAllRanges();
        sel().addRange(savedRange);
        root.focus({ preventScroll: true });
        if (url) {
          checkpoint();
          document.execCommand("createLink", false, /^[a-z]+:/i.test(url) ? url : `https://${url}`);
          changed();
        }
        updateBar();
      };
      $("form", bar).onsubmit = (ev) => { ev.preventDefault(); done(input.value.trim()); };
      input.onkeydown = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); done(""); } };
      input.onblur = () => setTimeout(() => { if (barLink) { barLink = false; bar.hidden = true; } }, 150);
    }
  }

  // ---------- 菜单（「/」插入、「+」插入、块菜单、转换类型） ----------

  let menu = null;  // { mode, block, items, idx, slashOff }

  function openSlash(b) {
    const off = caretOffset(b);
    openMenu({ mode: "slash", block: b, slashOff: off - 1, rect: caretRect(), items: [...TYPE_ITEMS, ...INSERT_ITEMS] });
  }

  function caretRect() {
    const r = sel().getRangeAt(0).cloneRange();
    let rect = r.getBoundingClientRect();
    if (!rect.height) {
      const b = curBlock();
      rect = b ? b.getBoundingClientRect() : root.getBoundingClientRect();
      return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.top + 24, width: 0, height: 24 };
    }
    return rect;
  }

  function openMenu(m) {
    menu = { idx: 0, q: "", ...m };
    renderMenu();
  }
  function closeMenu() {
    menu = null;
    pop.hidden = true;
    pop.innerHTML = "";
    $$(".blk.picked", root).forEach((x) => x.classList.remove("picked"));
  }

  function filtered() {
    const q = menu.q.trim().toLowerCase();
    if (!q) return menu.items;
    return menu.items.filter((it) => it.label.toLowerCase().includes(q) || it.kw.split(" ").some((w) => w.startsWith(q)));
  }

  function renderMenu() {
    if (!menu) return;
    if (menu.mode === "block") return renderBlockMenu();
    const list = filtered();
    menu.idx = Math.min(menu.idx, Math.max(0, list.length - 1));
    const sec = (title, items) => items.length ? `<div class="ep-h">${title}</div>` + items.map((it) => {
      const i = list.indexOf(it);
      return `<button class="ep-i ${i === menu.idx ? "on" : ""}" data-i="${i}"><span class="ep-ic">${it.icon}</span><span>${it.label}</span>${it.k === menu.block?.dataset.t && menu.mode === "type" ? ICON.check : ""}</button>`;
    }).join("") : "";
    pop.innerHTML = list.length
      ? sec(menu.mode === "type" ? "转换为" : "基础", list.filter((x) => TYPE_ITEMS.includes(x))) + sec("插入", list.filter((x) => INSERT_ITEMS.includes(x)))
      : `<div class="ep-none">没有匹配「${esc(menu.q)}」的内容</div>`;
    pop.hidden = false;
    placeFloating(pop, menu.rect, "below");
    $(".ep-i.on", pop)?.scrollIntoView({ block: "nearest" });
  }

  function updateSlash() {
    const b = curBlock();
    if (!menu || b !== menu.block || !sel().isCollapsed) return closeMenu();
    const off = caretOffset(b);
    const text = b.textContent;
    if (off <= menu.slashOff || !/^[/、]$/.test(text[menu.slashOff] || "")) return closeMenu();
    const q = text.slice(menu.slashOff + 1, off);
    if (/\s/.test(q) || q.length > 12) return closeMenu();
    if (q !== menu.q) { menu.q = q; menu.idx = 0; }
    renderMenu();
  }

  function handleMenuKey(e) {
    if (e.isComposing) return false;
    const list = menu.mode === "block" ? [] : filtered();
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return true; }
    if (menu.mode === "block") return false;
    if (e.key === "ArrowDown") { e.preventDefault(); menu.idx = (menu.idx + 1) % Math.max(list.length, 1); renderMenu(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); menu.idx = (menu.idx - 1 + list.length) % Math.max(list.length, 1); renderMenu(); return true; }
    if (e.key === "Enter" || e.key === "Tab") {
      if (!list.length) { closeMenu(); return false; }
      e.preventDefault();
      runItem(list[menu.idx]);
      return true;
    }
    return false;
  }

  pop.addEventListener("mousedown", (e) => { if (!e.target.closest("input")) e.preventDefault(); });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b && menu && menu.mode !== "block") return runItem(filtered()[+b.dataset.i]);
    const act = e.target.closest("[data-a]");
    if (act && menu?.mode === "block") return runBlockAction(act.dataset.a, menu.block);
  });

  async function runItem(it) {
    if (!it || !menu) return;
    const m = menu;
    closeMenu();
    let b = m.block;
    if (!b?.isConnected) return;
    if (m.mode === "slash") {
      // 删掉「/查询词」
      checkpoint();
      const off = caretOffset(b);
      const r = document.createRange();
      const start = locate(b, m.slashOff), end = locate(b, off);
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      r.deleteContents();
      fillEmpty(b);
      setCaret(b, m.slashOff);
    } else if (m.mode === "plus" && !(isEmpty(b) && b.dataset.t === "p")) {
      // 「+」在非空块上：在其下方新建一块
      checkpoint();
      const p = makeBlock({ t: "p" });
      b.after(p);
      b = p;
      setCaret(p, 0);
    } else checkpoint();

    if (TYPE_ITEMS.includes(it)) {
      if (m.mode === "type" && !sel().isCollapsed && blockOf(sel().focusNode) !== b) {
        // 选区跨多块：全部转换
        const r = sel().getRangeAt(0);
        const list = blocks();
        const a = list.indexOf(blockOf(r.startContainer)), z = list.indexOf(blockOf(r.endContainer));
        for (const x of list.slice(a, z + 1)) if (isText(x)) setType(x, it.k, { checkpointed: true });
      } else {
        const off = isText(b) && inRoot() && curBlock() === b ? caretOffset(b) : 0;
        setType(b, it.k, { checkpointed: true });
        setCaret(b, off);
      }
      return changed();
    }
    if (it.k === "hr") {
      const hr = makeBlock({ t: "hr" });
      if (isEmpty(b) && b.dataset.t === "p") b.replaceWith(hr); else b.after(hr);
      normalize();
      const n = hr.nextElementSibling;
      if (n && isText(n)) setCaret(n, 0);
      return changed();
    }
    lastPos = b;
    if (it.k === "media") {
      const list = await opts.pickMedia?.();
      if (list?.length) insertMedia(list, b);
      else if (b.isConnected) setCaret(b, blen(b));
      return;
    }
    if (it.k === "upload") {
      const files = await pickLocal();
      if (files.length) uploadAndInsert(files, b);
    }
  }

  function pickLocal() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "image/*,video/*,audio/*";
      input.onchange = () => resolve([...input.files]);
      input.click();
    });
  }

  /** 字符偏移 → DOM 位置 */
  function locate(block, off) {
    let rem = off;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (rem <= c.length) return { node: c, offset: rem }; rem -= c.length; }
        else if (c.nodeName === "BR") { if (rem === 0) return { node: n, offset: [...n.childNodes].indexOf(c) }; rem -= 1; }
        else if (c.nodeType === 1) { const r = walk(c); if (r) return r; }
      }
      return null;
    };
    return walk(block) || { node: block, offset: block.childNodes.length - (block.lastChild?.nodeName === "BR" ? 1 : 0) };
  }

  // ---------- 左侧手柄：+ 插入、⋮⋮ 拖动 / 菜单 ----------

  let hoverBlock = null;
  function blockAtY(y) {
    for (const el of root.children) {
      const r = el.getBoundingClientRect();
      if (y >= r.top - 4 && y <= r.bottom + 4) return el;
    }
    return null;
  }
  function showHandle(el) {
    hoverBlock = el;
    if (!el) { handle.hidden = true; return; }
    const hr = host.getBoundingClientRect(), br = el.getBoundingClientRect();
    const lh = isAtom(el) ? 28 : Math.min(parseFloat(getComputedStyle(el).lineHeight) || 26, br.height);
    handle.style.top = `${br.top - hr.top + (isAtom(el) ? 6 : (lh - 26) / 2 + (parseFloat(getComputedStyle(el).paddingTop) || 0))}px`;
    handle.hidden = false;
  }
  const onMove = (e) => {
    if (dragging || menu?.mode === "block") return;
    if (e.target.closest?.(".ed-handle")) return;
    showHandle(blockAtY(e.clientY));
  };
  host.addEventListener("mousemove", onMove);
  host.addEventListener("mouseleave", () => { if (!dragging && menu?.mode !== "block") handle.hidden = true; });
  root.addEventListener("keydown", () => { if (!menu) handle.hidden = true; }, true);

  $(".eh-plus", handle).addEventListener("mousedown", (e) => e.preventDefault());
  $(".eh-plus", handle).addEventListener("click", () => {
    const b = hoverBlock;
    if (!b) return;
    if (isText(b)) caretEnd(b); else selectAtom(b);
    openMenu({ mode: "plus", block: b, rect: $(".eh-plus", handle).getBoundingClientRect(), items: [...TYPE_ITEMS, ...INSERT_ITEMS] });
  });

  let dragging = null;
  const drag = $(".eh-drag", handle);
  drag.addEventListener("mousedown", (e) => e.preventDefault());
  drag.addEventListener("pointerdown", (e) => {
    const b = hoverBlock;
    if (!b || e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, target = null;
    drag.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!moved) { moved = true; dragging = b; b.classList.add("dragging"); closeMenu(); }
      // 找到最近的缝隙
      const hr = host.getBoundingClientRect();
      let best = null;
      for (const el of root.children) {
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { best = { el, before: true, y: r.top }; break; }
        best = { el, before: false, y: r.bottom };
      }
      target = best;
      if (best) { dropLine.hidden = false; dropLine.style.top = `${best.y - hr.top - 1}px`; }
      if (ev.clientY < 60) scrollBy(0, -12); else if (ev.clientY > innerHeight - 60) scrollBy(0, 12);
    };
    const up = () => {
      drag.removeEventListener("pointermove", mv);
      drag.removeEventListener("pointerup", up);
      drag.removeEventListener("pointercancel", up);
      dropLine.hidden = true;
      b.classList.remove("dragging");
      dragging = null;
      if (!moved) {
        if (isAtom(b)) selectAtom(b); else if (isText(b)) caretEnd(b);
        b.classList.add("picked");
        return openMenu({ mode: "block", block: b, rect: drag.getBoundingClientRect() });
      }
      if (target && target.el !== b) {
        checkpoint();
        if (target.before) target.el.before(b); else target.el.after(b);
        normalize();
        if (isAtom(b)) selectAtom(b); else caretEnd(b);
        changed();
      }
    };
    drag.addEventListener("pointermove", mv);
    drag.addEventListener("pointerup", up);
    drag.addEventListener("pointercancel", up);
  });

  function renderBlockMenu() {
    const b = menu.block;
    const types = isText(b) ? `<div class="ep-h">转换为</div><div class="ep-grid">${TYPE_ITEMS.map((it) =>
      `<button class="ep-g ${it.k === b.dataset.t ? "on" : ""}" data-a="t:${it.k}" title="${it.label}">${it.icon}</button>`).join("")}</div><div class="ep-sep"></div>` : "";
    const list = blocks();
    const i = list.indexOf(b);
    pop.innerHTML = `${types}
      ${LIST_TYPES.includes(b.dataset.t) ? `<button class="ep-i" data-a="indent"><span class="ep-ic">${G("→")}</span><span>增加缩进</span><kbd>Tab</kbd></button>
        <button class="ep-i" data-a="outdent" ${+b.dataset.indent ? "" : "disabled"}><span class="ep-ic">${G("←")}</span><span>减少缩进</span><kbd>⇧Tab</kbd></button>` : ""}
      <button class="ep-i" data-a="up" ${i > 0 ? "" : "disabled"}><span class="ep-ic">${G("↑")}</span><span>上移</span></button>
      <button class="ep-i" data-a="down" ${i < list.length - 1 ? "" : "disabled"}><span class="ep-ic">${G("↓")}</span><span>下移</span></button>
      ${isText(b) ? `<button class="ep-i" data-a="dup"><span class="ep-ic">${ICON.copy}</span><span>复制一份</span></button>` : ""}
      <button class="ep-i" data-a="above"><span class="ep-ic">${ICON.plus}</span><span>在上方插入空行</span></button>
      <div class="ep-sep"></div>
      <button class="ep-i danger" data-a="del"><span class="ep-ic">${ICON.trash}</span><span>删除</span><kbd>Del</kbd></button>`;
    pop.hidden = false;
    placeFloating(pop, menu.rect, "below");
  }

  function runBlockAction(a, b) {
    closeMenu();
    handle.hidden = true;
    if (!b?.isConnected) return;
    if (a.startsWith("t:")) { setType(b, a.slice(2)); return caretEnd(b); }
    if (a === "indent" || a === "outdent") { indent(b, a === "indent" ? 1 : -1); return caretEnd(b); }
    checkpoint();
    if (a === "up" && b.previousElementSibling) b.previousElementSibling.before(b);
    if (a === "down" && b.nextElementSibling) b.nextElementSibling.after(b);
    if (a === "dup") { const c = b.cloneNode(true); c.classList.remove("cur", "sel"); b.after(c); }
    if (a === "above") { const p = makeBlock({ t: "p" }); b.before(p); normalize(); setCaret(p, 0); return changed(); }
    if (a === "del") {
      const next = b.nextElementSibling || b.previousElementSibling;
      b.remove();
      normalize();
      const n = next?.isConnected ? next : root.firstElementChild;
      if (isAtom(n)) selectAtom(n); else setCaret(n, 0);
      return changed();
    }
    normalize();
    if (isAtom(b)) selectAtom(b); else caretEnd(b);
    changed();
  }

  // 点击编辑器外关闭菜单
  const onDocDown = (e) => {
    if (menu && !pop.contains(e.target) && !handle.contains(e.target)) closeMenu();
    if (!bar.contains(e.target) && !root.contains(e.target)) { barLink = false; bar.hidden = true; }
  };
  document.addEventListener("mousedown", onDocDown);
  const onScroll = () => { if (menu) closeMenu(); if (!bar.hidden && !barLink) updateBar(); };
  addEventListener("scroll", onScroll, { passive: true });

  // 点击文档末尾空白处：光标放到最后
  host.addEventListener("mousedown", (e) => {
    if (e.target !== host) return;
    const last = root.lastElementChild;
    if (e.clientY > last.getBoundingClientRect().bottom) {
      e.preventDefault();
      if (!isEmpty(last) || last.dataset.t !== "p") { checkpoint(); root.append(makeBlock({ t: "p" })); changed(); }
      setCaret(root.lastElementChild, 0);
    }
  });

  setContent(opts.markdown || "");
  markCurrent();

  return {
    root,
    getBlocks: () => blocks().map(toBlock).filter(Boolean),
    getMarkdown() { return serialize(this.getBlocks()); },
    plainText() { return plainOfBlocks(this.getBlocks()); },
    /** 正文里已经插入的影像 id */
    usedMedia: () => new Set($$('.blk[data-t="media"]', root).map((el) => el.dataset.id)),
    setMarkdown(md) { checkpoint(); setContent(md); changed(); },
    insertMedia,
    uploadAndInsert,
    /** 拖放：把光标移到落点再插入 */
    dropFiles(files, ev) {
      if (ev && document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
        if (r && root.contains(r.startContainer)) { sel().removeAllRanges(); sel().addRange(r); rememberPos(); }
      }
      return uploadAndInsert(files, lastPos);
    },
    /** 影像信息变化后（例如刚上传）刷新显示为「不可用」的块 */
    refreshMedia() {
      $$('.blk[data-t="media"]', root).forEach((el) => {
        if ($(".pm.missing", el) && opts.getMedia(el.dataset.id)) {
          el.innerHTML = mediaInner(el.dataset.id, $("input.cap", el)?.value || "");
          hydrateProse(el);
        }
      });
    },
    focusEnd() { caretEnd(root.lastElementChild); },
    format, undo, redo,
    /** 手机工具条：再点一次同一类型则还原为正文 */
    setType: (t) => {
      const b = curBlock() || lastPos;
      if (!b?.isConnected || !isText(b)) return;
      setType(b, b.dataset.t === t ? "p" : t);
      caretEnd(b);
    },
    openInsertMenu(rect) {
      const b = curBlock() || lastPos || root.lastElementChild;
      if (isText(b)) caretEnd(b);
      openMenu({ mode: "plus", block: b, rect: rect || caretRect(), items: [...TYPE_ITEMS, ...INSERT_ITEMS] });
    },
    destroy() {
      document.removeEventListener("selectionchange", onSelChange);
      ro.disconnect();
      window.visualViewport?.removeEventListener("resize", onViewport);
      cancelAnimationFrame(caretRaf);
      document.removeEventListener("mousedown", onDocDown);
      removeEventListener("scroll", onScroll);
      pop.remove();
      bar.remove();
    },
  };
}
