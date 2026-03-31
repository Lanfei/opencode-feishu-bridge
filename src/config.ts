import dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  ALLOWED_OPEN_ID: z.string().optional(),
  OPENCODE_MODEL: z.string().optional(),
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000)
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

export function persistAllowedOpenId(openId: string): void {
  const cleanOpenId = openId.trim();
  if (!cleanOpenId) {
    return;
  }

  allowedOpenIds.add(cleanOpenId);
  const merged = Array.from(allowedOpenIds).join(",");
  const envContent = readEnvContent();
  const nextContent = updateEnvValue(envContent, "ALLOWED_OPEN_ID", merged);
  writeEnvContent(nextContent);
}

export const config = {
  appId: parsed.data.FEISHU_APP_ID,
  appSecret: parsed.data.FEISHU_APP_SECRET,
  allowedOpenIds,
  opencodeModel: parsed.data.OPENCODE_MODEL?.trim() || undefined,
  opencodeTimeoutMs: parsed.data.OPENCODE_TIMEOUT_MS
};
