import path from "node:path";
import { ZipArchive } from "archiver";
import type { Writable } from "node:stream";
import { paths } from "./config.js";
import type { Store, EntryWithAttachments, Attachment } from "./store.js";

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
const numbered = (list: Attachment[]) => list.map((a, i) => `${String(i + 1).padStart(2, "0")}-${safe(a.original_name)}`);

function entryMarkdown(e: EntryWithAttachments, pageFiles: string[], mediaFiles: string[]): string {
  const lines = [`# ${e.id}${e.title ? ` ${e.title}` : ""}`, "", `- 日期：${e.date}`];
  if (e.tags.length) lines.push(`- 标签：${e.tags.map((t) => `#${t}`).join(" ")}`);
  lines.push("");
  if (e.note) lines.push(e.note, "");
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

/**
 * 导出为 zip：
 *   日记/2026/2026-10-13/261013-1/{entry.md, 原稿/, 媒体/}
 *   图库-未归组/2026-10/...
 *   index.json
 */
export async function exportZip(store: Store, out: Writable) {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  zip.pipe(out);
  const entries = store.allEntries();
  for (const e of entries) {
    const dir = `日记/${e.date.slice(0, 4)}/${e.date}/${e.id}`;
    const pf = numbered(e.pages), mf = numbered(e.media);
    zip.append(entryMarkdown(e, pf, mf), { name: `${dir}/entry.md` });
    e.pages.forEach((a, i) => zip.file(path.join(paths.media, a.path), { name: `${dir}/原稿/${pf[i]}` }));
    e.media.forEach((a, i) => zip.file(path.join(paths.media, a.path), { name: `${dir}/媒体/${mf[i]}` }));
  }
  const loose: Attachment[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = store.listMedia({ ungrouped: true, role: "all", limit: 500, offset });
    loose.push(...r.items);
    if (loose.length >= r.total || !r.items.length) break;
  }
  for (const a of loose) {
    zip.file(path.join(paths.media, a.path), { name: `图库-未归组/${a.taken_at.slice(0, 7)}/${a.taken_at.slice(0, 10)}_${a.id.slice(0, 6)}_${safe(a.original_name)}` });
  }
  zip.append(JSON.stringify({ exported_at: new Date().toISOString(), entries, ungrouped: loose }, null, 2), { name: "index.json" });
  await zip.finalize();
}
