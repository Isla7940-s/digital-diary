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

test("中文搜索（长短关键词）与标签", () => {
  const e = store.createEntry({ date: "2026-03-01", title: "西湖边的下午", tags: ["旅行", "#杭州"] });
  assert.deepEqual(e.tags, ["旅行", "杭州"]);
  assert.ok(store.listEntries({ q: "西湖边" }).items.some((x) => x.id === e.id));
  assert.ok(store.listEntries({ q: "湖" }).items.some((x) => x.id === e.id));
  assert.ok(store.listEntries({ q: "杭州 下午" }).items.some((x) => x.id === e.id));
  assert.equal(store.listEntries({ q: "不存在的词" }).total, 0);
  assert.ok(store.listEntries({ tag: "旅行" }).items.some((x) => x.id === e.id));
});

test("网页上传图片生成缩略图，删除进回收站，永久删除才删文件", async () => {
  const e = store.createEntry({ date: "2026-04-01" });
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f0c040" } }).png().toBuffer();
  const fd = new FormData();
  fd.append("files", new Blob([png], { type: "image/png" }), "照片.png");
  const res = await fetch(`${base}/api/entries/${e.id}/attachments`, { method: "POST", body: fd });
  assert.equal(res.status, 201);
  const [att] = await res.json();
  assert.equal(att.kind, "image");
  assert.equal(att.original_name, "照片.png");
  assert.equal(att.width, 800);
  assert.ok(att.thumb);
  assert.equal((await fetch(`${base}/thumbs/${att.id}`)).status, 200);
  const file = path.join(dataDir, "media", att.path);
  assert.ok(fs.existsSync(file));

  await fetch(`${base}/api/attachments/${att.id}`, { method: "DELETE" });
  assert.equal(store.getEntry(e.id).attachments.length, 0);
  assert.ok(fs.existsSync(file), "移入回收站不删除文件");
  await fetch(`${base}/api/attachments/${att.id}/restore`, { method: "POST" });
  assert.equal(store.getEntry(e.id).attachments.length, 1);

  // 不在回收站中的附件不能直接永久删除
  assert.equal((await fetch(`${base}/api/attachments/${att.id}/purge`, { method: "DELETE" })).status, 400);
  store.trashAttachment(att.id);
  assert.equal((await fetch(`${base}/api/attachments/${att.id}/purge`, { method: "DELETE" })).status, 200);
  assert.ok(!fs.existsSync(file));
});

test("二维码只包含编号", async () => {
  const res = await fetch(`${base}/api/qr/261013-1.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /svg/);
});

test("MCP：增删改查与附件，删除只进回收站", async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["create_entry", "get_entry", "update_entry", "delete_entry", "add_attachment", "search"]) assert.ok(tools.includes(t), t);
  assert.ok(!tools.some((t) => t.includes("purge")), "MCP 不暴露永久删除");

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    assert.ok(!r.isError, JSON.stringify(r.content));
    return r;
  };
  const parse = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0].text!);

  const e = parse(await call("create_entry", { date: "2026-05-05", title: "MCP 测试", tags: ["测试"] }));
  assert.equal(e.id, "260505-1");
  parse(await call("update_entry", { id: e.id, note: "一段备注" }));
  const att = parse(await call("add_attachment", { entry_id: e.id, filename: "memo.md", text: "# 你好\n纸质日记第三页" }));
  assert.equal(att.kind, "text");
  const got = await call("get_attachment", { id: att.id });
  assert.equal(got.content[1].text, "# 你好\n纸质日记第三页");

  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
  const img = parse(await call("add_attachment", { entry_id: e.id, filename: "a.png", content_base64: png.toString("base64") }));
  const imgRes = await call("get_attachment", { id: img.id });
  assert.equal(imgRes.content[1].type, "image");

  const found = parse(await call("search", { query: "纸质日记" }));
  assert.ok(found.items.some((x: { id: string }) => x.id === e.id), "附件文件名/说明可被搜索到");

  await call("delete_entry", { id: e.id });
  const trash = parse(await call("list_trash", {}));
  assert.ok(trash.entries.some((x: { id: string }) => x.id === e.id));
  assert.ok(fs.existsSync(path.join(dataDir, "media", att.path)));
  await call("restore_entry", { id: e.id });
  assert.equal(parse(await call("get_entry", { id: e.id })).attachments.length, 2);
  await client.close();
});

test("导出 zip", async () => {
  const res = await fetch(`${base}/api/export.zip`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), "PK");
});
