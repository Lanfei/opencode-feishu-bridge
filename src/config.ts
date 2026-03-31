import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  ALLOWED_OPEN_ID: z.string().optional(),
  OPENCODE_MODEL: z.string().optional(),
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
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

const allowedOpenIds = new Set(
  (parsed.data.ALLOWED_OPEN_ID ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const opencodeServerPassword =
  parsed.data.OPENCODE_SERVER_PASSWORD && parsed.data.OPENCODE_SERVER_PASSWORD.trim().length > 0
    ? parsed.data.OPENCODE_SERVER_PASSWORD.trim()
    : randomBytes(18).toString("hex");

if (!parsed.data.OPENCODE_SERVER_PASSWORD || parsed.data.OPENCODE_SERVER_PASSWORD.trim().length === 0) {
  console.warn("OPENCODE_SERVER_PASSWORD 为空，已使用随机字符串作为当前进程密码。");
}

process.env.OPENCODE_SERVER_PASSWORD = opencodeServerPassword;

function updateEnvValue(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }

  const normalized = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  return `${normalized}${key}=${value}\n`;
}

function readEnvContent(): string {
  const envPath = resolve(process.cwd(), ".env");
  try {
    return readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
}

function writeEnvContent(content: string): void {
  const envPath = resolve(process.cwd(), ".env");
  writeFileSync(envPath, content, "utf8");
}

function parseAllowedOpenIdsFromEnv(content: string): string[] {
  const match = content.match(/^ALLOWED_OPEN_ID=(.*)$/m);
  if (!match) {
    return [];
  }

  return (match[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function persistAllowedOpenId(openId: string): void {
  const cleanOpenId = openId.trim();
  if (!cleanOpenId) {
    return;
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const envContent = readEnvContent();
    const diskIds = parseAllowedOpenIdsFromEnv(envContent);
    const mergedSet = new Set([...allowedOpenIds, ...diskIds, cleanOpenId]);
    const merged = Array.from(mergedSet).join(",");
    const nextContent = updateEnvValue(envContent, "ALLOWED_OPEN_ID", merged);
    writeEnvContent(nextContent);

    const verifyIds = new Set(parseAllowedOpenIdsFromEnv(readEnvContent()));
    if (verifyIds.has(cleanOpenId)) {
      for (const id of verifyIds) {
        allowedOpenIds.add(id);
      }
      return;
    }
  }

  throw new Error(`写入 ALLOWED_OPEN_ID 失败：重试 ${String(maxAttempts)} 次后未校验通过`);
}

export const config = {
  appId: parsed.data.FEISHU_APP_ID,
  appSecret: parsed.data.FEISHU_APP_SECRET,
  allowedOpenIds,
  opencodeModel: parsed.data.OPENCODE_MODEL?.trim() || undefined,
  opencodeTimeoutMs: parsed.data.OPENCODE_TIMEOUT_MS,
  opencodeServeHost: parsed.data.OPENCODE_SERVE_HOST,
  opencodeServePort: parsed.data.OPENCODE_SERVE_PORT,
  opencodeServerPassword
};
