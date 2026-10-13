// 导出与连接：一键导出、MCP 配置
import { $$, esc, ICON, copy } from "../lib.js";

export async function render({ app }) {
  const origin = location.origin;
  const claudeCode = `claude mcp add --transport http diary ${origin}/mcp`;
  const desktop = JSON.stringify({ mcpServers: { diary: { command: "npx", args: ["-y", "mcp-remote", `${origin}/mcp`, "--allow-http"] } } }, null, 2);
  const code = (s) => `<div class="code-wrap"><pre class="code">${esc(s)}</pre><button class="btn sm" data-copy="${esc(s)}">${ICON.copy}复制</button></div>`;
  app.innerHTML = `
    <div class="page-head"><div><h1>导出与连接</h1></div></div>
    <section class="card panel" style="display:grid;gap:12px">
      <div class="panel-head" style="margin:0"><h2>导出全部数据</h2></div>
      <p class="muted" style="font-size:13px;line-height:1.7">打包为 zip：每篇日记一个文件夹（entry.md、原稿/、媒体/），未归组的文件按月份存放，并附 index.json。回收站中的内容不导出。文件均为原件。</p>
      <div><a class="btn primary" href="/api/export.zip">${ICON.dl}下载导出包</a></div>
    </section>
    <section class="card panel" style="display:grid;gap:12px">
      <div class="panel-head" style="margin:0"><h2>连接 AI（MCP）</h2><span class="sub">标准 Streamable HTTP</span></div>
      <p class="muted" style="font-size:13px;line-height:1.7">端点 <code>${esc(origin)}/mcp</code>。AI 可以浏览图库、分配编号、上传和整理文件；删除只会进入回收站，也无法覆盖已上传的原件。每次调用都会记录在「统计」里。</p>
      <b style="font-size:13.5px">Claude Code</b>${code(claudeCode)}
      <b style="font-size:13.5px">Claude Desktop <span class="muted" style="font-weight:normal">claude_desktop_config.json</span></b>${code(desktop)}
    </section>`;
  $$("[data-copy]", app).forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));
}
