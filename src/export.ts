import path from "node:path";
import { ZipArchive } from "archiver";
import type { Writable } from "node:stream";
import { paths } from "./config.js";
import type { Store, EntryWithAttachments } from "./store.js";

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);

function entryMarkdown(e: EntryWithAttachments, files: string[]): string {
  const lines = [`# ${e.id}${e.title ? ` ${e.title}` : ""}`, "", `- 日期：${e.date}`];
  if (e.tags.length) lines.push(`- 标签：${e.tags.map((t) => `#${t}`).join(" ")}`);
  lines.push("");
  if (e.note) lines.push(e.note, "");
  if (e.attachments.length) {
    lines.push("## 附件", "");
    e.attachments.forEach((a, i) => lines.push(`- [${a.original_name}](${encodeURI(files[i])})${a.caption ? ` — ${a.caption}` : ""}`));
  }
  return lines.join("\n") + "\n";
}

/** 导出为 zip：每篇日记一个文件夹（entry.md + 原始附件），根目录附 index.json */
export async function exportZip(store: Store, out: Writable) {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  zip.pipe(out);
  const entries = store.allEntries();
  for (const e of entries) {
    const dir = `${e.date.slice(0, 4)}/${e.date}/${e.id}`;
    const files = e.attachments.map((a, i) => `${String(i + 1).padStart(2, "0")}-${safe(a.original_name)}`);
    zip.append(entryMarkdown(e, files), { name: `${dir}/entry.md` });
    e.attachments.forEach((a, i) => zip.file(path.join(paths.media, a.path), { name: `${dir}/${files[i]}` }));
  }
  zip.append(JSON.stringify({ exported_at: new Date().toISOString(), entries }, null, 2), { name: "index.json" });
  await zip.finalize();
}
