import { config } from "./config";
import { createChatQueue } from "./chat-queue";
import { createFeishu } from "./feishu";
import { error as logError, log, logf, LOG_SCOPES } from "./logger";
import { createOpenCode } from "./opencode";
import { createOrchestrator } from "./orchestrator";

const handledEvents = new Map<string, number>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const STOP_COMMAND = "/stop";
const allowAllOpenIds = config.allowedOpenIds.size === 0;

function cleanupHandledEvents(now: number): void {
  for (const [eventId, timestamp] of handledEvents.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      handledEvents.delete(eventId);
    }
  }
}

function shouldHandleEvent(eventId?: string): boolean {
  const now = Date.now();
  cleanupHandledEvents(now);

  if (!eventId) {
    return true;
  }

  if (handledEvents.has(eventId)) {
    logf(LOG_SCOPES.feishu, "skip_duplicated", { event_id: eventId });
    return false;
  }

  handledEvents.set(eventId, now);
  return true;
}

function isStopCommand(text: string): boolean {
  return new RegExp(`^${STOP_COMMAND}(?:\\s+)?$`).test(text.trim());
}

function buildStopMessage(result: { aborted: boolean; removed: number }): string {
  if (result.aborted) {
    return `已停止当前聊天任务，并清空队列 ${String(result.removed)} 条待处理消息。`;
  }

  if (result.removed > 0) {
    return `当前聊天没有运行中的任务，已清空队列 ${String(result.removed)} 条待处理消息。`;
  }

  return "当前聊天没有运行中的任务，队列也为空。";
}

async function bootstrap(): Promise<void> {
  const feishu = createFeishu({
    appId: config.appId,
    appSecret: config.appSecret
  });

  const opencode = createOpenCode({
    defaultWorkdir: config.opencodeWorkdir,
    hostname: config.opencodeServeHost,
    port: config.opencodeServePort,
    timeoutMs: config.opencodeTimeoutMs
  });

  let opencodeReadyPromise: Promise<void> | undefined;

  const queue = createChatQueue({
    waitUntilReady: async () => {
      if (opencodeReadyPromise) {
        await opencodeReadyPromise;
      }
    },
    isAbortError: opencode.isAbortError
  });

  const orchestrator = createOrchestrator({
    opencode,
    defaultModel: config.opencodeModel,
    defaultWorkdir: config.opencodeWorkdir,
    replyText: feishu.safeReplyText,
    createStream: feishu.createStream
  });

  const eventDispatcher = feishu.createEventDispatcher({
    onMessageRecalled: async (data) => {
      const eventId = data.event_id;
      if (!shouldHandleEvent(eventId)) {
        return;
      }

      const messageId = data.message_id;
      if (!messageId) {
        return;
      }

      const result = queue.recall(messageId);
      logf(LOG_SCOPES.feishu, "recalled", {
        event_id: eventId ?? "unknown",
        message_id: messageId,
        aborted: result.aborted,
        removed: result.removed
      });
    },
    onMessageReceived: async (data) => {
      const eventId = data.event_id;
      if (!shouldHandleEvent(eventId)) {
        return;
      }

      const senderType = data.sender?.sender_type;
      if (senderType !== "user") {
        return;
      }

      const openId = data.sender?.sender_id?.open_id;
      if (!openId) {
        return;
      }

      const chatId = data.message?.chat_id;
      if (!chatId) {
        return;
      }

      const sourceMessageId = data.message?.message_id;
      const messageType = data.message?.message_type;
      if (messageType !== "text") {
        await feishu.safeReplyText({
          chatId,
          text: "当前仅支持文本消息。",
          replyToMessageId: sourceMessageId,
          eventId,
          openId
        });
        return;
      }

      const content = data.message?.content ?? "";
      const text = feishu.parseTextContent(content);
      logf(LOG_SCOPES.feishu, "receive", {
        chat_id: chatId,
        open_id: openId,
        event_id: eventId ?? "unknown",
        message_type: messageType,
        text
      });

      if (!text) {
        await feishu.safeReplyText({
          chatId,
          text: "消息内容为空或格式不支持。",
          replyToMessageId: sourceMessageId,
          eventId,
          openId
        });
        return;
      }

      if (!allowAllOpenIds && !config.allowedOpenIds.has(openId)) {
        await feishu.safeReplyText({
          chatId,
          text: `当前用户未授权。你的 open_id：${openId}。请联系管理员将该 open_id 加入 allowedOpenId。`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId
        });
        return;
      }

      if (isStopCommand(text)) {
        const result = queue.stop(chatId);
        await feishu.safeReplyText({
          chatId,
          text: buildStopMessage(result),
          replyToMessageId: sourceMessageId,
          eventId,
          openId
        });
        return;
      }

      queue.enqueue(chatId, sourceMessageId, async (signal) => {
        await orchestrator.handleMessage({
          chatId,
          sourceMessageId,
          openId,
          text,
          eventId,
          signal
        });
      });
    }
  });

  async function shutdown(): Promise<void> {
    feishu.close();
    await opencode.stop();
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await shutdown();
      process.exit(0);
    });
  }
  try {
    await feishu.start({ eventDispatcher });
    log(LOG_SCOPES.bootstrap, "飞书长连接已启动，等待消息...");

    opencodeReadyPromise = opencode.start();
    await opencodeReadyPromise;
    log(LOG_SCOPES.bootstrap, "OpenCode 已就绪，开始处理队列与新消息...");
  } catch (error) {
    await shutdown();
    throw error;
  }
}

bootstrap().catch((error) => {
  logError(LOG_SCOPES.bootstrap, "启动失败", error);
  process.exit(1);
});
