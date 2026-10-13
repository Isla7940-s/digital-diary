import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, paths } from "./config.js";
import { storeFile, tmpPath } from "./media.js";
import { todayStr, type Store, type Attachment } from "./store.js";

const INSTRUCTIONS = `这是一本「数字日记」的连接器。主人在纸质笔记本上手写日记，这里管理与之关联的内容：
- 图库：所有图片、视频、录音等文件。文件可以暂不归组（entry_id 为空）。
- 日记：每篇真实的纸质日记对应一个编号，格式 YYMMDD-序号（如 261013-1），写回本子上做关联，永不复用。一天可以有多篇。
  每篇日记包含两类文件：role=media 的富媒体（一组图片/视频/录音），role=page 的纸质原稿（手写页的照片，用于阅读）。
- 典型流程：上传文件到图库 → 选出一组 → create_entry(media_ids=[...]) 分配编号；或 assign_media 归入已有日记。
- 删除只会移入回收站，可用 restore_* 恢复；永久删除只能由主人在网页回收站完成。文件内容只写不改。`;

export function withUrls(a: Attachment) {
  return {
    ...a,
    url: `${config.publicUrl}/files/${a.id}`,
    thumb_url: a.thumb ? `${config.publicUrl}/thumbs/${a.id}` : null,
  };
}

function entryOut<T extends { id: string; pages?: Attachment[]; media?: Attachment[]; preview?: unknown; cover?: unknown }>(e: T) {
  const { preview: _p, cover: _c, ...rest } = e;
  return {
    ...rest,
    page_url: `${config.publicUrl}/#/e/${e.id}`,
    ...(e.pages ? { pages: e.pages.map(withUrls) } : {}),
    ...(e.media ? { media: e.media.map(withUrls) } : {}),
  };
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const roleSchema = z.enum(["media", "page"]).describe("media=富媒体，page=纸质原稿");

async function fetchToTmp(url: string, max: number): Promise<{ file: string; mime?: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error(`文件过大（${len} 字节）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`文件过大（${buf.length} 字节）`);
  const file = tmpPath();
  fs.writeFileSync(file, buf);
  return { file, mime: res.headers.get("content-type")?.split(";")[0] };
}

export function buildMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: "digital-diary", version: "2.0.0" }, { instructions: INSTRUCTIONS });
  const maxBytes = config.mcpMaxUploadMb * 1024 * 1024;

  // 每次调用都记录下来，供统计页的 AI 调用热力图使用
  const original = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, cfg: any, cb: (...a: any[]) => any) =>
    original(name, cfg, async (...args: unknown[]) => {
      const t0 = performance.now();
      try {
        const r = await cb(...args);
        store.logMcpCall(name, !r?.isError, performance.now() - t0);
        return r;
      } catch (e) {
        store.logMcpCall(name, false, performance.now() - t0);
        throw e;
      }
    });

  // ---------- 日记 ----------

  server.registerTool("list_entries", {
    title: "列出日记",
    description: "按日期倒序列出日记，可按日期范围、标签、关键词过滤。返回摘要（媒体数量、原稿页数）。",
    inputSchema: {
      from: dateSchema.optional(), to: dateSchema.optional(), tag: z.string().optional(),
      query: z.string().optional().describe("关键词，空格分隔表示同时包含"),
      has_pages: z.boolean().optional().describe("只看已上传纸质原稿的日记"),
      limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const r = store.listEntries({ from: a.from, to: a.to, tag: a.tag, q: a.query, hasPages: a.has_pages, limit: a.limit, offset: a.offset });
    return json({ ...r, items: r.items.map(entryOut) });
  });

  server.registerTool("search", {
    title: "搜索日记",
    description: "全文搜索编号、标题、备注、标签、文件名与说明、文字文件内容（支持中文）。",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const r = store.listEntries({ q: a.query, limit: a.limit ?? 30 });
    return json({ ...r, items: r.items.map(entryOut) });
  });

  server.registerTool("get_entry", {
    title: "查看日记",
    description: "按编号（如 261013-1）获取一篇日记：纸质原稿 pages 与富媒体 media（含下载链接）。",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async (a) => json(entryOut(store.getEntry(a.id))));

  server.registerTool("create_entry", {
    title: "新建日记（分配编号）",
    description: `新建一篇日记并分配编号，可同时把图库中的文件归入：media_ids 作为富媒体组，page_ids 作为纸质原稿。date 不传则为今天（服务器当前日期 ${todayStr()}）。`,
    inputSchema: {
      date: dateSchema.optional(), title: z.string().optional(),
      note: z.string().optional().describe("文字备注（Markdown），可选"),
      tags: z.array(z.string()).optional(),
      media_ids: z.array(z.string()).optional(), page_ids: z.array(z.string()).optional(),
    },
  }, async (a) => json(entryOut(store.createEntry(a))));

  server.registerTool("update_entry", {
    title: "修改日记",
    description: "修改标题、备注或标签（只更新传入的字段；tags 为整体替换）。编号和日期不可修改。",
    inputSchema: { id: z.string(), title: z.string().optional(), note: z.string().optional(), tags: z.array(z.string()).optional() },
  }, async ({ id, ...patch }) => json(entryOut(store.updateEntry(id, patch))));

  server.registerTool("delete_entry", {
    title: "删除日记（移入回收站）",
    description: "把日记移入回收站，其中的文件随之隐藏。可用 restore_entry 恢复。",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async (a) => json(store.trashEntry(a.id)));

  server.registerTool("restore_entry", {
    title: "恢复日记", description: "从回收站恢复日记。", inputSchema: { id: z.string() },
  }, async (a) => json(entryOut(store.restoreEntry(a.id))));

  // ---------- 图库 ----------

  server.registerTool("list_media", {
    title: "浏览图库",
    description: "按拍摄时间倒序列出图库文件。可按类型、所属日记、是否未归组、拍摄日期范围、关键词过滤。",
    inputSchema: {
      kind: z.enum(["image", "video", "audio", "text", "file"]).optional(),
      role: z.enum(["media", "page", "all"]).optional().describe("默认 media"),
      entry_id: z.string().optional(), ungrouped: z.boolean().optional().describe("只看未归入任何日记的文件"),
      from: dateSchema.optional(), to: dateSchema.optional(), query: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const r = store.listMedia({ kind: a.kind, role: a.role, entry: a.entry_id, ungrouped: a.ungrouped, from: a.from, to: a.to, q: a.query, limit: a.limit, offset: a.offset });
    return json({ ...r, items: r.items.map(withUrls) });
  });

  server.registerTool("add_media", {
    title: "上传文件",
    description: "上传一个文件到图库（图片/音频/视频/文字/其他），可直接归入某篇日记。三选一提供内容：content_base64、text（纯文字，保存为 .txt/.md）、url（服务器去下载）。",
    inputSchema: {
      filename: z.string().describe("文件名，含扩展名，用于判断类型，如 photo.jpg、voice.m4a、memo.md"),
      content_base64: z.string().optional(), text: z.string().optional(), url: z.string().url().optional(),
      entry_id: z.string().optional().describe("不传则放入图库「未归组」"),
      role: roleSchema.optional(), mime: z.string().optional(), caption: z.string().optional(),
      taken_at: z.string().optional().describe("拍摄时间 ISO 格式；不传则读取 EXIF / 元数据"),
    },
  }, async (a) => {
    if (a.entry_id) store.getEntry(a.entry_id);
    const sources = [a.content_base64, a.text, a.url].filter((v) => v !== undefined);
    if (sources.length !== 1) throw new Error("content_base64、text、url 必须且只能提供一个");
    let file: string, mime = a.mime;
    if (a.url) {
      const r = await fetchToTmp(a.url, maxBytes);
      file = r.file; mime ??= r.mime;
    } else {
      const buf = a.text !== undefined ? Buffer.from(a.text, "utf8") : Buffer.from(a.content_base64!, "base64");
      if (buf.length > maxBytes) throw new Error(`文件过大（上限 ${config.mcpMaxUploadMb} MB）`);
      file = tmpPath();
      fs.writeFileSync(file, buf);
      if (a.text !== undefined && !path.extname(a.filename)) a.filename += ".txt";
    }
    const stored = await storeFile(file, a.filename, mime, a.taken_at ? new Date(a.taken_at) : undefined);
    return json(withUrls(store.addAttachment(stored, a.filename, { entryId: a.entry_id, role: a.role, caption: a.caption })));
  });

  server.registerTool("get_media", {
    title: "读取文件",
    description: "读取文件：图片直接返回图像（长边缩至 1568px），文字返回内容，音视频等返回元数据和下载链接。",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const att = store.getAttachment(a.id);
    const file = path.join(paths.media, att.path);
    const meta = { type: "text" as const, text: JSON.stringify(withUrls(att), null, 2) };
    if (att.kind === "image") {
      try {
        const buf = await sharp(file, { failOn: "none" }).rotate().resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        return { content: [meta, { type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" }] };
      } catch { /* 无法解码的格式，退回元数据 */ }
    }
    if (att.kind === "text" && att.size <= 512 * 1024) {
      return { content: [meta, { type: "text" as const, text: fs.readFileSync(file, "utf8") }] };
    }
    return { content: [meta] };
  });

  server.registerTool("assign_media", {
    title: "归入日记",
    description: "把一批文件归入某篇日记，作为富媒体（role=media）或纸质原稿（role=page），追加在末尾。也可用于在日记之间移动文件。",
    inputSchema: { ids: z.array(z.string()).min(1), entry_id: z.string(), role: roleSchema.optional() },
  }, async (a) => json(entryOut(store.assign(a.ids, a.entry_id, a.role ?? "media"))));

  server.registerTool("unassign_media", {
    title: "移出日记",
    description: "把文件移出所属日记，回到图库「未归组」。文件本身不受影响。",
    inputSchema: { ids: z.array(z.string()).min(1) },
  }, async (a) => json(store.unassign(a.ids)));

  server.registerTool("update_media", {
    title: "修改文件信息",
    description: "修改文件说明或在日记内的排序位置。文件内容本身不可修改。",
    inputSchema: { id: z.string(), caption: z.string().optional(), position: z.number().int().optional() },
  }, async ({ id, ...patch }) => json(withUrls(store.updateAttachment(id, patch))));

  server.registerTool("delete_media", {
    title: "删除文件（移入回收站）",
    description: "把文件移入回收站，可用 restore_media 恢复。",
    inputSchema: { ids: z.array(z.string()).min(1) },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async (a) => json(store.trashAttachments(a.ids)));

  server.registerTool("restore_media", {
    title: "恢复文件", description: "从回收站恢复文件。", inputSchema: { id: z.string() },
  }, async (a) => json(withUrls(store.restoreAttachment(a.id))));

  // ---------- 其他 ----------

  server.registerTool("list_trash", {
    title: "查看回收站", description: "列出回收站中的日记和文件。", inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(store.listTrash()));

  server.registerTool("list_tags", {
    title: "标签列表", description: "列出所有标签及使用次数。", inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(store.listTags()));

  server.registerTool("stats", {
    title: "统计",
    description: "今天的日期、日记/图库/原稿数量、各类媒体数量与时长、连续记录天数。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const s = store.stats(30);
    return json({ today: s.today, streak: s.streak, counts: s.counts, kinds: s.kinds, pages: s.pages, first_entry: s.first_entry });
  });

  return server;
}
