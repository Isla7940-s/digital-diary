import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { paths } from "./config.js";

export type Kind = "image" | "audio" | "video" | "text" | "file";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  tif: "image/tiff", tiff: "image/tiff",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", opus: "audio/opus", flac: "audio/flac", amr: "audio/amr", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", "3gp": "video/3gpp",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json",
  pdf: "application/pdf",
};

export function extOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** 浏览器给的 MIME 不可靠（常见 application/octet-stream），按扩展名兜底 */
export function resolveMime(filename: string, given?: string): string {
  if (given && given !== "application/octet-stream") return given;
  return EXT_MIME[extOf(filename)] ?? "application/octet-stream";
}

export function kindOf(mime: string): Kind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "file";
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

function ffmpegFrame(file: string, at: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("error", reject);
    p.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      code === 0 && buf.length ? resolve(buf) : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

interface ThumbResult { thumb: string | null; width: number | null; height: number | null }

async function makeThumb(id: string, file: string, kind: Kind): Promise<ThumbResult> {
  let input: Buffer | string;
  if (kind === "image") input = file;
  else if (kind === "video") {
    try { input = await ffmpegFrame(file, 1); } catch { input = await ffmpegFrame(file, 0); }
  } else return { thumb: null, width: null, height: null };

  const img = sharp(input, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const name = `${id}.webp`;
  await img.resize(480, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(paths.thumbs, name));
  return {
    thumb: name,
    width: (swap ? meta.height : meta.width) ?? null,
    height: (swap ? meta.width : meta.height) ?? null,
  };
}

export interface StoredFile {
  id: string; kind: Kind; mime: string; size: number; sha256: string;
  path: string; thumb: string | null; width: number | null; height: number | null;
}

/** 把临时文件移入媒体库并生成缩略图。原文件只写一次，之后不会被修改。 */
export async function storeFile(tmpFile: string, originalName: string, givenMime?: string): Promise<StoredFile> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const mime = resolveMime(originalName, givenMime);
  const kind = kindOf(mime);
  const ext = extOf(originalName).replace(/[^a-z0-9]/g, "") || "bin";
  const now = new Date();
  const rel = path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${id}.${ext}`);
  const dest = path.join(paths.media, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const sha256 = await sha256File(tmpFile);
  fs.renameSync(tmpFile, dest);
  fs.chmodSync(dest, 0o444);
  const size = fs.statSync(dest).size;

  let t: ThumbResult = { thumb: null, width: null, height: null };
  try { t = await makeThumb(id, dest, kind); } catch (e) {
    console.warn(`缩略图生成失败 ${originalName}: ${(e as Error).message}`);
  }
  return { id, kind, mime, size, sha256, path: rel, ...t };
}

export function tmpPath(): string {
  fs.mkdirSync(paths.tmp, { recursive: true });
  return path.join(paths.tmp, crypto.randomUUID());
}

export function removeStored(rel: string, thumb: string | null) {
  const f = path.join(paths.media, rel);
  try { fs.chmodSync(f, 0o644); fs.unlinkSync(f); } catch { /* 已不存在 */ }
  if (thumb) try { fs.unlinkSync(path.join(paths.thumbs, thumb)); } catch { /* 已不存在 */ }
}
