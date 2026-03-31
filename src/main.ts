import * as Lark from "@larksuiteoapi/node-sdk";
import { randomBytes } from "node:crypto";
import { config, persistAllowedOpenId } from "./config";
import { askOpenCode } from "./opencode";

const client = new Lark.Client({
  appId: config.appId,
  appSecret: config.appSecret
});

const wsClient = new Lark.WSClient({
  appId: config.appId,
  appSecret: config.appSecret,
  autoReconnect: true,
  loggerLevel: Lark.LoggerLevel.info
});

const handledEvents = new Map<string, number>();
const allowedOpenIds = new Set(config.allowedOpenIds);
const sessionByUser = new Map<string, string>();
const pendingTokens = new Map<string, { token: string; expiresAt: number }>();
const userMessageQueues = new Map<string, Promise<void>>();
const queuedMessageCount = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const RESET_COMMAND = "/reset";
const NEW_COMMAND = "/new";

function enqueueUserMessage(openId: string, task: () => Promise<void>): void {
  const previous = userMessageQueues.get(openId) ?? Promise.resolve();
  const nextCount = (queuedMessageCount.get(openId) ?? 0) + 1;
  queuedMessageCount.set(openId, nextCount);

  if (nextCount > 1) {
    console.log(`[queue] open_id=${openId} queued=${nextCount}`);
  }

  const current = previous
    .catch(() => {
      return;
    })
    .then(task)
    .finally(() => {
      const rest = (queuedMessageCount.get(openId) ?? 1) - 1;
      if (rest <= 0) {
        queuedMessageCount.delete(openId);
        if (userMessageQueues.get(openId) === current) {
          userMessageQueues.delete(openId);
        }
        return;
      }

      queuedMessageCount.set(openId, rest);
    });

  userMessageQueues.set(openId, current);
}

function cleanupHandledEvents(now: number): void {
  for (const [eventId, timestamp] of handledEvents.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      handledEvents.delete(eventId);
    }
  }
}

function parseTextContent(content: string): string {
  try {
    const payload = JSON.parse(content) as { text?: string };
    return payload.text?.trim() ?? "";
  } catch {
    return "";
  }
}

function generateTempToken(): string {
  return randomBytes(16).toString("hex");
}

function getOrCreatePendingToken(openId: string): { token: string; expiresAt: number } {
  const current = pendingTokens.get(openId);
  const now = Date.now();

  if (current && current.expiresAt > now) {
    return current;
  }

  const created = {
    token: generateTempToken(),
    expiresAt: now + TOKEN_TTL_MS
  };

  pendingTokens.set(openId, created);
  return created;
}

async function replyText(chatId: string, text: string): Promise<void> {
  await client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id"
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    }
  });
}

async function safeReplyText(chatId: string, text: string, context: string): Promise<void> {
  try {
    await replyText(chatId, text);
  } catch (error) {
    console.error(`[reply] 发送失败 context=${context} chat_id=${chatId}`, error);
  }
}

async function processUserMessage(params: {
  chatId: string;
  senderOpenId: string;
  text: string;
  eventId?: string;
}): Promise<void> {
  const { chatId, senderOpenId, text, eventId } = params;

  if (text === RESET_COMMAND || text === NEW_COMMAND) {
    sessionByUser.delete(senderOpenId);
    await safeReplyText(chatId, "上下文已重置。接下来会开启新会话。", "reset");
    return;
  }

  const previousSessionId = sessionByUser.get(senderOpenId);

  try {
    console.log(
      `[opencode] start open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${previousSessionId ?? "new"}`
    );
    const result = await askOpenCode({
      message: text,
      sessionId: previousSessionId,
      model: config.opencodeModel,
      timeoutMs: config.opencodeTimeoutMs
    });

    sessionByUser.set(senderOpenId, result.sessionId);
    console.log(
      `[opencode] success open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${result.sessionId}`
    );
    await safeReplyText(chatId, result.text, "opencode_success");
  } catch (error) {
    const errorMessage =
      error instanceof Error && error.message
        ? error.message
        : "调用 OpenCode 失败，请稍后重试。";
    console.error(`[opencode] failed open_id=${senderOpenId}`, error);
    await safeReplyText(chatId, `处理失败：${errorMessage}`, "opencode_error");
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const eventId = data.event_id;
    const now = Date.now();
    cleanupHandledEvents(now);

    if (eventId && handledEvents.has(eventId)) {
      console.log(`[event] skip duplicated event_id=${eventId}`);
      return;
    }

    if (eventId) {
      handledEvents.set(eventId, now);
    }

    const senderType = data.sender?.sender_type;
    if (senderType !== "user") {
      return;
    }

    const senderOpenId = data.sender?.sender_id?.open_id;
    if (!senderOpenId) {
      return;
    }

    const chatId = data.message?.chat_id;
    if (!chatId) {
      return;
    }

    const messageType = data.message?.message_type;
    if (messageType !== "text") {
      await safeReplyText(chatId, "当前仅支持文本消息。", "non_text");
      return;
    }

    const text = parseTextContent(data.message.content);
    console.log(
      `[event] receive open_id=${senderOpenId} event_id=${eventId ?? "unknown"} message_type=${messageType} text=${JSON.stringify(text)}`
    );
    if (!text) {
      await safeReplyText(chatId, "消息内容为空或格式不支持。", "empty_text");
      return;
    }

    if (!allowedOpenIds.has(senderOpenId)) {
      const pending = getOrCreatePendingToken(senderOpenId);

      if (text === pending.token) {
        pendingTokens.delete(senderOpenId);
        allowedOpenIds.add(senderOpenId);
        try {
          persistAllowedOpenId(senderOpenId);
          await safeReplyText(chatId, `鉴权成功，已将 open_id 加入 .env：${senderOpenId}`, "auth_success");
        } catch (error) {
          await safeReplyText(
            chatId,
            `鉴权成功，但写入 .env 失败。你的 open_id：${senderOpenId}，请手动加入 ALLOWED_OPEN_ID。`
            ,
            "auth_persist_error"
          );
          console.error("写入 ALLOWED_OPEN_ID 失败:", error);
        }
        return;
      }

      const remainingSeconds = Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 1000));
      console.log(
        `[auth] open_id=${senderOpenId} 临时token=${pending.token} 有效期=${remainingSeconds}s`
      );

      await safeReplyText(
        chatId,
        `当前用户未授权。你的 open_id：${senderOpenId}。\n请联系管理员查看服务日志中的临时 token，并在10分钟内回发该 token 完成验证。`,
        "auth_required"
      );
      return;
    }

    enqueueUserMessage(senderOpenId, async () => {
      await processUserMessage({ chatId, senderOpenId, text, eventId });
    });
  }
});

async function bootstrap(): Promise<void> {
  await wsClient.start({ eventDispatcher });
  console.log("飞书长连接已启动，等待消息...");
}

bootstrap().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    wsClient.close();
    process.exit(0);
  });
}
