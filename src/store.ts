import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { paths } from "./config.js";
import { removeStored, type StoredFile, type Kind } from "./media.js";

export interface Attachment {
  id: string; entry_id: string; kind: Kind; original_name: string; mime: string; size: number;
  sha256: string; path: string; thumb: string | null; width: number | null; height: number | null;
  caption: string; position: number; created_at: string; deleted_at: string | null;
}

export interface Entry {
  id: string; date: string; seq: number; title: string; note: string; tags: string[];
  created_at: string; updated_at: string; deleted_at: string | null;
}

export interface EntryWithAttachments extends Entry { attachments: Attachment[] }
export interface EntrySummary extends Entry { attachment_count: number; counts: Record<Kind, number>; preview: Attachment[] }

export class NotFound extends Error {}
export class BadInput extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{6}-\d+$/;

export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

type Row = Omit<Entry, "tags"> & { tags: string };
const rowToEntry = (r: Row): Entry => ({ ...r, tags: JSON.parse(r.tags) });

export class Store {
  constructor(private db: DB) {}

  // ---------- 日记 ----------

  createEntry(input: { date?: string; title?: string; note?: string; tags?: string[] } = {}): EntryWithAttachments {
    const date = input.date ?? todayStr();
    if (!validDate(date)) throw new BadInput(`日期格式应为 YYYY-MM-DD：${date}`);
    const id = this.db.transaction(() => {
      const row = this.db.prepare("SELECT last_seq FROM day_counters WHERE date = ?").get(date) as { last_seq: number } | undefined;
      const seq = (row?.last_seq ?? 0) + 1;
      this.db.prepare("INSERT INTO day_counters(date, last_seq) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET last_seq = excluded.last_seq").run(date, seq);
      const id = makeId(date, seq);
      const now = nowIso();
      this.db.prepare(`INSERT INTO entries(id, date, seq, title, note, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, date, seq, (input.title ?? "").trim(), input.note ?? "", JSON.stringify(cleanTags(input.tags)), now, now);
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
      `SELECT * FROM attachments WHERE entry_id = ? ${opts.includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY position, created_at`,
    ).all(e.id) as Attachment[];
    return { ...e, attachments: atts };
  }

  listEntries(opts: { from?: string; to?: string; tag?: string; q?: string; limit?: number; offset?: number } = {}) {
    const where = ["e.deleted_at IS NULL"];
    const args: unknown[] = [];
    if (opts.from) { where.push("e.date >= ?"); args.push(opts.from); }
    if (opts.to) { where.push("e.date <= ?"); args.push(opts.to); }
    if (opts.tag) { where.push("EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)"); args.push(opts.tag); }
    const terms = (opts.q ?? "").split(/\s+/).filter(Boolean);
    for (const t of terms) {
      where.push("e.id IN (SELECT id FROM entries_fts WHERE body LIKE ? ESCAPE '\\')");
      args.push(`%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    }
    const sqlWhere = where.join(" AND ");
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM entries e WHERE ${sqlWhere}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT e.* FROM entries e WHERE ${sqlWhere} ORDER BY e.date DESC, e.seq DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Row[];
    return { total, limit, offset, items: rows.map((r) => this.summarize(rowToEntry(r))) };
  }

  private summarize(e: Entry): EntrySummary {
    const atts = this.db.prepare("SELECT * FROM attachments WHERE entry_id = ? AND deleted_at IS NULL ORDER BY position, created_at")
      .all(e.id) as Attachment[];
    const counts = { image: 0, audio: 0, video: 0, text: 0, file: 0 } as Record<Kind, number>;
    for (const a of atts) counts[a.kind]++;
    return { ...e, attachment_count: atts.length, counts, preview: atts.filter((a) => a.thumb).slice(0, 6) };
  }

  updateEntry(id: string, patch: { title?: string; note?: string; tags?: string[] }): EntryWithAttachments {
    const e = this.entryRow(id);
    const next = {
      title: patch.title !== undefined ? patch.title.trim() : e.title,
      note: patch.note !== undefined ? patch.note : e.note,
      tags: patch.tags !== undefined ? cleanTags(patch.tags) : e.tags,
    };
    this.db.prepare("UPDATE entries SET title = ?, note = ?, tags = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.note, JSON.stringify(next.tags), nowIso(), e.id);
    this.refreshFts(e.id);
    return this.getEntry(e.id);
  }

  /** 移入回收站（附件随日记一起隐藏，恢复时一并恢复） */
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

  // ---------- 附件 ----------

  addAttachment(entryId: string, f: StoredFile, originalName: string, caption = ""): Attachment {
    const e = this.entryRow(entryId);
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 p FROM attachments WHERE entry_id = ?").get(e.id) as { p: number }).p;
    this.db.prepare(`INSERT INTO attachments(id, entry_id, kind, original_name, mime, size, sha256, path, thumb, width, height, caption, position, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.id, e.id, f.kind, originalName, f.mime, f.size, f.sha256, f.path, f.thumb, f.width, f.height, caption.trim(), pos, nowIso());
    this.touch(e.id);
    return this.getAttachment(f.id);
  }

  getAttachment(id: string, includeDeleted = false): Attachment {
    const a = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment | undefined;
    if (!a || (!includeDeleted && a.deleted_at)) throw new NotFound(`找不到附件 ${id}`);
    return a;
  }

  updateAttachment(id: string, patch: { caption?: string; entry_id?: string; position?: number }): Attachment {
    const a = this.getAttachment(id);
    const entryId = patch.entry_id !== undefined ? this.entryRow(patch.entry_id).id : a.entry_id;
    this.db.prepare("UPDATE attachments SET caption = ?, entry_id = ?, position = ? WHERE id = ?")
      .run(patch.caption !== undefined ? patch.caption.trim() : a.caption, entryId, patch.position ?? a.position, a.id);
    this.touch(entryId);
    if (entryId !== a.entry_id) this.touch(a.entry_id);
    return this.getAttachment(a.id);
  }

  reorderAttachments(entryId: string, ids: string[]) {
    const e = this.entryRow(entryId);
    const stmt = this.db.prepare("UPDATE attachments SET position = ? WHERE id = ? AND entry_id = ?");
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id, e.id)))();
    return this.getEntry(e.id);
  }

  trashAttachment(id: string) {
    const a = this.getAttachment(id);
    this.db.prepare("UPDATE attachments SET deleted_at = ? WHERE id = ?").run(nowIso(), a.id);
    this.touch(a.entry_id);
    return { id: a.id, trashed: true };
  }

  restoreAttachment(id: string) {
    const a = this.getAttachment(id, true);
    this.db.prepare("UPDATE attachments SET deleted_at = NULL WHERE id = ?").run(a.id);
    this.touch(a.entry_id);
    return this.getAttachment(a.id);
  }

  purgeAttachment(id: string) {
    const a = this.getAttachment(id, true);
    if (!a.deleted_at) throw new BadInput("只能永久删除回收站中的附件");
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(a.id);
    this.removeFileIfUnused(a);
    this.refreshFts(a.entry_id);
    return { id: a.id, purged: true };
  }

  private removeFileIfUnused(a: Attachment) {
    const used = this.db.prepare("SELECT 1 FROM attachments WHERE path = ?").get(a.path);
    if (!used) removeStored(a.path, a.thumb);
  }

  // ---------- 回收站 / 标签 / 统计 ----------

  listTrash() {
    const entries = (this.db.prepare("SELECT * FROM entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as Row[]).map(rowToEntry);
    const attachments = this.db.prepare(
      `SELECT a.* FROM attachments a JOIN entries e ON e.id = a.entry_id
       WHERE a.deleted_at IS NOT NULL AND e.deleted_at IS NULL ORDER BY a.deleted_at DESC`,
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

  stats() {
    const q = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      entries: q("SELECT COUNT(*) n FROM entries WHERE deleted_at IS NULL"),
      attachments: q("SELECT COUNT(*) n FROM attachments a JOIN entries e ON e.id = a.entry_id WHERE a.deleted_at IS NULL AND e.deleted_at IS NULL"),
      bytes: q("SELECT COALESCE(SUM(a.size),0) n FROM attachments a JOIN entries e ON e.id = a.entry_id WHERE a.deleted_at IS NULL AND e.deleted_at IS NULL"),
      trash: q("SELECT COUNT(*) n FROM entries WHERE deleted_at IS NOT NULL") + q("SELECT COUNT(*) n FROM attachments WHERE deleted_at IS NOT NULL"),
    };
  }

  /** 导出用：全部未删除日记及其附件 */
  allEntries(): EntryWithAttachments[] {
    const rows = this.db.prepare("SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY date, seq").all() as Row[];
    return rows.map((r) => this.getEntry(r.id));
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
    const body = [e.id, e.date, e.title, e.note, ...JSON.parse(e.tags), ...atts.flatMap((a) => [a.original_name, a.caption, textContent(a)])].join("\n");
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

export function isValidId(id: string): boolean {
  return ID_RE.test(normalizeId(id));
}
