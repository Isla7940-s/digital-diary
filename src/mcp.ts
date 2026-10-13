import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, paths } from "./config.js";
import { storeFile, tmpPath } from "./media.js";
import { todayStr, type Store, type Attachment } from "./store.js";

const INSTRUCTIONS = `这是一本「数字日记」的连接器。主人在纸质笔记本上手写日记，这里只负责把多媒体（图片、音频、视频、文字片段）与纸质日记关联起来。
- 每篇日记有唯一编号，格式 YYMMDD-序号（如 261013-1，即 2026-10-13 的第 1 篇），编号写在纸上或做成二维码，永不复用。
- 一天可以有多篇。创建时不传日期即为今天（服务器时区）。
- 删除操作只会移入回收站，可用 restore_* 恢复；永久删除只能由主人在网页回收站完成。
- 附件原文件只写不改；如需更正，请删除后重新上传。`;

export function withUrls(a: Attachment) {
  return {
    ...a,
    url: `${config.publicUrl}/files/${a.id}`,
    thumb_url: a.thumb ? `${config.publicUrl}/thumbs/${a.id}` : null,
  };
}

function entryOut<T extends { id: string; attachments?: Attachment[]; preview?: Attachment[] }>(e: T) {
  const { preview: _p, ...rest } = e as T & { preview?: unknown };
  return {
    ...rest,
    page_url: `${config.publicUrl}/#/e/${e.id}`,
    ...(e.attachments ? { attachments: e.attachments.map(withUrls) } : {}),
  };
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

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
  const server = new McpServer({ name: "digital-diary", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const maxBytes = config.mcpMaxUploadMb * 1024 * 1024;

  server.registerTool("list_entries", {
    title: "列出日记",
    description: "按日期倒序列出日记，可按日期范围、标签、关键词过滤。返回摘要和附件数量。",
    inputSchema: {
      from: dateSchema.optional().describe("起始日期（含）YYYY-MM-DD"),
      to: dateSchema.optional().describe("结束日期（含）YYYY-MM-DD"),
      tag: z.string().optional(),
      query: z.string().optional().describe("关键词，空格分隔表示同时包含"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const r = store.listEntries({ from: a.from, to: a.to, tag: a.tag, q: a.query, limit: a.limit, offset: a.offset });
    return json({ ...r, items: r.items.map(entryOut) });
  });

  server.registerTool("search", {
    title: "搜索日记",
    description: "全文搜索编号、标题、备注、标签、附件文件名与说明（支持中文）。",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const r = store.listEntries({ q: a.query, limit: a.limit ?? 30 });
    return json({ ...r, items: r.items.map(entryOut) });
  });

  server.registerTool("get_entry", {
    title: "查看日记",
    description: "按编号（如 261013-1）获取一篇日记及其全部附件（含文件下载链接）。",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async (a) => json(entryOut(store.getEntry(a.id))));

  server.registerTool("create_entry", {
    title: "新建日记",
    description: `新建一篇日记并分配编号。date 不传则为今天（当前服务器日期 ${todayStr()} 仅供参考，以调用时为准）。`,
    inputSchema: {
      date: dateSchema.optional(),
      title: z.string().optional(),
      note: z.string().optional().describe("文字备注（Markdown），可选"),
      tags: z.array(z.string()).optional(),
    },
  }, async (a) => json(entryOut(store.createEntry(a))));

  server.registerTool("update_entry", {
    title: "修改日记",
    description: "修改标题、备注或标签（只更新传入的字段；tags 为整体替换）。编号和日期不可修改。",
    inputSchema: { id: z.string(), title: z.string().optional(), note: z.string().optional(), tags: z.array(z.string()).optional() },
  }, async ({ id, ...patch }) => json(entryOut(store.updateEntry(id, patch))));

  server.registerTool("delete_entry", {
    title: "删除日记（移入回收站）",
    description: "把日记移入回收站，附件随之隐藏。可用 restore_entry 恢复。",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async (a) => json(store.trashEntry(a.id)));

  server.registerTool("restore_entry", {
    title: "恢复日记",
    description: "从回收站恢复日记。",
    inputSchema: { id: z.string() },
  }, async (a) => json(entryOut(store.restoreEntry(a.id))));

  server.registerTool("add_attachment", {
    title: "上传附件",
    description: "给日记添加一个附件（图片/音频/视频/文字/其他）。三选一提供内容：content_base64（文件的 base64）、text（纯文字片段，保存为 .txt/.md）、url（服务器去下载）。",
    inputSchema: {
      entry_id: z.string(),
      filename: z.string().describe("文件名，含扩展名，用于判断类型，如 photo.jpg、voice.m4a、memo.md"),
      content_base64: z.string().optional(),
      text: z.string().optional(),
      url: z.string().url().optional(),
      mime: z.string().optional(),
      caption: z.string().optional().describe("附件说明"),
    },
  }, async (a) => {
    store.getEntry(a.entry_id); // 先确认日记存在
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
    const stored = await storeFile(file, a.filename, mime);
    return json(withUrls(store.addAttachment(a.entry_id, stored, a.filename, a.caption)));
  });

  server.registerTool("get_attachment", {
    title: "读取附件",
    description: "读取附件：图片直接返回图像（长边缩至 1568px），文字返回内容，音视频等返回元数据和下载链接。",
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

  server.registerTool("update_attachment", {
    title: "修改附件",
    description: "修改附件说明、排序位置，或把附件移动到另一篇日记（entry_id）。文件内容本身不可修改。",
    inputSchema: { id: z.string(), caption: z.string().optional(), entry_id: z.string().optional(), position: z.number().int().optional() },
  }, async ({ id, ...patch }) => json(withUrls(store.updateAttachment(id, patch))));

  server.registerTool("delete_attachment", {
    title: "删除附件（移入回收站）",
    description: "把附件移入回收站，可用 restore_attachment 恢复。",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async (a) => json(store.trashAttachment(a.id)));

  server.registerTool("restore_attachment", {
    title: "恢复附件",
    description: "从回收站恢复附件。",
    inputSchema: { id: z.string() },
  }, async (a) => json(withUrls(store.restoreAttachment(a.id))));

  server.registerTool("list_trash", {
    title: "查看回收站",
    description: "列出回收站中的日记和附件。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(store.listTrash()));

  server.registerTool("list_tags", {
    title: "标签列表",
    description: "列出所有标签及使用次数。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(store.listTags()));

  server.registerTool("stats", {
    title: "统计",
    description: "日记总数、附件数、占用空间、回收站数量，以及今天的日期。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json({ today: todayStr(), ...store.stats() }));

  return server;
}
