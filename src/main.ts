import * as Lark from "@larksuiteoapi/node-sdk";
import { randomBytes } from "node:crypto";
import { config, persistAllowedOpenId } from "./config";
import { askOpenCode, initOpenCodeServe, OpenCodeEvent, stopOpenCodeServe } from "./opencode";

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
    console.log(`[queue]: open_id=${openId} queued=${nextCount}`);
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

function cleanupExpiredPendingTokens(now: number): void {
  for (const [openId, pending] of pendingTokens.entries()) {
    if (pending.expiresAt <= now) {
      pendingTokens.delete(openId);
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

async function replyText(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
  if (replyToMessageId) {
    const result = await client.im.v1.message.reply({
      path: {
        message_id: replyToMessageId
      },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });

    return result.data?.message_id;
  }

  const result = await client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id"
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    }
  });

  return result.data?.message_id;
}

async function safeReplyText(
  chatId: string,
  text: string,
  replyToMessageId?: string,
  eventId?: string,
  openId?: string
): Promise<string | undefined> {
  try {
    const messageId = await replyText(chatId, text, replyToMessageId);
    return messageId;
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "unknown")
        : "unknown";
    console.error(
      `[feishu]: reply_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} code=${errorCode}`,
      error
    );
    return undefined;
  }
}

async function updateTextMessage(messageId: string, text: string): Promise<void> {
  await client.im.v1.message.update({
    path: {
      message_id: messageId
    },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text })
    }
  });
}

async function safeUpdateTextMessage(
  messageId: string,
  text: string,
  eventId?: string,
  openId?: string
): Promise<boolean> {
  try {
    await updateTextMessage(messageId, text);
    return true;
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "unknown")
        : "unknown";
    console.error(
      `[feishu]: reply_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} message_id=${messageId} code=${errorCode}`,
      error
    );
    return false;
  }
}

async function processUserMessage(params: {
  chatId: string;
  sourceMessageId?: string;
  senderOpenId: string;
  text: string;
  eventId?: string;
}): Promise<void> {
  const { chatId, sourceMessageId, senderOpenId, text, eventId } = params;

  if (text === RESET_COMMAND || text === NEW_COMMAND) {
    sessionByUser.delete(senderOpenId);
    await safeReplyText(chatId, "上下文已重置。接下来会开启新会话。", sourceMessageId, eventId, senderOpenId);
    return;
  }

  const previousSessionId = sessionByUser.get(senderOpenId);
  const STREAM_FLUSH_INTERVAL_MS = 1000;
  const STREAM_MIN_DELTA_CHARS = 20;

  type StepState = {
    messageId?: string;
    content: string;
    toolLogs: string[];
    lastPushedText: string;
    lastQueuedText: string;
    lastStreamSentAt: number;
  };

  const stepStates = new Map<string, StepState>();
  const stepStack: string[] = [];
  const finalizedStepKeys = new Set<string>();
  const finalizingStepKeys = new Set<string>();
  const stepPartIdToKey = new Map<string, string>();
  const stepMessageIdToKey = new Map<string, string>();
  let latestStepKey: string | undefined;
  let unnamedStepCounter = 0;
  let streamedConcreteOutput = false;
  let streamSendChain = Promise.resolve();

  const queueStreamOperation = (operation: () => Promise<void>): void => {
    streamSendChain = streamSendChain.then(async () => {
      await operation();
    });
  };

  const sendThinkingForStep = (stepKey: string): void => {
    const state = getOrCreateStepState(stepKey);

    queueStreamOperation(async () => {
      if (state.messageId) {
        return;
      }

      const thinkingMessageId = await safeReplyText(
        chatId,
        "Thinking...",
        sourceMessageId,
        eventId,
        senderOpenId
      );
      if (!thinkingMessageId) {
        return;
      }

      state.messageId = thinkingMessageId;
      state.lastPushedText = "Thinking...";
      state.lastQueuedText = "Thinking...";
      state.lastStreamSentAt = Date.now();
    });
  };

  const getOrCreateStepState = (stepKey: string): StepState => {
    const existing = stepStates.get(stepKey);
    if (existing) {
      return existing;
    }

    const created: StepState = {
      content: "",
      toolLogs: [],
      lastPushedText: "",
      lastQueuedText: "",
      lastStreamSentAt: 0
    };
    stepStates.set(stepKey, created);
    return created;
  };

  const pushStepContent = async (state: StepState, normalized: string): Promise<boolean> => {
    if (!state.messageId) {
      const createdMessageId = await safeReplyText(
        chatId,
        normalized,
        sourceMessageId,
        eventId,
        senderOpenId
      );

      if (!createdMessageId) {
        return false;
      }

      state.messageId = createdMessageId;
      return true;
    }

    return await safeUpdateTextMessage(
      state.messageId,
      normalized,
      eventId,
      senderOpenId
    );
  };

  const flushStep = (stepKey: string, force: boolean, finalize = false): void => {
    if (finalize && (finalizedStepKeys.has(stepKey) || finalizingStepKeys.has(stepKey))) {
      return;
    }

    const state = stepStates.get(stepKey);
    if (!state) {
      return;
    }

    const logReply = (messageId?: string): void => {
      if (!finalize || !messageId) {
        return;
      }

      console.log(
        `[feishu]: reply open_id=${senderOpenId} event_id=${eventId ?? "unknown"} step=${stepKey} message_id=${messageId}`
      );
    };

    const renderStepText = (): string => {
      const blocks: string[] = [];
      if (state.toolLogs.length > 0) {
        blocks.push("工具调用：");
        for (const item of state.toolLogs) {
          blocks.push(`- ${item}`);
        }
      }

      const contentText = state.content.trimEnd();
      if (contentText) {
        blocks.push(contentText);
      }

      return blocks.join("\n").trim();
    };

    const normalized = renderStepText();

    if (!normalized || normalized === "工具调用：") {
      if (finalize) {
        logReply(state.messageId);
        finalizedStepKeys.add(stepKey);
      }
      return;
    }

    const replacingThinking = state.lastPushedText === "Thinking...";

    if (!force && !replacingThinking && normalized.length - state.lastPushedText.length < STREAM_MIN_DELTA_CHARS) {
      return;
    }

    if (!force && !replacingThinking && Date.now() - state.lastStreamSentAt < STREAM_FLUSH_INTERVAL_MS) {
      return;
    }

    if (normalized === state.lastQueuedText) {
      if (finalize) {
        finalizingStepKeys.add(stepKey);
        queueStreamOperation(async () => {
          if (state.lastPushedText === normalized) {
            logReply(state.messageId);
            finalizedStepKeys.add(stepKey);
            finalizingStepKeys.delete(stepKey);
            return;
          }

          const pushed = await pushStepContent(state, normalized);

          if (pushed) {
            streamedConcreteOutput = true;
            state.lastPushedText = normalized;
            state.lastStreamSentAt = Date.now();
            logReply(state.messageId);
            finalizedStepKeys.add(stepKey);
            finalizingStepKeys.delete(stepKey);
          } else {
            state.lastQueuedText = state.lastPushedText;
            finalizingStepKeys.delete(stepKey);
          }
        });
      }
      return;
    }

    state.lastQueuedText = normalized;

    if (finalize) {
      finalizingStepKeys.add(stepKey);
    }

    queueStreamOperation(async () => {
      const pushed = await pushStepContent(state, normalized);

      if (pushed) {
        streamedConcreteOutput = true;
        state.lastPushedText = normalized;
        state.lastStreamSentAt = Date.now();

        if (finalize) {
          logReply(state.messageId);
          finalizedStepKeys.add(stepKey);
          finalizingStepKeys.delete(stepKey);
        }
      } else {
        state.lastQueuedText = state.lastPushedText;
        if (finalize) {
          finalizingStepKeys.delete(stepKey);
        }
      }
    });
  };

  const createAnonymousStepKey = (): string => {
    unnamedStepCounter += 1;
    return `step_${unnamedStepCounter}`;
  };

  const openStep = (event: OpenCodeEvent): string => {
    const messageId = event.part?.messageID;
    if (messageId && stepMessageIdToKey.has(messageId)) {
      return stepMessageIdToKey.get(messageId) as string;
    }

    const partId = event.part?.id;
    if (partId && stepPartIdToKey.has(partId)) {
      const existed = stepPartIdToKey.get(partId) as string;
      stepStack.push(existed);
      return existed;
    }

    const stepKey = createAnonymousStepKey();
    if (partId) {
      stepPartIdToKey.set(partId, stepKey);
    }
    if (messageId) {
      stepMessageIdToKey.set(messageId, stepKey);
    }
    stepStack.push(stepKey);
    return stepKey;
  };

  const currentStepKey = (event?: OpenCodeEvent): string => {
    const messageId = event?.part?.messageID;
    if (messageId && stepMessageIdToKey.has(messageId)) {
      return stepMessageIdToKey.get(messageId) as string;
    }

    return stepStack.length > 0 ? (stepStack[stepStack.length - 1] as string) : latestStepKey ?? "step_default";
  };

  const closeStep = (event: OpenCodeEvent): string | undefined => {
    const messageId = event.part?.messageID;
    if (messageId && stepMessageIdToKey.has(messageId)) {
      const stepKey = stepMessageIdToKey.get(messageId) as string;
      stepMessageIdToKey.delete(messageId);
      const index = stepStack.lastIndexOf(stepKey);
      if (index >= 0) {
        stepStack.splice(index, 1);
      }
      return stepKey;
    }

    const partId = event.part?.id;
    if (partId && stepPartIdToKey.has(partId)) {
      const stepKey = stepPartIdToKey.get(partId) as string;
      stepPartIdToKey.delete(partId);

      for (const [messageId, mappedStepKey] of stepMessageIdToKey.entries()) {
        if (mappedStepKey === stepKey) {
          stepMessageIdToKey.delete(messageId);
        }
      }

      const index = stepStack.lastIndexOf(stepKey);
      if (index >= 0) {
        stepStack.splice(index, 1);
      }
      return stepKey;
    }

    return stepStack.pop();
  };

  const onStreamEvent = (event: OpenCodeEvent): void => {
    if (event.type === "step_start") {
      const stepKey = openStep(event);
      latestStepKey = stepKey;
      getOrCreateStepState(stepKey);
      sendThinkingForStep(stepKey);
      return;
    }

    if (event.type === "text" && event.part?.text) {
      const stepKey = currentStepKey(event);
      latestStepKey = stepKey;
      const state = getOrCreateStepState(stepKey);
      state.content += event.part.text;
      flushStep(stepKey, false, false);
      return;
    }

    if (event.type === "tool_use") {
      const stepKey = currentStepKey(event);
      latestStepKey = stepKey;
      const state = getOrCreateStepState(stepKey);
      const toolName = event.part?.tool ?? "unknown";
      const status = event.part?.state?.status ?? "running";
      const description = event.part?.state?.input?.description;
      const text = description
        ? `${toolName} (${status}) - ${description}`
        : `${toolName} (${status})`;

      state.toolLogs.push(text);
      if (state.toolLogs.length > 6) {
        state.toolLogs = state.toolLogs.slice(-6);
      }

      flushStep(stepKey, true, false);
      return;
    }

    if (event.type === "step_finish") {
      const stepKey = closeStep(event) ?? latestStepKey;
      if (stepKey) {
        flushStep(stepKey, true, true);
      }
    }
  };

  try {
    console.log(
      `[opencode]: start open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${previousSessionId ?? "new"}`
    );
    const result = await askOpenCode({
      message: text,
      sessionId: previousSessionId,
      model: config.opencodeModel,
      timeoutMs: config.opencodeTimeoutMs,
      onEvent: onStreamEvent
    });

    sessionByUser.set(senderOpenId, result.sessionId);
    console.log(
      `[opencode]: success open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${result.sessionId}`
    );
    for (const stepKey of stepStates.keys()) {
      flushStep(stepKey, true, true);
    }

    await streamSendChain;

    if (!streamedConcreteOutput) {
      await safeReplyText(chatId, result.text, sourceMessageId, eventId, senderOpenId);
      return;
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error && error.message
        ? error.message
        : "调用 OpenCode 失败，请稍后重试。";
    console.error(`[opencode]: failed open_id=${senderOpenId}`, error);
    await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId);
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const eventId = data.event_id;
    const now = Date.now();
    cleanupHandledEvents(now);
    cleanupExpiredPendingTokens(now);

    if (eventId && handledEvents.has(eventId)) {
      console.log(`[feishu]: skip duplicated event_id=${eventId}`);
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

    const sourceMessageId = data.message?.message_id;

    const messageType = data.message?.message_type;
    if (messageType !== "text") {
      await safeReplyText(chatId, "当前仅支持文本消息。", sourceMessageId, eventId, senderOpenId);
      return;
    }

    const text = parseTextContent(data.message.content);
    console.log(
      `[feishu]: receive open_id=${senderOpenId} event_id=${eventId ?? "unknown"} message_type=${messageType} text=${JSON.stringify(text)}`
    );
    if (!text) {
      await safeReplyText(chatId, "消息内容为空或格式不支持。", sourceMessageId, eventId, senderOpenId);
      return;
    }

    if (!allowedOpenIds.has(senderOpenId)) {
      const pending = getOrCreatePendingToken(senderOpenId);

      if (text === pending.token) {
        pendingTokens.delete(senderOpenId);
        allowedOpenIds.add(senderOpenId);
        try {
          persistAllowedOpenId(senderOpenId);
          await safeReplyText(
            chatId,
            `鉴权成功，已将 open_id 加入 .env：${senderOpenId}`,
            sourceMessageId,
            eventId,
            senderOpenId
          );
        } catch (error) {
          await safeReplyText(
            chatId,
            `鉴权成功，但写入 .env 失败。你的 open_id：${senderOpenId}，请手动加入 ALLOWED_OPEN_ID。`,
            sourceMessageId,
            eventId,
            senderOpenId
          );
          console.error("写入 ALLOWED_OPEN_ID 失败:", error);
        }
        return;
      }

      const remainingSeconds = Math.max(1, Math.floor((pending.expiresAt - Date.now()) / 1000));
      console.log(
        `[feishu]: auth open_id=${senderOpenId} 临时token=${pending.token} 有效期=${remainingSeconds}s`
      );

      await safeReplyText(
        chatId,
        `当前用户未授权。你的 open_id：${senderOpenId}。\n请联系管理员查看服务日志中的临时 token，并在10分钟内回发该 token 完成验证。`,
        sourceMessageId,
        eventId,
        senderOpenId
      );
      return;
    }

    enqueueUserMessage(senderOpenId, async () => {
      await processUserMessage({ chatId, sourceMessageId, senderOpenId, text, eventId });
    });
  }
});

async function bootstrap(): Promise<void> {
  await initOpenCodeServe({
    hostname: config.opencodeServeHost,
    port: config.opencodeServePort,
    password: config.opencodeServerPassword
  });
  await wsClient.start({ eventDispatcher });
  console.log("飞书长连接已启动，等待消息...");
}

bootstrap().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    wsClient.close();
    await stopOpenCodeServe();
    process.exit(0);
  });
}
