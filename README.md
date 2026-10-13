# 数字日记

纸质日记的数字伴侣。日记写在纸上；这里管理与之关联的**照片、视频、录音**，以及纸质原稿的扫描件，并提供 **MCP 连接器**让 AI Agent 直接增删改查。

## 核心概念

- **图库**：所有文件按拍摄时间（EXIF / 视频元数据 / 文件时间）排成相册。上传后可以先不整理，放在「未归组」。
- **日记 = 一个编号**：在图库里多选一组内容 →「分配编号」，得到 `YYMMDD-序号`（如 `261013-1`）。把编号写回纸质本，或打印成二维码贴上（二维码只包含编号）。编号永不复用，一天可以有多篇。
- 每篇日记包含两类内容：
  - **富媒体**：一组照片、视频、录音；
  - **纸质原稿**：手写页的照片，用于「阅读」；
  - **正文**：把纸上的文字转写进来，与本篇的照片、视频、录音图文混排（以 Markdown 保存）。
- **正文编辑**：飞书文档式的块编辑器。输入「/」（中文输入法下「、」也可以）插入标题、列表、待办、引用、代码块、分割线或本篇影像；行首输入 `# `、`- `、`1. `、`[] `、`> ` 自动转换；选中文字出现格式工具栏；悬停行首的 ⋮⋮ 可拖动排序或转换类型；粘贴或拖入图片会自动上传并插入到光标处。插入影像的弹窗支持方向键移动、回车选中、空格插入。宽屏下可打开「原稿对照」，一边看手写页一边转写。自动保存。
- **阅读**：按时间顺序翻阅日记，可在「转写」（图文混排的正文）和「原稿」（手写页照片）之间切换；没有放进正文的影像附在每篇末尾。
- **统计**：日记热力图 / 影像热力图、AI 调用热力图、常用工具与时段分布、媒体构成、近 12 个月趋势。
- **扫码**：手机扫纸上的二维码，或输入编号，直接打开对应日记。

另外：中文全文搜索、回收站保护（网页与 MCP 的删除都只进回收站）、一键导出 zip。界面为浅黄色纸张风格，电脑端是左侧边栏，手机端是底部标签栏。单用户、无登录。

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
| `TZ` | `Asia/Shanghai` | 决定「今天」是哪天，以及照片按哪天分组 |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `/data` | 数据目录 |
| `MCP_MAX_UPLOAD_MB` | `200` | MCP 单次上传大小上限 |

> **关于扫码**：浏览器只允许在 https（或 localhost）下打开摄像头实时扫码。通过 `http://局域网IP` 访问时，扫码页提供「拍照 / 选图识别」，同样能识别。想用实时扫码，可在前面加一层反向代理（Caddy / Nginx / NAS 自带）提供 https。

> **安全提示**：本服务没有登录。请只在局域网或 VPN（如 Tailscale）内使用，不要直接暴露到公网。

## 连接 AI（MCP）

MCP 端点：`http://<服务器>:3000/mcp`（标准 Streamable HTTP）。网页「导出与连接」页面里有自动填好地址的配置。

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

### 工具列表

| 工具 | 作用 |
| --- | --- |
| `list_media` | 浏览图库：按类型、所属日记、未归组、拍摄日期、关键词过滤 |
| `add_media` | 上传文件（base64 / 纯文字 / URL），可直接归入某篇日记，作为富媒体或原稿 |
| `get_media` | 读取文件：图片直接返回图像，文字返回内容 |
| `assign_media` / `unassign_media` | 归入日记（富媒体或原稿）/ 移回未归组 |
| `update_media` | 修改说明、排序 |
| `delete_media` / `restore_media` | 移入回收站 / 恢复 |
| `create_entry` | 新建日记并分配编号，可同时带上 `media_ids` / `page_ids` / `body` |
| `list_entries` / `search` / `get_entry` | 列出、全文搜索、查看日记 |
| `update_entry` | 修改标题、正文 `body`、备注、标签。正文中用单独一行 `![说明](media:附件ID)` 插入影像 |
| `delete_entry` / `restore_entry` | 移入回收站 / 恢复 |
| `list_trash` / `list_tags` / `stats` | 回收站、标签、统计 |

**文件保护**：MCP 不提供永久删除，也不能覆盖已上传的文件。原文件写入后设为只读，只有网页回收站的「永久删除」才会真正删除。每次 MCP 调用都会记录下来，显示在统计页的 AI 调用热力图里。

## 开发

```bash
npm install
npm run dev      # 编译并启动，数据存放在 ./data
npm test         # 运行测试
```

技术栈：Node.js + TypeScript、Express、SQLite（better-sqlite3，FTS5 trigram 中文检索）、sharp + ffmpeg（缩略图、时长）、exifr（拍摄时间）、官方 MCP SDK；前端为无构建步骤的原生 JS 模块。
