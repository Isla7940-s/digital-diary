// 回收站：网页与 MCP 的删除都先到这里，只有这里能永久删除
import { $, api, esc, ICON, toast, emit, confirmSheet, fmtSize } from "../lib.js";

export async function render({ app }) {
  const t = await api("/trash");
  const empty = !t.entries.length && !t.attachments.length;
  app.innerHTML = `
    <div class="page-head">
      <div><h1>回收站</h1><div class="sub">通过网页或 AI 删除的内容都会先放在这里。只有在这里「永久删除」才会真正删掉文件。</div></div>
      <div class="actions">${empty ? "" : `<button class="btn danger" id="emptyTrash">${ICON.trash}清空回收站</button>`}</div>
    </div>
    <div id="trashBody">
    ${empty ? `<div class="empty"><div class="art">${ICON.trash}</div><h3>回收站是空的</h3></div>` : ""}
    ${t.entries.length ? `<div class="section-title" style="margin-top:6px"><h2>日记与文章 <span class="count">连同其中的原稿与媒体</span></h2></div><div class="list">${t.entries.map((e) => `
      <div class="card list-item" data-type="entries" data-id="${esc(e.id)}">
        <span class="idpill">${esc(e.id)}</span>
        <div class="grow"><div>${e.kind === "article" ? `<span class="muted">文章 · </span>` : ""}${esc(e.title || "未命名")}</div><div class="sub">删除于 ${new Date(e.deleted_at).toLocaleString()}</div></div>
        ${e.kind === "article" ? "" : `<a class="btn sm" href="#/e/${esc(e.id)}">查看</a>`}
        <button class="btn sm" data-act="restore">恢复</button>
        <button class="btn sm danger" data-act="purge">永久删除</button>
      </div>`).join("")}</div>` : ""}
    ${t.attachments.length ? `<div class="section-title"><h2>文件</h2></div><div class="list">${t.attachments.map((a) => `
      <div class="card list-item" data-type="media" data-id="${a.id}">
        ${a.thumb ? `<img src="/thumbs/${a.id}" alt="">` : `<span class="ph">${ICON[a.kind] || ICON.file}</span>`}
        <div class="grow"><div>${esc(a.original_name)}</div><div class="sub">${a.entry_id ? `来自 ${esc(a.entry_id)} · ` : "未归组 · "}${fmtSize(a.size)} · 删除于 ${new Date(a.deleted_at).toLocaleString()}</div></div>
        <button class="btn sm" data-act="restore">恢复</button>
        <button class="btn sm danger" data-act="purge">永久删除</button>
      </div>`).join("")}</div>` : ""}
    </div>`;

  const reload = () => { emit("data-changed"); render({ app }); };
  $("#emptyTrash")?.addEventListener("click", async () => {
    if (!(await confirmSheet("清空回收站？", "回收站中的全部日记和文件将被永久删除，无法撤销。", "永久删除", true))) return;
    const r = await api("/trash", { method: "DELETE" });
    toast(`已永久删除 ${r.purged_entries} 篇日记、${r.purged_attachments} 个文件`);
    reload();
  });
  $("#trashBody").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const { type, id } = b.closest("[data-id]").dataset;
    if (b.dataset.act === "restore") {
      await api(`/${type}/${encodeURIComponent(id)}/restore`, { method: "POST" });
      toast("已恢复");
    } else {
      if (!(await confirmSheet("永久删除？", "删除后无法恢复。", "永久删除", true))) return;
      await api(`/${type}/${encodeURIComponent(id)}/purge`, { method: "DELETE" });
      toast("已永久删除");
    }
    reload();
  });
}
