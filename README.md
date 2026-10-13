# 数字日记

纸质日记的数字伴侣：日记写在纸上，这里负责把**图片、音频、视频、文字片段**关联到每一篇纸质日记，并提供 **MCP 连接器**让 AI Agent 直接增删改查。

- **唯一编号**：每篇日记分配 `YYMMDD-序号` 编号（如 `261013-1` = 2026-10-13 第 1 篇），一天可多篇。编号写在纸上，或打印成二维码贴上（二维码只包含编号本身）。编号永不复用。
- **多媒体**：任意文件上传，图片和视频自动生成缩略图；原文件原样保存、不压缩、不修改。
- **扫码 / 输入编号**：手机扫纸上的二维码即可打开对应日记；也可手动输入编号。
- **中文全文搜索**：编号、标题、标签、备注、附件文件名与说明、文字附件内容。
- **回收站保护**：网页和 MCP 的删除都只进回收站；只有在网页回收站里才能永久删除。
- **一键导出**：zip 包，每篇日记一个文件夹（`entry.md` + 原始附件）+ `index.json`。
- 浅黄色纸张风格界面，适配手机和电脑。单用户、无登录。

## 部署（Docker）

```bash
git clone <本仓库> digital-diary && cd digital-diary
# 按需修改 docker-compose.yml 里的 PUBLIC_URL（局域网 IP 或域名）
docker compose up -d --build
```

打开 `http://<服务器IP>:3000`。

所有数据都在 `./data` 目录（`diary.db` 数据库 + `media/` 原始文件 + `thumbs/` 缩略图），**备份这个目录即可**。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | 对外访问地址，MCP 返回的文件链接会用到 |
| `TZ` | `Asia/Shanghai` | 决定「今天」是哪天 |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `/data` | 数据目录 |
| `MCP_MAX_UPLOAD_MB` | `200` | MCP 单次上传大小上限 |

> **关于扫码**：浏览器只允许在 https（或 localhost）下打开摄像头实时扫码。通过 `http://局域网IP` 访问时，扫码页会提供「拍照 / 选图识别」，同样能识别二维码。想用实时扫码，可在前面加一层反向代理（Caddy / Nginx / NAS 自带）提供 https。

> **安全提示**：本服务没有登录。请只在局域网或 VPN（如 Tailscale）内使用，不要直接暴露到公网。

## 连接 AI（MCP）

MCP 端点：`http://<服务器>:3000/mcp`（标准 Streamable HTTP）。

**Claude Code**

```bash
claude mcp add --transport http diary http://<服务器>:3000/mcp
```

**Claude Desktop**（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "diary": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<服务器>:3000/mcp", "--allow-http"]
    }
  }
}
```

网页「更多」页面里有自动填好地址的配置，可直接复制。

### 工具列表

| 工具 | 作用 |
| --- | --- |
| `list_entries` | 按日期范围 / 标签 / 关键词列出日记 |
| `search` | 全文搜索 |
| `get_entry` | 按编号查看日记及全部附件 |
| `create_entry` | 新建日记（不传日期即今天） |
| `update_entry` | 修改标题、备注、标签 |
| `delete_entry` / `restore_entry` | 移入回收站 / 恢复 |
| `add_attachment` | 上传附件（base64、纯文字或 URL） |
| `get_attachment` | 读取附件：图片直接返回图像，文字返回内容 |
| `update_attachment` | 修改说明、排序，或移动到另一篇日记 |
| `delete_attachment` / `restore_attachment` | 移入回收站 / 恢复 |
| `list_trash` / `list_tags` / `stats` | 回收站、标签、统计 |

**文件保护**：MCP 不提供永久删除，也不能覆盖已上传的文件内容。原文件写入后设为只读，只有网页回收站的「永久删除」才会真正删除。

## 开发

```bash
npm install
npm run dev      # 编译并启动，数据存放在 ./data
npm test         # 运行测试
```

技术栈：Node.js + TypeScript、Express、SQLite（better-sqlite3，FTS5 trigram 中文检索）、sharp + ffmpeg（缩略图）、官方 MCP SDK；前端为无构建步骤的原生 JS。
