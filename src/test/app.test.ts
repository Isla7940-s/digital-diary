import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

// 必须在加载 config 之前设置数据目录
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-test-"));
process.env.DATA_DIR = dataDir;

const { openDb } = await import("../db.js");
const { Store, makeId, normalizeId, plainText, bodyRefs, bodyHash } = await import("../store.js");
const { createApp } = await import("../server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const sharp = (await import("sharp")).default;

const db = openDb();
const store = new Store(db);
let server: Server;
let base: string;

before(async () => {
  server = createApp(store).listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const png = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: "#f0c040" } }).png().toBuffer();

async function upload(name: string, buf: Buffer, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("files", new Blob([new Uint8Array(buf)]), name);
  const res = await fetch(`${base}/api/media`, { method: "POST", body: fd });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json())[0];
}

test("编号格式与容错", () => {
  assert.equal(makeId("2026-10-13", 1), "261013-1");
  assert.equal(normalizeId(" 261013－2 "), "261013-2");
  assert.equal(normalizeId("261013 3"), "261013-3");
});

test("同一天多篇递增，删除后编号不复用", () => {
  const a = store.createEntry({ date: "2026-01-02" });
  const b = store.createEntry({ date: "2026-01-02" });
  assert.equal(a.id, "260102-1");
  assert.equal(b.id, "260102-2");
  store.trashEntry(b.id);
  store.purgeEntry(b.id);
  assert.equal(store.createEntry({ date: "2026-01-02" }).id, "260102-3");
  assert.throws(() => store.createEntry({ date: "2026-02-30" }));
});

test("中文搜索与标签", () => {
  const e = store.createEntry({ date: "2026-03-01", title: "西湖边的下午", tags: ["旅行", "#杭州"] });
  assert.deepEqual(e.tags, ["旅行", "杭州"]);
  assert.ok(store.listEntries({ q: "西湖边" }).items.some((x) => x.id === e.id));
  assert.ok(store.listEntries({ q: "湖" }).items.some((x) => x.id === e.id));
  assert.ok(store.listEntries({ q: "杭州 下午" }).items.some((x) => x.id === e.id));
  assert.equal(store.listEntries({ q: "不存在的词" }).total, 0);
});

test("图库：上传未归组 → 选中分配编号 → 移出", async () => {
  const mtime = new Date("2025-07-08T09:10:11").getTime();
  const a = await upload("海边.png", await png(800, 600), { lastModified: String(mtime) });
  const b = await upload("b.png", await png());
  assert.equal(a.entry_id, null);
  assert.equal(a.kind, "image");
  assert.equal(a.width, 800);
  assert.equal(a.taken_at, "2025-07-08T09:10:11", "无 EXIF 时用文件修改时间");
  assert.ok(a.thumb);
  assert.equal((await fetch(`${base}/thumbs/${a.id}`)).status, 200);

  const ung = await (await fetch(`${base}/api/media?ungrouped=1`)).json();
  assert.ok(ung.items.some((x: { id: string }) => x.id === a.id));

  const res = await fetch(`${base}/api/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: "2025-07-08", media_ids: [a.id, b.id] }) });
  const e = await res.json();
  assert.equal(e.id, "250708-1");
  assert.equal(e.media.length, 2);
  assert.equal(store.listEntries({ q: "海边" }).items[0]?.id, e.id, "文件名可搜索");

  await fetch(`${base}/api/media/unassign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [b.id] }) });
  assert.equal(store.getEntry(e.id).media.length, 1);
  assert.equal(store.getAttachment(b.id).entry_id, null);
});

test("纸质原稿与排序", async () => {
  const e = store.createEntry({ date: "2026-06-01" });
  const p1 = await upload("p1.png", await png(), { entry_id: e.id, role: "page" });
  const p2 = await upload("p2.png", await png(), { entry_id: e.id, role: "page" });
  const m = await upload("m.png", await png(), { entry_id: e.id });
  let got = store.getEntry(e.id);
  assert.deepEqual(got.pages.map((x) => x.id), [p1.id, p2.id]);
  assert.deepEqual(got.media.map((x) => x.id), [m.id]);
  store.reorder(e.id, [p2.id, p1.id]);
  got = store.getEntry(e.id);
  assert.deepEqual(got.pages.map((x) => x.id), [p2.id, p1.id]);
  assert.ok(store.listEntries({ hasPages: true }).items.some((x) => x.id === e.id));
  // 默认图库不显示原稿
  assert.ok(!store.listMedia({}).items.some((x) => x.id === p1.id));
});

test("删除进回收站，永久删除才删文件；回收站中的日记其文件也隐藏", async () => {
  const e = store.createEntry({ date: "2026-04-01" });
  const att = await upload("x.png", await png(), { entry_id: e.id });
  const file = path.join(dataDir, "media", att.path);
  store.trashEntry(e.id);
  assert.ok(!store.listMedia({}).items.some((x) => x.id === att.id));
  store.restoreEntry(e.id);

  await fetch(`${base}/api/media/trash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [att.id] }) });
  assert.equal(store.getEntry(e.id).media.length, 0);
  assert.ok(fs.existsSync(file));
  assert.equal((await fetch(`${base}/api/media/${att.id}/purge`, { method: "DELETE" })).status, 200);
  assert.ok(!fs.existsSync(file));
});

test("二维码只包含编号", async () => {
  const res = await fetch(`${base}/api/qr/261013-1.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /svg/);
});

test("MCP：图库、分配编号、原稿、回收站，且每次调用都被记录", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["create_entry", "list_media", "add_media", "assign_media", "unassign_media", "delete_media", "get_media"]) assert.ok(tools.includes(t), t);
  assert.ok(!tools.some((t) => t.includes("purge")), "MCP 不暴露永久删除");

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    assert.ok(!r.isError, JSON.stringify(r.content));
    return r;
  };
  const parse = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0].text!);

  const img = parse(await call("add_media", { filename: "a.png", content_base64: (await png()).toString("base64") }));
  assert.equal(img.entry_id, null);
  const memo = parse(await call("add_media", { filename: "memo.md", text: "纸质日记第三页的摘录" }));
  const e = parse(await call("create_entry", { date: "2026-05-05", title: "MCP 测试", media_ids: [img.id, memo.id] }));
  assert.equal(e.id, "260505-1");
  assert.equal(e.media.length, 2);
  const page = parse(await call("add_media", { filename: "page.png", content_base64: (await png()).toString("base64"), entry_id: e.id, role: "page" }));
  assert.equal(page.role, "page");

  assert.equal((await call("get_media", { id: img.id })).content[1].type, "image");
  assert.equal((await call("get_media", { id: memo.id })).content[1].text, "纸质日记第三页的摘录");
  const found = parse(await call("search", { query: "第三页" }));
  assert.ok(found.items.some((x: { id: string }) => x.id === e.id), "文字内容可被搜索");

  await call("delete_entry", { id: e.id });
  assert.ok(parse(await call("list_trash", {})).entries.some((x: { id: string }) => x.id === e.id));
  await call("restore_entry", { id: e.id });
  const got = parse(await call("get_entry", { id: e.id }));
  assert.equal(got.pages.length, 1);
  assert.equal(got.media.length, 2);

  const r = await client.callTool({ name: "get_entry", arguments: { id: "999999-9" } }) as { isError?: boolean };
  assert.ok(r.isError);
  await client.close();

  const s = store.stats();
  assert.ok(s.mcpTools.some((t) => t.tool === "add_media" && t.count === 3));
  assert.ok(s.mcpTools.some((t) => t.tool === "get_entry" && t.errors === 1));
  assert.ok(s.mcpDays.length >= 1);
});

test("正文：Markdown 转纯文字与影像引用", () => {
  const md = "# 标题\n\n今天**很好**，见 [链接](https://a.b)。\n\n![断桥](media:abc-1)\n\n- [x] 买菜\n1. 第一\n\n星号 \\* 保留";
  assert.equal(plainText(md), "标题\n\n今天很好，见 链接。\n\n断桥\n\n买菜\n第一\n\n星号 * 保留");
  assert.deepEqual(bodyRefs(md + "\n\n![](media:x2)\n\n![again](media:abc-1)"), ["abc-1", "x2"]);
});

test("正文：保存、摘录、搜索、可阅读筛选、旧库迁移", async () => {
  const img = await upload("柳树.png", await png());
  const e = store.createEntry({ date: "2026-06-01", media_ids: [img.id] });
  assert.equal(e.body, "");
  assert.ok(!store.listEntries({ readable: true }).items.some((x) => x.id === e.id), "没有原稿也没有正文时不可阅读");

  const body = `今天去了**断桥**。\r\n\r\n![湖边的柳树](media:${img.id})\r\n\r\n晚上下起了小雨。\n\n\n`;
  const res = await fetch(`${base}/api/entries/${e.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  const saved = await res.json();
  assert.equal(saved.body, `今天去了**断桥**。\n\n![湖边的柳树](media:${img.id})\n\n晚上下起了小雨。`, "统一换行并去掉结尾空白");

  const sum = store.listEntries({ readable: true }).items.find((x) => x.id === e.id);
  assert.ok(sum, "有正文即可阅读");
  assert.equal((sum as { body?: string }).body, undefined, "列表不返回完整正文");
  assert.equal(sum!.excerpt, "今天去了断桥。 湖边的柳树 晚上下起了小雨。");
  assert.equal(sum!.body_chars, 20);
  assert.ok(store.listEntries({ q: "小雨" }).items.some((x) => x.id === e.id), "正文可被搜索");
  assert.ok(!store.listEntries({ q: "media:" }).items.some((x) => x.id === e.id), "影像引用语法不进搜索");

  // 乐观锁：基于旧版本的保存被拒绝（409）并带回当前正文；基于最新版本的保存成功
  const patch = (b: Record<string, unknown>) => fetch(`${base}/api/entries/${e.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const stale = await patch({ body: "", body_base: bodyHash("") });
  assert.equal(stale.status, 409, "旧页面（以为正文为空）不能清空新内容");
  assert.equal((await stale.json()).body, saved.body);
  assert.equal(store.getEntry(e.id).body, saved.body);
  const fresh = await patch({ body: saved.body + "\n\n补一句。", body_base: bodyHash(saved.body) });
  assert.equal(fresh.status, 200);

  const big = await fetch(`${base}/api/entries/${e.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "字".repeat(500_001) }) });
  assert.equal(big.status, 400);

  // 老数据库（没有 body 列）打开时自动迁移
  const oldFile = path.join(dataDir, "old.db");
  const old = new (await import("better-sqlite3")).default(oldFile);
  old.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, date TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)");
  old.exec("INSERT INTO entries VALUES ('250101-1','2025-01-01',1,'','','[]','x','x',NULL)");
  old.close();
  const migrated = openDb(oldFile);
  assert.equal(new Store(migrated).getEntry("250101-1").body, "");
  migrated.close();
});

test("MCP：写入正文并提示无效的影像引用", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!r.isError, JSON.stringify(r.content));
    return JSON.parse(r.content[0].text);
  };
  const img = await call("add_media", { filename: "b.png", content_base64: (await png()).toString("base64") });
  const e = await call("create_entry", { date: "2026-06-02", media_ids: [img.id], body: `第一段\n\n![照片](media:${img.id})` });
  assert.match(e.body, /media:/);
  assert.equal(e.warning, undefined);
  const u = await call("update_entry", { id: e.id, body: "改写\n\n![别的](media:not-here)" });
  assert.equal(u.body, "改写\n\n![别的](media:not-here)");
  assert.match(u.warning, /not-here/);
  assert.equal((await call("get_entry", { id: e.id })).body, u.body);
  await client.close();
});

test("图片浏览版：按宽度生成 WebP 并缓存，不放大，原图与下载不受影响", async () => {
  const a = await upload("大图.png", await png(2000, 1500));
  const get = async (q: string) => {
    const r = await fetch(`${base}/files/${a.id}${q}`);
    return { type: r.headers.get("content-type") ?? "", buf: Buffer.from(await r.arrayBuffer()) };
  };
  const v800 = await get("?w=800");
  assert.match(v800.type, /webp/);
  assert.equal((await sharp(v800.buf).metadata()).width, 800);
  assert.equal((await sharp((await get("?w=1000")).buf).metadata()).width, 1600, "向上取到最近的档位");
  assert.equal((await sharp((await get("?w=99999")).buf).metadata()).width, 2000, "不超过原图宽度");
  assert.match((await get("")).type, /png/, "不带 w 仍是原图");
  assert.match((await get("?w=800&download=1")).type, /octet-stream|png/, "下载永远是原件");
  const cached = path.join(dataDir, "thumbs", `${a.id}_w800.webp`);
  assert.ok(fs.existsSync(cached));
  store.trashAttachments([a.id]);
  store.purgeAttachment(a.id);
  assert.ok(!fs.existsSync(cached), "永久删除时清掉浏览版缓存");
});

test("静态资源与接口启用 gzip", async () => {
  const r = await fetch(`${base}/js/editor.js`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(r.headers.get("content-encoding"), "gzip");
});

test("统计与导出", async () => {
  const s = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(s.counts.entries > 0);
  assert.ok(Array.isArray(s.entryDays));
  const res = await fetch(`${base}/api/export.zip`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString(), "PK");
});
