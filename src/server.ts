import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import compression from "compression";
import QRCode from "qrcode";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, paths } from "./config.js";
import { openDb } from "./db.js";
import { Store, NotFound, BadInput, Conflict } from "./store.js";
import { storeFile, viewImage, warmViews, viewsIdle, VIEW_WIDTHS } from "./media.js";
import { exportZip, planVolumes, volumeName, type ExportOptions, type Split } from "./export.js";
import { buildMcpServer } from "./mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export function createApp(store: Store) {
  const app = express();
  app.disable("x-powered-by");
  // 压缩 JS / CSS / JSON（图片视频本身已压缩，中间件会自动跳过）；MCP 可能是流式响应，不压缩
  app.use(compression({ filter: (req, res) => !req.path.startsWith("/mcp") && compression.filter(req, res) }));
  const upload = multer({ dest: paths.tmp, defParamCharset: "utf8" });

  // ---------- MCP（无状态 Streamable HTTP） ----------
  app.post("/mcp", express.json({ limit: `${Math.ceil(config.mcpMaxUploadMb * 1.4)}mb` }), async (req, res) => {
    const server = buildMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP 错误", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "内部错误" }, id: null });
    }
  });
  const methodNotAllowed = (_: Request, res: Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ---------- REST API（网页使用） ----------
  const api = express.Router();
  api.use(express.json({ limit: "2mb" }));
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const num = (v: unknown) => (v !== undefined && v !== "" ? Number(v) : undefined);

  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const bool = (v: unknown) => v === "1" || v === "true";

  // 日记
  api.get("/entries", (req, res) => {
    const q = req.query;
    const kind = q.kind === "article" || q.kind === "all" ? q.kind : undefined;
    res.json(store.listEntries({
      kind, from: str(q.from), to: str(q.to), tag: str(q.tag), q: str(q.q), hasPages: bool(q.pages), readable: bool(q.readable),
      limit: num(q.limit), offset: num(q.offset),
    }));
  });
  api.post("/entries", (req, res) => res.status(201).json(store.createEntry(req.body ?? {})));
  api.get("/entries/:id", (req, res) => res.json(store.getEntry(req.params.id, { includeDeleted: true })));
  api.patch("/entries/:id", (req, res) => res.json(store.updateEntry(req.params.id, req.body ?? {})));
  api.delete("/entries/:id", (req, res) => res.json(store.trashEntry(req.params.id)));
  api.post("/entries/:id/restore", (req, res) => res.json(store.restoreEntry(req.params.id)));
  // 永久删除前等后台图片生成结束，否则原图可能正被读取而删不掉
  api.delete("/entries/:id/purge", async (req, res) => { await viewsIdle(); res.json(store.purgeEntry(req.params.id)); });
  api.put("/entries/:id/order", (req, res) => res.json(store.reorder(req.params.id, ids(req.body?.ids))));

  // 图库
  api.get("/media", (req, res) => {
    const q = req.query;
    res.json(store.listMedia({
      kind: str(q.kind) as never, role: str(q.role) as never, entry: str(q.entry), ungrouped: bool(q.ungrouped),
      q: str(q.q), from: str(q.from), to: str(q.to), limit: num(q.limit), offset: num(q.offset),
    }));
  });
  api.get("/media/:id", (req, res) => res.json(store.getAttachment(req.params.id, true)));
  // 上传：可附带 entry_id / role；lastModified 为客户端文件修改时间（毫秒），无 EXIF 时作为拍摄时间
  api.post("/media", upload.array("files"), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const entryId = str(req.body?.entry_id);
    const role = req.body?.role === "page" ? "page" : "media";
    try {
      if (entryId) store.getEntry(entryId);
    } catch (e) {
      files.forEach((f) => fs.rmSync(f.path, { force: true }));
      throw e;
    }
    const mtimes = ([] as unknown[]).concat(req.body?.lastModified ?? []).map(Number);
    const out = [];
    for (const [i, f] of files.entries()) {
      const stored = await storeFile(f.path, f.originalname, f.mimetype, mtimes[i] ? new Date(mtimes[i]) : undefined);
      const rec = store.addAttachment(stored, f.originalname, { entryId, role });
      warmViews(rec);
      out.push(rec);
    }
    res.status(201).json(out);
  });
  api.post("/media/assign", (req, res) => res.json(store.assign(ids(req.body?.ids), String(req.body?.entry_id ?? ""), req.body?.role === "page" ? "page" : "media")));
  api.post("/media/unassign", (req, res) => res.json(store.unassign(ids(req.body?.ids))));
  api.post("/media/trash", (req, res) => res.json(store.trashAttachments(ids(req.body?.ids))));
  api.patch("/media/:id", (req, res) => res.json(store.updateAttachment(req.params.id, req.body ?? {})));
  api.post("/media/:id/restore", (req, res) => res.json(store.restoreAttachment(req.params.id)));
  api.delete("/media/:id/purge", async (req, res) => { await viewsIdle(); res.json(store.purgeAttachment(req.params.id)); });

  api.get("/trash", (_req, res) => res.json(store.listTrash()));
  api.delete("/trash", async (_req, res) => { await viewsIdle(); res.json(store.emptyTrash()); });
  api.get("/tags", (_req, res) => res.json(store.listTags()));
  api.get("/counts", (_req, res) => res.json(store.counts()));
  api.get("/stats", (_req, res) => res.json(store.stats()));

  // 二维码只包含编号本身
  api.get("/qr/:id", async (req, res) => {
    const id = String(req.params.id).replace(/\.svg$/, "");
    const svg = await QRCode.toString(id, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=31536000, immutable").send(svg);
  });

  // 导出：?split=none|year|month|size&size=MB&vol=N；先用 /export/plan 拿到分卷列表，再逐卷下载
  const exportOpts = (q: Record<string, unknown>): ExportOptions => ({
    split: (["year", "month", "size"].includes(String(q.split)) ? q.split : "none") as Split,
    sizeMB: Number(q.size) || undefined,
  });
  const exportStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  };
  api.get("/export/plan", (req, res) => {
    const opts = exportOpts(req.query), stamp = exportStamp();
    const vols = planVolumes(store, opts);
    res.json({ split: opts.split, volumes: vols.map((v) => ({ n: v.n, label: v.label, entries: v.entries.length, loose: v.loose.length, files: v.files, bytes: v.bytes, name: volumeName(stamp, opts, v, vols.length) })) });
  });
  api.get("/export.zip", async (req, res) => {
    const opts = exportOpts(req.query), vol = Math.max(1, Number(req.query.vol) || 1);
    const vols = planVolumes(store, opts);
    if (!vols[vol - 1]) return res.status(404).json({ error: `没有第 ${vol} 卷（共 ${vols.length} 卷）` });
    res.attachment(volumeName(exportStamp(), opts, vols[vol - 1], vols.length));
    await exportZip(store, res, opts, vol);
  });

  app.use("/api", api);

  // ---------- 文件 ----------
  app.get("/files/:id", async (req, res) => {
    const a = store.getAttachment(req.params.id, true);
    // ?w=800|1600|2560：图片的浏览版（WebP），页面展示用；下载与放大到细节时才用原图
    const want = Number(req.query.w);
    if (want && a.kind === "image" && !req.query.download) {
      const w = VIEW_WIDTHS.find((x) => x >= want) ?? VIEW_WIDTHS[VIEW_WIDTHS.length - 1];
      const file = await viewImage(a.id, a.path, a.mime, w);
      if (file) return res.type("image/webp").sendFile(file, { maxAge: "1y", immutable: true });
    }
    const disp = req.query.download ? "attachment" : "inline";
    res.set("Content-Disposition", `${disp}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
    res.set("X-Content-Type-Options", "nosniff");
    // SVG/HTML 等可执行内容一律按下载处理，避免在本站域名下执行脚本
    const safeInline = /^(image\/(?!svg)|audio\/|video\/|text\/plain|text\/markdown|application\/pdf)/.test(a.mime);
    res.type(safeInline ? a.mime : "application/octet-stream");
    res.sendFile(path.join(paths.media, a.path), { maxAge: "1y", immutable: true });
  });
  app.get("/thumbs/:id", (req, res) => {
    const a = store.getAttachment(req.params.id, true);
    if (!a.thumb) throw new NotFound("无缩略图");
    res.sendFile(path.join(paths.thumbs, a.thumb), { maxAge: "1y", immutable: true });
  });

  app.get("/vendor/jsQR.js", (_req, res) => res.sendFile(require.resolve("jsqr/dist/jsQR.js")));
  app.use(express.static(path.join(root, "public"), { index: "index.html" }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFound) return res.status(404).json({ error: err.message });
    if (err instanceof BadInput) return res.status(400).json({ error: err.message });
    if (err instanceof Conflict) return res.status(409).json({ error: err.message, body: err.body });
    console.error(err);
    res.status(500).json({ error: err.message || "服务器错误" });
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const store = new Store(openDb());
  // 清理上次中断的上传留下的临时文件
  for (const f of fs.readdirSync(paths.tmp)) fs.rmSync(path.join(paths.tmp, f), { force: true, recursive: true });
  createApp(store).listen(config.port, () => {
    console.log(`数字日记已启动：http://localhost:${config.port}`);
    console.log(`MCP 端点：${config.publicUrl}/mcp`);
    console.log(`数据目录：${config.dataDir}`);
  });
}
