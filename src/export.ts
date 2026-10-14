import path from "node:path";
import { ZipArchive, type ZipEntryData } from "archiver";
import type { Writable } from "node:stream";
import { paths } from "./config.js";
import type { Store, EntryWithAttachments, Attachment } from "./store.js";

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
const numbered = (list: Attachment[]) => list.map((a, i) => `${String(i + 1).padStart(2, "0")}-${safe(a.original_name)}`);

function entryMarkdown(e: EntryWithAttachments, pageFiles: string[], mediaFiles: string[]): string {
  const lines = [`# ${e.id}${e.title ? ` ${e.title}` : ""}`, "", `- 日期：${e.date}`];
  if (e.tags.length) lines.push(`- 标签：${e.tags.map((t) => `#${t}`).join(" ")}`);
  lines.push("");
  if (e.body) {
    // 正文里的 media:ID 换成 zip 内的相对路径，离线也能直接预览图文
    const files = new Map<string, string>();
    e.media.forEach((a, i) => files.set(a.id, `媒体/${mediaFiles[i]}`));
    e.pages.forEach((a, i) => files.set(a.id, `原稿/${pageFiles[i]}`));
    lines.push("## 正文", "", e.body.replace(/\]\(media:([\w-]+)\)/g, (m, id: string) => (files.has(id) ? `](${encodeURI(files.get(id)!)})` : m)), "");
  }
  if (e.note) lines.push("## 备注", "", e.note, "");
  const list = (title: string, dir: string, atts: Attachment[], files: string[]) => {
    if (!atts.length) return;
    lines.push(`## ${title}`, "");
    atts.forEach((a, i) => lines.push(`- [${a.original_name}](${encodeURI(`${dir}/${files[i]}`)})${a.caption ? ` — ${a.caption}` : ""}`));
    lines.push("");
  };
  list("纸质原稿", "原稿", e.pages, pageFiles);
  list("富媒体", "媒体", e.media, mediaFiles);
  return lines.join("\n");
}

/** 已经压缩过的格式（JPEG、视频、有损音频、压缩包等）再 Deflate 只会白费 CPU，直接存储；文本与无损原始格式用最高级别 Deflate */
const PRECOMPRESSED = /^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/|audio\/(mpeg|mp4|aac|ogg|opus|webm|x-m4a|m4a)|application\/(zip|gzip|x-7z-compressed|x-rar-compressed|pdf|epub\+zip|vnd\.openxmlformats))/;
const storeOnly = (a: Attachment) => PRECOMPRESSED.test(a.mime);

export type Split = "none" | "year" | "month" | "size";
export interface ExportOptions { split?: Split; sizeMB?: number }
/** 一卷的内容：完整的若干篇日记 + 若干未归组文件；一篇日记永远不会被拆到两卷 */
export interface Volume { n: number; label: string; entries: EntryWithAttachments[]; loose: Attachment[]; files: number; bytes: number }

function allLoose(store: Store): Attachment[] {
  const loose: Attachment[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = store.listMedia({ ungrouped: true, role: "all", limit: 500, offset });
    loose.push(...r.items);
    if (loose.length >= r.total || !r.items.length) break;
  }
  return loose;
}

/** 按日期（年/月）或按大小把数据切成若干卷；按大小时按日期顺序装箱，超过上限就换下一卷（单篇超过上限时独占一卷） */
export function planVolumes(store: Store, opts: ExportOptions = {}): Volume[] {
  const split = opts.split ?? "none";
  type Unit = { date: string; entry?: EntryWithAttachments; att?: Attachment; files: number; bytes: number };
  const units: Unit[] = [
    ...store.allEntries().map((e) => {
      const atts = [...e.pages, ...e.media];
      return { date: e.date, entry: e, files: atts.length + 1, bytes: atts.reduce((t, a) => t + a.size, 0) + e.body.length };
    }),
    ...allLoose(store).map((a) => ({ date: a.taken_at.slice(0, 10), att: a, files: 1, bytes: a.size })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const groups: { key: string; units: Unit[] }[] = [];
  if (split === "year" || split === "month") {
    const len = split === "year" ? 4 : 7;
    for (const u of units) {
      const key = u.date.slice(0, len);
      if (groups.at(-1)?.key !== key) groups.push({ key, units: [] });
      groups.at(-1)!.units.push(u);
    }
  } else if (split === "size") {
    const limit = Math.max(50, opts.sizeMB || 2048) * 1024 * 1024;
    let cur = 0;
    for (const u of units) {
      if (!groups.length || (cur + u.bytes > limit && cur > 0)) { groups.push({ key: "", units: [] }); cur = 0; }
      groups.at(-1)!.units.push(u);
      cur += u.bytes;
    }
  } else {
    groups.push({ key: "", units });
  }

  return groups.map((g, i) => {
    const first = g.units[0]?.date ?? "", last = g.units.at(-1)?.date ?? "";
    const label = g.key || (first === last ? first : `${first} ~ ${last}`);
    return {
      n: i + 1, label,
      entries: g.units.flatMap((u) => (u.entry ? [u.entry] : [])),
      loose: g.units.flatMap((u) => (u.att ? [u.att] : [])),
      files: g.units.reduce((t, u) => t + u.files, 0),
      bytes: g.units.reduce((t, u) => t + u.bytes, 0),
    };
  });
}

/** 卷的文件名：按日期分卷带上年/月，按大小分卷带上 01of03 */
export function volumeName(stamp: string, opts: ExportOptions, v: Volume, total: number): string {
  if (total <= 1 && (opts.split ?? "none") === "none") return `diary-export-${stamp}.zip`;
  const tag = opts.split === "year" || opts.split === "month" ? v.label : `part${String(v.n).padStart(2, "0")}of${String(total).padStart(2, "0")}`;
  return `diary-export-${stamp}-${tag}.zip`;
}

/**
 * 导出一卷为 zip（每卷都能单独解压使用）：
 *   日记/2026/2026-10-13/261013-1/{entry.md, 原稿/, 媒体/}
 *   文章/2026/2026-10-13/A261013-1/{entry.md, 媒体/}
 *   图库-未归组/2026-10/...
 *   index.json（只含本卷内容，并注明第几卷）
 */
export async function exportZip(store: Store, out: Writable, opts: ExportOptions = {}, vol = 1) {
  const volumes = planVolumes(store, opts);
  const v = volumes[vol - 1];
  if (!v) throw new RangeError(`没有第 ${vol} 卷（共 ${volumes.length} 卷）`);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.pipe(out);
  const add = (a: Attachment, name: string) => {
    const data: ZipEntryData = { name, store: storeOnly(a) };  // 类型定义的 file() 漏了 zip 专属的 store，运行时是支持的
    zip.file(path.join(paths.media, a.path), data);
  };
  for (const e of v.entries) {
    const dir = `${e.kind === "article" ? "文章" : "日记"}/${e.date.slice(0, 4)}/${e.date}/${e.id}`;
    const pf = numbered(e.pages), mf = numbered(e.media);
    zip.append(entryMarkdown(e, pf, mf), { name: `${dir}/entry.md` });
    e.pages.forEach((a, i) => add(a, `${dir}/原稿/${pf[i]}`));
    e.media.forEach((a, i) => add(a, `${dir}/媒体/${mf[i]}`));
  }
  for (const a of v.loose) {
    add(a, `图库-未归组/${a.taken_at.slice(0, 7)}/${a.taken_at.slice(0, 10)}_${a.id.slice(0, 6)}_${safe(a.original_name)}`);
  }
  zip.append(JSON.stringify({
    exported_at: new Date().toISOString(),
    volume: { n: v.n, total: volumes.length, split: opts.split ?? "none", label: v.label },
    entries: v.entries, ungrouped: v.loose,
  }, null, 2), { name: "index.json" });
  await zip.finalize();
}
