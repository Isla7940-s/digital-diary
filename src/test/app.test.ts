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
const { Store, makeId, normalizeId } = await import("../store.js");
const { createApp } = await import("../server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const sharp = (await import("sharp")).default;

const store = new Store(openDb());
let server: Server;
let base: string;

before(async () => {
  server = createApp(store).listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

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

test("统计与导出", async () => {
  const s = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(s.counts.entries > 0);
  assert.ok(Array.isArray(s.entryDays));
  const res = await fetch(`${base}/api/export.zip`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString(), "PK");
});
