// 导出与连接：一键导出、MCP 配置
import { $, $$, api, esc, ICON, copy, fmtNum, fmtSize } from "../lib.js";

const SPLITS = [["none", "不分卷"], ["year", "按年"], ["month", "按月"], ["size", "按大小"]];
const SIZES = [[700, "700 MB"], [2048, "2 GB"], [4000, "4 GB"], [8192, "8 GB"]];  // 4 GB 取 4000 MB，给 FAT32 单文件上限留余量
const PREF = "diary.export";

export async function render({ app }) {
  const origin = location.origin;
  const claudeCode = `claude mcp add --transport http diary ${origin}/mcp`;
  const desktop = JSON.stringify({ mcpServers: { diary: { command: "npx", args: ["-y", "mcp-remote", `${origin}/mcp`, "--allow-http"] } } }, null, 2);
  const code = (s) => `<div class="code-wrap"><pre class="code">${esc(s)}</pre><button class="btn sm" data-copy="${esc(s)}">${ICON.copy}复制</button></div>`;
  app.innerHTML = `
    <div class="page-head"><div><h1>导出与连接</h1></div></div>
    <section class="card panel" style="display:grid;gap:12px">
      <div class="panel-head" style="margin:0"><h2>导出全部数据</h2></div>
      <p class="muted" style="font-size:13px;line-height:1.7">打包为 zip：每篇日记一个文件夹（entry.md、原稿/、媒体/），未归组的文件按月份存放，并附 index.json。回收站中的内容不导出。文件均为原件：照片、视频、录音等本身已压缩的格式直接存入，文字和无损格式用 Deflate 最高级别压缩，任何系统都能直接解压。</p>
      <div class="export-opts">
        <span class="muted">分卷</span><div class="seg" id="splitSeg">${SPLITS.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join("")}</div>
        <span class="muted" id="sizeLbl">每卷不超过</span><div class="seg" id="sizeSeg">${SIZES.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join("")}</div>
      </div>
      <p class="muted" style="font-size:12.5px;margin:0">每一卷都是独立的 zip，可单独解压；同一篇日记不会被拆到两卷，所以单篇很大时那一卷可能超过上限。</p>
      <div id="volumes"></div>
    </section>
    <section class="card panel" style="display:grid;gap:12px">
      <div class="panel-head" style="margin:0"><h2>连接 AI（MCP）</h2><span class="sub">标准 Streamable HTTP</span></div>
      <p class="muted" style="font-size:13px;line-height:1.7">端点 <code>${esc(origin)}/mcp</code>。AI 可以浏览图库、分配编号、上传和整理文件；删除只会进入回收站，也无法覆盖已上传的原件。每次调用都会记录在「统计」里。</p>
      <b style="font-size:13.5px">Claude Code</b>${code(claudeCode)}
      <b style="font-size:13.5px">Claude Desktop <span class="muted" style="font-weight:normal">claude_desktop_config.json</span></b>${code(desktop)}
    </section>`;
  $$("[data-copy]", app).forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));

  // ---------- 导出分卷 ----------
  let pref = { split: "none", size: 2048 };
  try { pref = { ...pref, ...JSON.parse(localStorage.getItem(PREF) || "{}") }; } catch {}
  const query = () => `split=${pref.split}${pref.split === "size" ? `&size=${pref.size}` : ""}`;
  let seq = 0;
  const refresh = async () => {
    try { localStorage.setItem(PREF, JSON.stringify(pref)); } catch {}
    $$("#splitSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === pref.split));
    $$("#sizeSeg button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === pref.size));
    $("#sizeSeg").hidden = $("#sizeLbl").hidden = pref.split !== "size";
    const my = ++seq;
    const plan = await api(`/export/plan?${query()}`);
    if (my !== seq) return;
    const vols = plan.volumes;
    const total = vols.reduce((t, v) => t + v.bytes, 0);
    $("#volumes").innerHTML = `
      <div class="vol-head"><span class="muted">${vols.length > 1 ? `共 ${vols.length} 卷 · ` : ""}约 ${fmtSize(total)}</span>
        ${vols.length > 1 ? `<button class="btn primary" id="dlAll">${ICON.dl}依次下载全部</button>` : ""}</div>
      <div class="vol-list">${vols.map((v) => `<div class="vol">
        <span class="vn">${vols.length > 1 ? `第 ${v.n} 卷` : "完整导出"}</span>
        <span class="vl">${esc(v.label || "—")}</span>
        <span class="muted">${fmtNum(v.entries)} 篇${v.loose ? ` · ${fmtNum(v.loose)} 个未归组` : ""}</span>
        <span class="muted r">${fmtSize(v.bytes)}</span>
        <a class="btn ${vols.length > 1 ? "sm" : "primary"}" href="/api/export.zip?${query()}&vol=${v.n}" download="${esc(v.name)}">${ICON.dl}下载</a></div>`).join("")}</div>`;
    $("#dlAll")?.addEventListener("click", async (e) => {
      // 浏览器会先询问是否允许本站下载多个文件；间隔一下，避免被合并或丢弃
      e.currentTarget.disabled = true;
      for (const a of $$("#volumes .vol a")) { a.click(); await new Promise((r) => setTimeout(r, 1500)); }
      e.currentTarget.disabled = false;
    });
  };
  $("#splitSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { pref.split = b.dataset.v; refresh(); } });
  $("#sizeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { pref.size = Number(b.dataset.v); refresh(); } });
  refresh();
}
