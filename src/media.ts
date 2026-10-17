import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import exifr from "exifr";
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

/** 本地时间 YYYY-MM-DDTHH:mm:ss（按容器 TZ），图库按天分组用 */
export function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Probe { duration: number | null; width: number | null; height: number | null; created: Date | null }

function ffprobe(file: string): Promise<Probe> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve({ duration: null, width: null, height: null, created: null }));
    p.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === "video");
        const tag = j.format?.tags?.creation_time ?? v?.tags?.creation_time;
        const created = tag ? new Date(tag) : null;
        // 旋转 90° 的手机视频需要交换宽高
        const rot = Math.abs(Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0));
        const swap = rot === 90 || rot === 270;
        resolve({
          duration: Number(j.format?.duration) || null,
          width: (swap ? v?.height : v?.width) ?? null,
          height: (swap ? v?.width : v?.height) ?? null,
          // 很多设备在没有时间时写入 1970/1904
          created: created && !isNaN(created.getTime()) && created.getFullYear() > 1990 ? created : null,
        });
      } catch { resolve({ duration: null, width: null, height: null, created: null }); }
    });
  });
}

async function exifTime(file: string): Promise<Date | null> {
  try {
    const t = await exifr.parse(file, ["DateTimeOriginal", "CreateDate"]);
    const d: unknown = t?.DateTimeOriginal ?? t?.CreateDate;
    return d instanceof Date && !isNaN(d.getTime()) && d.getFullYear() > 1990 ? d : null;
  } catch { return null; }
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

// ---------- 浏览用的中等尺寸图片 ----------
// 原图动辄 3000×4000、10MB，页面里只需要几百到一两千像素宽：按需生成 WebP 并缓存在 thumbs 目录

export const VIEW_WIDTHS = [800, 1600, 2560];
const viewName = (id: string, w: number) => `${id}_w${w}.webp`;
const inflight = new Map<string, Promise<string | null>>();

/** 返回宽度为 w 的浏览版文件路径；不适合转换的格式（GIF 动图、SVG 等）或转换失败时返回 null，由调用方回退到原图 */
export function viewImage(id: string, rel: string, mime: string, w: number): Promise<string | null> {
  const name = viewName(id, w);
  const out = path.join(paths.thumbs, name);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!/^image\/(jpeg|png|webp|tiff|avif|heic|heif)$/.test(mime)) return Promise.resolve(null);
  let job = inflight.get(name);
  if (!job) {
    job = (async () => {
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        await sharp(path.join(paths.media, rel), { failOn: "none" }).rotate()
          .resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
        fs.renameSync(tmp, out);
        return out;
      } catch {
        fs.rmSync(tmp, { force: true });
        return null;
      }
    })().finally(() => inflight.delete(name));
    inflight.set(name, job);
  }
  return job;
}

const warming = new Set<Promise<unknown>>();

/** 上传后在后台预先生成常用的两档，第一次打开时不用等 */
export function warmViews(a: { id: string; path: string; mime: string; kind: string }) {
  if (a.kind !== "image") return;
  const job = viewImage(a.id, a.path, a.mime, 800).then(() => viewImage(a.id, a.path, a.mime, 1600));
  warming.add(job);
  void job.finally(() => warming.delete(job));
}

/** 等后台的图片生成都结束：永久删除原图前调用（Windows 上正被读取的文件删不掉） */
export async function viewsIdle() {
  while (warming.size || inflight.size) await Promise.allSettled([...warming, ...inflight.values()]);
}

export function removeViews(id: string) {
  for (const w of VIEW_WIDTHS) fs.rmSync(path.join(paths.thumbs, viewName(id, w)), { force: true });
}

export interface StoredFile {
  id: string; kind: Kind; mime: string; size: number; sha256: string;
  path: string; thumb: string | null; width: number | null; height: number | null;
  duration: number | null; taken_at: string; live_offset: number | null; content_id: string | null;
}

/**
 * 把临时文件移入媒体库，生成缩略图并读取拍摄时间、时长。原文件只写一次，之后不会被修改。
 * 拍摄时间优先级：EXIF / 视频元数据 > 客户端提供的文件修改时间 > 上传时间
 */
export async function storeFile(tmpFile: string, originalName: string, givenMime?: string, fileTime?: Date): Promise<StoredFile> {
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
  let duration: number | null = null, taken: Date | null = null;
  if (kind === "image") taken = await exifTime(dest);
  else if (kind === "video" || kind === "audio") {
    const pr = await ffprobe(dest);
    duration = pr.duration;
    taken = pr.created;
    if (kind === "video" && pr.width && pr.height) { t.width = pr.width; t.height = pr.height; }
  }
  const fallback = fileTime && !isNaN(fileTime.getTime()) && fileTime.getFullYear() > 1990 ? fileTime : now;
  return { id, kind, mime, size, sha256, path: rel, ...t, duration, taken_at: localIso(taken ?? fallback), ...probeLive(dest, kind, mime) };
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

// ---------- 实况照片 / 动态照片 ----------
// Google 动态照片（Motion Photo，含旧版 MicroVideo）：MP4 直接追加在 JPEG/HEIC 末尾，XMP 里写明长度或偏移。
// 微信等转存时常会丢掉主 XMP，所以 XMP 没写时再从文件尾部找一段能一直数到文件结尾的 MP4 盒子链兜底。
// Apple 实况照片：照片和一段 .MOV 是两个文件，靠 ContentIdentifier（同一个 UUID）配对，见 store.pairLive。

/** 从 pos 开始按 ISO BMFF 盒子逐个跳，刚好落在文件结尾且含 moov 才算一段完整视频 */
function mp4ChainToEnd(b: Buffer, pos: number): boolean {
  if (b.toString("latin1", pos + 4, pos + 8) !== "ftyp") return false;
  let p = pos, moov = false;
  while (p + 8 <= b.length) {
    let size = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    if (size === 1) {
      if (p + 16 > b.length) return false;
      size = Number(b.readBigUInt64BE(p + 8));
    } else if (size === 0) size = b.length - p;
    if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) return false;
    if (type === "moov") moov = true;
    p += size;
  }
  return p === b.length && moov;
}

/** 返回内嵌 MP4 在文件中的起始字节；不是动态照片时返回 null */
export function findMotionVideo(b: Buffer): number | null {
  const head = b.toString("latin1", 0, Math.min(b.length, 256 * 1024));
  const tryAt = (len: number) => {
    const at = b.length - len;
    return len > 0 && at > 0 && mp4ChainToEnd(b, at) ? at : null;
  };
  // 旧版 MicroVideo：偏移量是视频长度
  const mv = /MicroVideoOffset\s*=\s*"(\d+)"|<GCamera:MicroVideoOffset>(\d+)</.exec(head);
  if (mv) { const at = tryAt(Number(mv[1] ?? mv[2])); if (at !== null) return at; }
  // 新版 Motion Photo：Container:Directory 里 Semantic="MotionPhoto" 的条目，长度 + 可选填充
  for (const m of head.matchAll(/<Container:Item\b[^>]*?Item:Semantic="MotionPhoto"[^>]*>/g)) {
    const len = Number(/Item:Length="(\d+)"/.exec(m[0])?.[1] ?? 0);
    const pad = Number(/Item:Padding="(\d+)"/.exec(m[0])?.[1] ?? 0);
    const at = tryAt(len + pad) ?? tryAt(len);
    if (at !== null) return at;
  }
  // 兜底：从后往前找 ftyp
  const ftyp = Buffer.from("ftyp");
  for (let i = b.lastIndexOf(ftyp); i > 4; i = b.lastIndexOf(ftyp, i - 1)) {
    if (mp4ChainToEnd(b, i - 4)) return i - 4;
  }
  return null;
}

const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;

/**
 * Apple 实况照片的配对标识：照片 EXIF MakerNote 里的 ContentIdentifier，
 * 视频 QuickTime 元数据 com.apple.quicktime.content.identifier。两者是同一个 UUID
 */
export function appleContentId(b: Buffer, kind: Kind): string | null {
  const s = b.toString("latin1");
  if (kind === "video") {
    const k = s.indexOf("com.apple.quicktime.content.identifier");
    if (k < 0) return null;
    // 键在 keys 盒子里，值在后面的 ilst 里；正常是 moov 里唯一的 UUID 字符串
    UUID_RE.lastIndex = 0;
    return UUID_RE.exec(s.slice(k))?.[0] ?? null;
  }
  if (!s.includes("Apple iOS")) return null;
  const at = s.indexOf("Apple iOS");
  UUID_RE.lastIndex = 0;
  return UUID_RE.exec(s.slice(at, at + 64 * 1024))?.[0] ?? null;
}

export interface LiveInfo { live_offset: number | null; content_id: string | null }

/** 上传时读一次：Google 动态照片的视频位置、Apple 实况照片的配对标识 */
export function probeLive(file: string, kind: Kind, mime: string): LiveInfo {
  const none = { live_offset: null, content_id: null };
  if (kind !== "image" && kind !== "video") return none;
  if (kind === "video" && mime !== "video/quicktime") return none;
  try {
    const b = fs.readFileSync(file);
    return {
      live_offset: kind === "image" && /^image\/(jpeg|heic|heif)$/.test(mime) ? findMotionVideo(b) : null,
      content_id: appleContentId(b, kind),
    };
  } catch { return none; }
}
