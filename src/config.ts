import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  ALLOWED_OPEN_ID: z.string().optional(),
  OPENCODE_MODEL: z.string().optional(),
  OPENCODE_TIMEOUT: z.coerce.number().int().positive().default(300),
  OPENCODE_WORKDIR: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().trim().min(1).default(homedir())
  ),
  OPENCODE_SERVE_HOST: z.string().min(1).default("127.0.0.1"),
  OPENCODE_SERVE_PORT: z.coerce.number().int().min(1).max(65535).default(4096),
  OPENCODE_SERVER_PASSWORD: z.string().optional()
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("环境变量校验失败:");
  for (const issue of parsed.error.issues) {
    console.error(`- ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const opencodeWorkdir = parsed.data.OPENCODE_WORKDIR;
try {
  if (!statSync(opencodeWorkdir).isDirectory()) {
    console.error(`环境变量校验失败:\n- OPENCODE_WORKDIR: 不是目录 (${opencodeWorkdir})`);
    process.exit(1);
  }
} catch {
  console.error(`环境变量校验失败:\n- OPENCODE_WORKDIR: 目录不存在或不可访问 (${opencodeWorkdir})`);
  process.exit(1);
}

const allowedOpenIds = new Set(
  (parsed.data.ALLOWED_OPEN_ID ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

if (allowedOpenIds.size === 0) {
  console.warn("[config]: ALLOWED_OPEN_ID 为空，当前允许所有 open_id 接入。请注意安全风险。");
}

const opencodeTimeoutMs = parsed.data.OPENCODE_TIMEOUT * 1000;

const opencodeServerPassword =
  parsed.data.OPENCODE_SERVER_PASSWORD && parsed.data.OPENCODE_SERVER_PASSWORD.trim().length > 0
    ? parsed.data.OPENCODE_SERVER_PASSWORD.trim()
    : randomBytes(18).toString("hex");

if (!parsed.data.OPENCODE_SERVER_PASSWORD || parsed.data.OPENCODE_SERVER_PASSWORD.trim().length === 0) {
  console.warn(`[config]: OPENCODE_SERVER_PASSWORD 为空，已使用随机字符串作为当前进程密码: ${opencodeServerPassword}`);
}

process.env.OPENCODE_SERVER_PASSWORD = opencodeServerPassword;

export const config = {
  appId: parsed.data.FEISHU_APP_ID,
  appSecret: parsed.data.FEISHU_APP_SECRET,
  allowedOpenIds,
  opencodeModel: parsed.data.OPENCODE_MODEL?.trim() || undefined,
  opencodeTimeoutMs,
  opencodeWorkdir,
  opencodeServeHost: parsed.data.OPENCODE_SERVE_HOST,
  opencodeServePort: parsed.data.OPENCODE_SERVE_PORT,
  opencodeServerPassword
};
