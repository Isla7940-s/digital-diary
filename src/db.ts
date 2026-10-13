import fs from "node:fs";
import Database from "better-sqlite3";
import { paths } from "./config.js";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,          -- 形如 261013-1，写在纸质本上的编号
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES entries(id),
  kind          TEXT NOT NULL,           -- image | audio | video | text | file
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  path          TEXT NOT NULL,           -- 相对 media 目录
  thumb         TEXT,                    -- 相对 thumbs 目录
  width         INTEGER,
  height        INTEGER,
  caption       TEXT NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_entry ON attachments(entry_id, position);

-- trigram 分词支持中文任意子串检索（>=3 个字符），更短的查询走 LIKE
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  id UNINDEXED, body, tokenize = 'trigram'
);
`;

export function openDb(file = paths.db): DB {
  if (file !== ":memory:") {
    for (const dir of [paths.media, paths.thumbs, paths.tmp]) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
