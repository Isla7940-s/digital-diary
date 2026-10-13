import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  // 对外访问地址，用于 MCP 返回的文件链接，例如 http://192.168.1.10:3000
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, ""),
  // MCP 单次上传（base64 / URL 抓取）的大小上限，单位 MB
  mcpMaxUploadMb: Number(process.env.MCP_MAX_UPLOAD_MB ?? 200),
};

export const paths = {
  db: path.join(config.dataDir, "diary.db"),
  media: path.join(config.dataDir, "media"),
  thumbs: path.join(config.dataDir, "thumbs"),
  tmp: path.join(config.dataDir, "tmp"),
};
