import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { paths } from "./config.js";
import { localIso, removeStored, removeViews, type StoredFile, type Kind } from "./media.js";

export type Role = "media" | "page";

export interface Attachment {
  id: string; entry_id: string | null; role: Role; kind: Kind; original_name: string; mime: string; size: number;
  sha256: string; path: string; thumb: string | null; width: number | null; height: number | null;
  duration: number | null; taken_at: string; caption: string; position: number; created_at: string; deleted_at: string | null;
}

export interface Entry {
  id: string; date: string; seq: number; title: string; note: string; body: string; tags: string[];
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface EntryWithAttachments extends Entry { pages: Attachment[]; media: Attachment[] }
export interface EntrySummary extends Omit<Entry, "body"> {
  counts: Record<Kind, number>; media_count: number; page_count: number;
  /** 正文纯文字字数与开头摘录（列表里不返回完整正文） */
  body_chars: number; excerpt: string;
  cover: Attachment | null; preview: Attachment[];
}

export class NotFound extends Error {}
export class BadInput extends Error {}
/** 保存正文时发现服务器上的版本已被别处修改（例如另一个旧页面），附带当前正文 */
export class Conflict extends Error {
  constructor(message: string, readonly body: string) { super(message); }
}

/** 正文指纹（FNV-1a 32 位，与前端 md.js 的 bodyHash 一致），用来判断保存时的基准版本是否还是最新 */
export function bodyHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BODY_MAX = 500_000;
const KINDS: Kind[] = ["image", "video", "audio", "text", "file"];

export function todayStr(d = new Date()): string {
  return localIso(d).slice(0, 10);
}

/** 2026-10-13 + 1 → 261013-1 */
export function makeId(date: string, seq: number): string {
  return `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-${seq}`;
}

/** 容错：全角横线、空格、下划线等都当作分隔符 */
export function normalizeId(raw: string): string {
  return raw.trim().replace(/[\s_－—–]+/g, "-").replace(/-+/g, "-");
}

function validDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().startsWith(date);
}

function cleanBody(body: unknown): string {
  const s = String(body ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (s.length > BODY_MAX) throw new BadInput(`正文过长（${s.length} 字符，上限 ${BODY_MAX}）`);
  return s;
}

/** 正文 Markdown → 纯文字：用于摘录、字数和搜索 */
export function plainText(md: string): string {
  return md
    .replace(/^```.*$/gm, "")
    .replace(/!\[((?:\\.|[^\]\\])*)\]\(media:[^)]*\)/g, "$1")
    .replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,})[ \t]*$/gm, "")
    .replace(/\*\*|~~|`|(?<!\\)\*/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
}

/** 正文中引用的影像 id（按出现顺序去重） */
export function bodyRefs(md: string): string[] {
  return [...new Set([...md.matchAll(/!\[(?:\\.|[^\]\\])*\]\(media:([\w-]+)\)/g)].map((m) => m[1]))];
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const t of tags) {
    const s = String(t).trim().replace(/^#/, "");
    if (s) out.add(s.slice(0, 40));
  }
  return [...out];
}

const nowIso = () => new Date().toISOString();
const likeArg = (t: string) => `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

type Row = Omit<Entry, "tags"> & { tags: string };
const rowToEntry = (r: Row): Entry => ({ ...r, tags: JSON.parse(r.tags) });

/** 「可见」的附件：自身未删除，且不属于回收站中的日记 */
const VISIBLE = "a.deleted_at IS NULL AND (a.entry_id IS NULL OR a.entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL))";

export interface MediaQuery {
  kind?: Kind | "visual"; role?: Role | "all"; entry?: string; ungrouped?: boolean;
  q?: string; from?: string; to?: string; limit?: number; offset?: number;
}

export class Store {
  constructor(private db: DB) {}

  // ---------- 日记 ----------

  /** 新建日记并分配编号；可同时把图库中已选的媒体归入这篇日记 */
  createEntry(input: { date?: string; title?: string; note?: string; body?: string; tags?: string[]; media_ids?: string[]; page_ids?: string[] } = {}): EntryWithAttachments {
    const date = input.date ?? todayStr();
    if (!validDate(date)) throw new BadInput(`日期格式应为 YYYY-MM-DD：${date}`);
    const id = this.db.transaction(() => {
      const row = this.db.prepare("SELECT last_seq FROM day_counters WHERE date = ?").get(date) as { last_seq: number } | undefined;
      const seq = (row?.last_seq ?? 0) + 1;
      this.db.prepare("INSERT INTO day_counters(date, last_seq) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET last_seq = excluded.last_seq").run(date, seq);
      const id = makeId(date, seq);
      const now = nowIso();
      this.db.prepare(`INSERT INTO entries(id, date, seq, title, note, body, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, date, seq, (input.title ?? "").trim(), input.note ?? "", cleanBody(input.body), JSON.stringify(cleanTags(input.tags)), now, now);
      if (input.media_ids?.length) this.assign(input.media_ids, id, "media");
      if (input.page_ids?.length) this.assign(input.page_ids, id, "page");
      this.refreshFts(id);
      return id;
    })();
    return this.getEntry(id);
  }

  private entryRow(id: string, includeDeleted = false): Entry {
    const r = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(normalizeId(id)) as Row | undefined;
    if (!r || (!includeDeleted && r.deleted_at)) throw new NotFound(`找不到日记 ${id}`);
    return rowToEntry(r);
  }

  getEntry(id: string, opts: { includeDeleted?: boolean } = {}): EntryWithAttachments {
    const e = this.entryRow(id, opts.includeDeleted);
    const atts = this.db.prepare(
      "SELECT * FROM attachments WHERE entry_id = ? AND deleted_at IS NULL ORDER BY position, taken_at",
    ).all(e.id) as Attachment[];
    return { ...e, pages: atts.filter((a) => a.role === "page"), media: atts.filter((a) => a.role === "media") };
  }

  listEntries(opts: { from?: string; to?: string; tag?: string; q?: string; hasPages?: boolean; readable?: boolean; limit?: number; offset?: number } = {}) {
    const where = ["e.deleted_at IS NULL"];
    const args: unknown[] = [];
    if (opts.from) { where.push("e.date >= ?"); args.push(opts.from); }
    if (opts.to) { where.push("e.date <= ?"); args.push(opts.to); }
    if (opts.tag) { where.push("EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)"); args.push(opts.tag); }
    const hasPages = "EXISTS (SELECT 1 FROM attachments a WHERE a.entry_id = e.id AND a.role = 'page' AND a.deleted_at IS NULL)";
    if (opts.hasPages) where.push(hasPages);
    // 可阅读：有纸质原稿或已有转写正文
    if (opts.readable) where.push(`(${hasPages} OR e.body <> '')`);
    for (const t of (opts.q ?? "").split(/\s+/).filter(Boolean)) {
      where.push("e.id IN (SELECT id FROM entries_fts WHERE body LIKE ? ESCAPE '\\')");
      args.push(likeArg(t));
    }
    const sqlWhere = where.join(" AND ");
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM entries e WHERE ${sqlWhere}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT e.* FROM entries e WHERE ${sqlWhere} ORDER BY e.date DESC, e.seq DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Row[];
    return { total, limit, offset, items: rows.map((r) => this.summarize(rowToEntry(r))) };
  }

  private summarize({ body, ...e }: Entry): EntrySummary {
    const atts = this.db.prepare("SELECT * FROM attachments WHERE entry_id = ? AND deleted_at IS NULL ORDER BY position, taken_at")
      .all(e.id) as Attachment[];
    const media = atts.filter((a) => a.role === "media");
    const pages = atts.filter((a) => a.role === "page");
    const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    for (const a of media) counts[a.kind]++;
    const visual = media.filter((a) => a.thumb);
    const text = plainText(body).replace(/\s+/g, " ").trim();
    return {
      ...e, counts, media_count: media.length, page_count: pages.length,
      body_chars: text.replace(/\s/g, "").length, excerpt: text.slice(0, 140),
      cover: visual[0] ?? pages.find((a) => a.thumb) ?? null,
      preview: visual.slice(0, 8),
    };
  }

  /**
   * body_base：调用方编辑时所基于的正文指纹。传了就做乐观锁检查，
   * 防止一个打开很久的旧页面把别处的新内容覆盖掉；不传（例如 MCP）则直接覆盖
   */
  updateEntry(id: string, patch: { title?: string; note?: string; body?: string; body_base?: string; tags?: string[] }): EntryWithAttachments {
    const e = this.entryRow(id);
    if (patch.body !== undefined && patch.body_base !== undefined && bodyHash(e.body) !== patch.body_base) {
      throw new Conflict("这篇文章已在别处被修改", e.body);
    }
    const next = {
      title: patch.title !== undefined ? String(patch.title).trim() : e.title,
      note: patch.note !== undefined ? String(patch.note) : e.note,
      body: patch.body !== undefined ? cleanBody(patch.body) : e.body,
      tags: patch.tags !== undefined ? cleanTags(patch.tags) : e.tags,
    };
    this.db.prepare("UPDATE entries SET title = ?, note = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.note, next.body, JSON.stringify(next.tags), nowIso(), e.id);
    this.refreshFts(e.id);
    return this.getEntry(e.id);
  }

  /** 移入回收站（其中的媒体与原稿一并隐藏，恢复时一并恢复） */
  trashEntry(id: string) {
    const e = this.entryRow(id);
    this.db.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").run(nowIso(), e.id);
    return { id: e.id, trashed: true };
  }

  restoreEntry(id: string) {
    const e = this.entryRow(id, true);
    this.db.prepare("UPDATE entries SET deleted_at = NULL WHERE id = ?").run(e.id);
    return this.getEntry(e.id);
  }

  /** 永久删除：仅网页回收站可调用，MCP 不暴露 */
  purgeEntry(id: string) {
    const e = this.entryRow(id, true);
    if (!e.deleted_at) throw new BadInput("只能永久删除回收站中的日记");
    const atts = this.db.prepare("SELECT * FROM attachments WHERE entry_id = ?").all(e.id) as Attachment[];
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM attachments WHERE entry_id = ?").run(e.id);
      this.db.prepare("DELETE FROM entries_fts WHERE id = ?").run(e.id);
      this.db.prepare("DELETE FROM entries WHERE id = ?").run(e.id);
    })();
    for (const a of atts) this.removeFileIfUnused(a);
    return { id: e.id, purged: true };
  }

  // ---------- 图库 / 附件 ----------

  addAttachment(f: StoredFile, originalName: string, opts: { entryId?: string | null; role?: Role; caption?: string } = {}): Attachment {
    const entryId = opts.entryId ? this.entryRow(opts.entryId).id : null;
    const role: Role = entryId && opts.role === "page" ? "page" : "media";
    const pos = entryId ? this.nextPosition(entryId, role) : 0;
    this.db.prepare(`INSERT INTO attachments(id, entry_id, role, kind, original_name, mime, size, sha256, path, thumb, width, height, duration, taken_at, caption, position, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.id, entryId, role, f.kind, originalName, f.mime, f.size, f.sha256, f.path, f.thumb, f.width, f.height, f.duration, f.taken_at, (opts.caption ?? "").trim(), pos, nowIso());
    if (entryId) this.touch(entryId);
    return this.getAttachment(f.id);
  }

  private nextPosition(entryId: string, role: Role): number {
    return (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 p FROM attachments WHERE entry_id = ? AND role = ?").get(entryId, role) as { p: number }).p;
  }

  getAttachment(id: string, includeDeleted = false): Attachment {
    const a = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment | undefined;
    if (!a || (!includeDeleted && a.deleted_at)) throw new NotFound(`找不到文件 ${id}`);
    return a;
  }

  /** 图库查询：按拍摄时间倒序 */
  listMedia(q: MediaQuery = {}) {
    const where = [VISIBLE];
    const args: unknown[] = [];
    if (q.kind === "visual") where.push("a.kind IN ('image','video')");
    else if (q.kind) { where.push("a.kind = ?"); args.push(q.kind); }
    if (q.role !== "all") { where.push("a.role = ?"); args.push(q.role ?? "media"); }
    if (q.entry) { where.push("a.entry_id = ?"); args.push(normalizeId(q.entry)); }
    if (q.ungrouped) where.push("a.entry_id IS NULL");
    if (q.from) { where.push("a.taken_at >= ?"); args.push(q.from); }
    if (q.to) { where.push("a.taken_at < ?"); args.push(`${q.to}T99`); }
    for (const t of (q.q ?? "").split(/\s+/).filter(Boolean)) {
      where.push("(a.original_name LIKE ? ESCAPE '\\' OR a.caption LIKE ? ESCAPE '\\' OR a.entry_id LIKE ? ESCAPE '\\')");
      args.push(likeArg(t), likeArg(t), likeArg(t));
    }
    const w = where.join(" AND ");
    const limit = Math.min(Math.max(q.limit ?? 120, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM attachments a WHERE ${w}`).get(...args) as { n: number }).n;
    const items = this.db.prepare(`SELECT a.* FROM attachments a WHERE ${w} ORDER BY a.taken_at DESC, a.created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Attachment[];
    return { total, limit, offset, items };
  }

  /** 把一批文件归入某篇日记（作为富媒体或纸质原稿），追加到末尾 */
  assign(ids: string[], entryId: string, role: Role = "media") {
    const e = this.entryRow(entryId);
    const stmt = this.db.prepare("UPDATE attachments SET entry_id = ?, role = ?, position = ? WHERE id = ?");
    const touched = new Set<string>([e.id]);
    this.db.transaction(() => {
      let pos = this.nextPosition(e.id, role);
      for (const id of ids) {
        const a = this.getAttachment(id);
        if (a.entry_id === e.id && a.role === role) continue;
        if (a.entry_id) touched.add(a.entry_id);
        stmt.run(e.id, role, pos++, a.id);
      }
    })();
    touched.forEach((t) => this.touch(t));
    return this.getEntry(e.id);
  }

  /** 移出日记，回到图库的「未归组」 */
  unassign(ids: string[]) {
    const touched = new Set<string>();
    const stmt = this.db.prepare("UPDATE attachments SET entry_id = NULL, role = 'media', position = 0 WHERE id = ?");
    this.db.transaction(() => {
      for (const id of ids) {
        const a = this.getAttachment(id);
        if (a.entry_id) touched.add(a.entry_id);
        stmt.run(a.id);
      }
    })();
    touched.forEach((t) => this.touch(t));
    return { ids, unassigned: true };
  }

  updateAttachment(id: string, patch: { caption?: string; position?: number }): Attachment {
    const a = this.getAttachment(id);
    this.db.prepare("UPDATE attachments SET caption = ?, position = ? WHERE id = ?")
      .run(patch.caption !== undefined ? patch.caption.trim() : a.caption, patch.position ?? a.position, a.id);
    if (a.entry_id) this.touch(a.entry_id);
    return this.getAttachment(a.id);
  }

  reorder(entryId: string, ids: string[]) {
    const e = this.entryRow(entryId);
    const stmt = this.db.prepare("UPDATE attachments SET position = ? WHERE id = ? AND entry_id = ?");
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id, e.id)))();
    return this.getEntry(e.id);
  }

  trashAttachments(ids: string[]) {
    const stmt = this.db.prepare("UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const id of ids) {
        const a = this.getAttachment(id);
        stmt.run(nowIso(), a.id);
        if (a.entry_id) touched.add(a.entry_id);
      }
    })();
    touched.forEach((t) => this.touch(t));
    return { ids, trashed: true };
  }

  restoreAttachment(id: string) {
    const a = this.getAttachment(id, true);
    this.db.prepare("UPDATE attachments SET deleted_at = NULL WHERE id = ?").run(a.id);
    if (a.entry_id) this.touch(a.entry_id);
    return this.getAttachment(a.id);
  }

  purgeAttachment(id: string) {
    const a = this.getAttachment(id, true);
    if (!a.deleted_at) throw new BadInput("只能永久删除回收站中的文件");
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(a.id);
    this.removeFileIfUnused(a);
    if (a.entry_id) this.refreshFts(a.entry_id);
    return { id: a.id, purged: true };
  }

  private removeFileIfUnused(a: Attachment) {
    removeViews(a.id);  // 浏览版按附件 id 缓存，附件删了就清掉
    const used = this.db.prepare("SELECT 1 FROM attachments WHERE path = ?").get(a.path);
    if (!used) removeStored(a.path, a.thumb);
  }

  // ---------- 回收站 / 标签 ----------

  listTrash() {
    const entries = (this.db.prepare("SELECT * FROM entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as Row[]).map(rowToEntry);
    const attachments = this.db.prepare(
      `SELECT a.* FROM attachments a WHERE a.deleted_at IS NOT NULL
       AND (a.entry_id IS NULL OR a.entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL)) ORDER BY a.deleted_at DESC`,
    ).all() as Attachment[];
    return { entries, attachments };
  }

  emptyTrash() {
    const t = this.listTrash();
    for (const a of t.attachments) this.purgeAttachment(a.id);
    for (const e of t.entries) this.purgeEntry(e.id);
    return { purged_entries: t.entries.length, purged_attachments: t.attachments.length };
  }

  listTags() {
    return this.db.prepare(
      `SELECT j.value AS tag, COUNT(*) AS count FROM entries e, json_each(e.tags) j
       WHERE e.deleted_at IS NULL GROUP BY j.value ORDER BY count DESC, tag`,
    ).all() as { tag: string; count: number }[];
  }

  allEntries(): EntryWithAttachments[] {
    const rows = this.db.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY date, seq").all() as Row[];
    return rows.map((r) => this.getEntry(r.id));
  }

  // ---------- 统计 ----------

  logMcpCall(tool: string, ok: boolean, ms: number) {
    this.db.prepare("INSERT INTO mcp_calls(ts, tool, ok, ms) VALUES (?,?,?,?)").run(localIso(), tool, ok ? 1 : 0, Math.round(ms));
  }

  /** 侧边栏用的轻量计数 */
  counts() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      media: n(`SELECT COUNT(*) n FROM attachments a WHERE ${VISIBLE} AND a.role = 'media'`),
      ungrouped: n(`SELECT COUNT(*) n FROM attachments a WHERE ${VISIBLE} AND a.entry_id IS NULL`),
      entries: n("SELECT COUNT(*) n FROM entries WHERE deleted_at IS NULL"),
      pages: n(`SELECT COUNT(*) n FROM attachments a WHERE ${VISIBLE} AND a.role = 'page'`),
      trash: n("SELECT COUNT(*) n FROM entries WHERE deleted_at IS NOT NULL")
        + n("SELECT COUNT(*) n FROM attachments a WHERE a.deleted_at IS NOT NULL AND (a.entry_id IS NULL OR a.entry_id IN (SELECT id FROM entries WHERE deleted_at IS NULL))"),
    };
  }

  stats(days = 371) {
    const since = todayStr(new Date(Date.now() - days * 86400000));
    const all = <T>(sql: string, ...a: unknown[]) => this.db.prepare(sql).all(...a) as T[];
    const kinds = all<{ kind: Kind; count: number; bytes: number; seconds: number }>(
      `SELECT a.kind, COUNT(*) count, SUM(a.size) bytes, COALESCE(SUM(a.duration), 0) seconds FROM attachments a
       WHERE ${VISIBLE} AND a.role = 'media' GROUP BY a.kind`);
    const pages = all<{ count: number; bytes: number }>(`SELECT COUNT(*) count, COALESCE(SUM(a.size),0) bytes FROM attachments a WHERE ${VISIBLE} AND a.role = 'page'`)[0];
    const entryDays = all<{ day: string; count: number }>(
      "SELECT date day, COUNT(*) count FROM entries WHERE deleted_at IS NULL AND date >= ? GROUP BY date", since);
    const mediaDays = all<{ day: string; count: number }>(
      `SELECT substr(a.taken_at,1,10) day, COUNT(*) count FROM attachments a WHERE ${VISIBLE} AND a.role = 'media' AND a.taken_at >= ? GROUP BY day`, since);
    const mcpDays = all<{ day: string; count: number; errors: number }>(
      "SELECT substr(ts,1,10) day, COUNT(*) count, SUM(1 - ok) errors FROM mcp_calls WHERE ts >= ? GROUP BY day", since);
    const mcpTools = all<{ tool: string; count: number; errors: number; avg_ms: number }>(
      "SELECT tool, COUNT(*) count, SUM(1 - ok) errors, CAST(AVG(ms) AS INTEGER) avg_ms FROM mcp_calls WHERE ts >= ? GROUP BY tool ORDER BY count DESC", since);
    const mcpHours = all<{ hour: number; count: number }>(
      "SELECT CAST(substr(ts,12,2) AS INTEGER) hour, COUNT(*) count FROM mcp_calls WHERE ts >= ? GROUP BY hour", since);
    const mcpRecent = all<{ ts: string; tool: string; ok: number; ms: number }>("SELECT ts, tool, ok, ms FROM mcp_calls ORDER BY id DESC LIMIT 12");
    const monthStart = todayStr(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1)).slice(0, 7);
    const months = all<{ month: string; kind: Kind; count: number }>(
      `SELECT substr(a.taken_at,1,7) month, a.kind, COUNT(*) count FROM attachments a
       WHERE ${VISIBLE} AND a.role = 'media' AND a.taken_at >= ? GROUP BY month, a.kind`, monthStart);
    const entryMonths = all<{ month: string; count: number }>(
      "SELECT substr(date,1,7) month, COUNT(*) count FROM entries WHERE deleted_at IS NULL AND date >= ? GROUP BY month", monthStart);

    // 连续记日记天数（截至今天或昨天）
    const dates = new Set(all<{ date: string }>("SELECT DISTINCT date FROM entries WHERE deleted_at IS NULL").map((r) => r.date));
    let streak = 0;
    const d = new Date();
    if (!dates.has(todayStr(d))) d.setDate(d.getDate() - 1);
    while (dates.has(todayStr(d))) { streak++; d.setDate(d.getDate() - 1); }

    return {
      today: todayStr(), since, streak, counts: this.counts(),
      kinds, pages, entryDays, mediaDays, mcpDays, mcpTools, mcpHours, mcpRecent, months, entryMonths,
      mcpTotal: (this.db.prepare("SELECT COUNT(*) n FROM mcp_calls").get() as { n: number }).n,
      first_entry: (this.db.prepare("SELECT MIN(date) d FROM entries WHERE deleted_at IS NULL").get() as { d: string | null }).d,
    };
  }

  // ---------- 内部 ----------

  private touch(entryId: string) {
    this.db.prepare("UPDATE entries SET updated_at = ? WHERE id = ?").run(nowIso(), entryId);
    this.refreshFts(entryId);
  }

  private refreshFts(entryId: string) {
    const e = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
    this.db.prepare("DELETE FROM entries_fts WHERE id = ?").run(entryId);
    if (!e) return;
    const atts = this.db.prepare("SELECT * FROM attachments WHERE entry_id = ? AND deleted_at IS NULL").all(entryId) as Attachment[];
    const body = [e.id, e.date, e.title, e.note, plainText(e.body), ...JSON.parse(e.tags), ...atts.flatMap((a) => [a.original_name, a.caption, textContent(a)])].join("\n");
    this.db.prepare("INSERT INTO entries_fts(id, body) VALUES (?, ?)").run(entryId, body);
  }
}

/** 文字附件的内容也纳入全文搜索（只取前 200KB） */
function textContent(a: Attachment): string {
  if (a.kind !== "text") return "";
  try {
    const fd = fs.openSync(path.join(paths.media, a.path), "r");
    const buf = Buffer.alloc(Math.min(a.size, 200 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
