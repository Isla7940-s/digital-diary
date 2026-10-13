import fs from "node:fs";
import Database from "better-sqlite3";
import { paths } from "./config.js";

export type DB = Database.Database;

const SCHEMA = `
-- 一篇真实的纸质日记。编号写回本子上，用来关联「一组富媒体」和「纸质原稿」
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,          -- 形如 261013-1
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',  -- 纸质日记的转写正文（Markdown），![说明](media:附件ID) 引用影像
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON 数组
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date, seq);

-- 每天已发出的最大序号；删除后也不回收，保证纸上写过的编号永不复用
CREATE TABLE IF NOT EXISTS day_counters (
  date     TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

-- 图库中的每一个文件。entry_id 为空表示尚未归入任何日记
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT REFERENCES entries(id),
  role          TEXT NOT NULL DEFAULT 'media', -- media 富媒体 | page 纸质原稿
  kind          TEXT NOT NULL,                 -- image | audio | video | text | file
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  path          TEXT NOT NULL,                 -- 相对 media 目录
  thumb         TEXT,                          -- 相对 thumbs 目录
  width         INTEGER,
  height        INTEGER,
  duration      REAL,                          -- 音视频时长（秒）
  taken_at      TEXT NOT NULL,                 -- 拍摄/录制时间（本地时间），图库按此排序
  caption       TEXT NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id, role, position);
CREATE INDEX IF NOT EXISTS idx_att_taken ON attachments(taken_at);

-- trigram 分词支持中文任意子串检索
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  id UNINDEXED, body, tokenize = 'trigram'
);

-- MCP 调用记录，用于统计页的 AI 调用热力图
CREATE TABLE IF NOT EXISTS mcp_calls (
  id    INTEGER PRIMARY KEY,
  ts    TEXT NOT NULL,                   -- 本地时间 YYYY-MM-DDTHH:mm:ss
  tool  TEXT NOT NULL,
  ok    INTEGER NOT NULL,
  ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_ts ON mcp_calls(ts);
`;

/** v1 的 attachments.entry_id 为 NOT NULL，且缺少 role / taken_at / duration，需要重建表 */
function migrate(db: DB) {
  const cols = db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === "role")) return;
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec("ALTER TABLE attachments RENAME TO attachments_v1");
    db.exec("DROP INDEX IF EXISTS idx_att_entry");
    db.exec(SCHEMA);
    db.exec(`INSERT INTO attachments(id, entry_id, role, kind, original_name, mime, size, sha256, path, thumb, width, height, taken_at, caption, position, created_at, deleted_at)
      SELECT id, entry_id, 'media', kind, original_name, mime, size, sha256, path, thumb, width, height, substr(created_at, 1, 19), caption, position, created_at, deleted_at FROM attachments_v1`);
    db.exec("DROP TABLE attachments_v1");
  })();
  db.pragma("foreign_keys = ON");
}

export function openDb(file = paths.db): DB {
  if (file !== ":memory:") {
    for (const dir of [paths.media, paths.thumbs, paths.tmp]) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.exec(SCHEMA);
  // v2 → v3：日记增加转写正文
  const entryCols = db.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
  if (!entryCols.some((c) => c.name === "body")) db.exec("ALTER TABLE entries ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  return db;
}
