import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { config } from "./config";
import {
  askOpenCode,
  getOpenCodeSessionByIdFromDb,
  getOpenCodeSessionLatestModel,
  initOpenCodeServe,
  isAbortError,
  listOpenCodeModels,
  listOpenCodeSessionsFromDb,
  OpenCodeEvent,
  stopOpenCodeServe
} from "./opencode";

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
const allowAllOpenIds = allowedOpenIds.size === 0;
const sessionByUser = new Map<string, string>();
const modelByUser = new Map<string, string>();
const workdirByUser = new Map<string, string>();
let isOpenCodeReady = false;
let opencodeReadyPromise: Promise<void> | undefined;
type UserQueueTask = (signal: AbortSignal) => Promise<void>;

type UserQueueItem = {
  sourceMessageId?: string;
  task: UserQueueTask;
  controller: AbortController;
};

type UserQueueState = {
  items: UserQueueItem[];
  isProcessing: boolean;
  activeItem?: UserQueueItem;
};

const userMessageQueues = new Map<string, UserQueueState>();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const RESET_COMMAND = "/reset";
const NEW_COMMAND = "/new";
const STOP_COMMAND = "/stop";
const RESUME_COMMAND = "/resume";
const MODELS_COMMAND = "/models";
const MODEL_COMMAND = "/model";

function getOrCreateQueueState(openId: string): UserQueueState {
  const existed = userMessageQueues.get(openId);
  if (existed) {
    return existed;
  }

  const created: UserQueueState = {
    items: [],
    isProcessing: false
  };
  userMessageQueues.set(openId, created);
  return created;
}

async function drainUserQueue(openId: string, state: UserQueueState): Promise<void> {
  if (state.isProcessing) {
    return;
  }

  state.isProcessing = true;

  while (state.items.length > 0) {
    const current = state.items.shift();
    if (!current) {
      break;
    }

    state.activeItem = current;

    try {
      if (!isOpenCodeReady && opencodeReadyPromise) {
        console.log(`[queue]: action=waiting_opencode open_id=${openId}`);
        await opencodeReadyPromise;
      }

      if (!current.controller.signal.aborted) {
        await current.task(current.controller.signal);
      }
    } catch (error) {
      if (isAbortError(error)) {
        console.log(
          `[queue]: action=skipped_aborted_task open_id=${openId} message_id=${current.sourceMessageId ?? "unknown"}`
        );
      } else {
        console.error(
          `[queue]: action=task_failed open_id=${openId} message_id=${current.sourceMessageId ?? "unknown"}`,
          error
        );
      }
    } finally {
      state.activeItem = undefined;
    }
  }

  state.isProcessing = false;

  if (state.items.length === 0 && !state.activeItem) {
    userMessageQueues.delete(openId);
  }
}

function enqueueUserMessage(openId: string, sourceMessageId: string | undefined, task: UserQueueTask): void {
  const state = getOrCreateQueueState(openId);
  state.items.push({
    sourceMessageId,
    task,
    controller: new AbortController()
  });

  const queueSize = state.items.length + (state.activeItem ? 1 : 0);
  if (queueSize > 1) {
    console.log(`[queue]: action=queued open_id=${openId} queued=${queueSize}`);
  }

  void drainUserQueue(openId, state);
}

function handleMessageRecalled(messageId: string): { aborted: number; removed: number } {
  let aborted = 0;
  let removed = 0;

  for (const [openId, state] of userMessageQueues.entries()) {
    if (state.activeItem?.sourceMessageId === messageId && !state.activeItem.controller.signal.aborted) {
      state.activeItem.controller.abort();
      aborted += 1;
    }

    const before = state.items.length;
    state.items = state.items.filter((item) => item.sourceMessageId !== messageId);
    const removedCount = before - state.items.length;
    if (removedCount > 0) {
      removed += removedCount;
      console.log(
        `[queue]: action=removed_pending open_id=${openId} message_id=${messageId} removed=${removedCount}`
      );
    }

    if (!state.isProcessing && state.items.length === 0 && !state.activeItem) {
      userMessageQueues.delete(openId);
    }
  }

  return { aborted, removed };
}

function stopUserQueue(openId: string): { aborted: boolean; removed: number } {
  const state = userMessageQueues.get(openId);
  if (!state) {
    return { aborted: false, removed: 0 };
  }

  const removed = state.items.length;
  state.items = [];

  let aborted = false;
  if (state.activeItem && !state.activeItem.controller.signal.aborted) {
    state.activeItem.controller.abort();
    aborted = true;
  }

  if (!state.isProcessing && !state.activeItem) {
    userMessageQueues.delete(openId);
  }

  return { aborted, removed };
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseResumeCommand(text: string): { isResume: boolean; sessionId?: string } {
  const trimmed = text.trim();
  const resumePattern = new RegExp(`^${escapeRegExp(RESUME_COMMAND)}(?:\\s+(.+))?$`);
  const matched = trimmed.match(resumePattern);
  if (!matched) {
    return { isResume: false };
  }

  const rawArg = matched[1]?.trim();
  if (!rawArg) {
    return { isResume: true };
  }

  return {
    isResume: true,
    sessionId: rawArg.split(/\s+/)[0]
  };
}

function isStopCommand(text: string): boolean {
  const stopPattern = new RegExp(`^${escapeRegExp(STOP_COMMAND)}(?:\\s+)?$`);
  return stopPattern.test(text.trim());
}

function parseNewCommand(text: string): { isNew: boolean; workdir?: string } {
  const trimmed = text.trim();
  const newPattern = new RegExp(`^${escapeRegExp(NEW_COMMAND)}(?:\\s+(.+))?$`);
  const matched = trimmed.match(newPattern);
  if (!matched) {
    return { isNew: false };
  }

  const rawArg = matched[1]?.trim();
  if (!rawArg) {
    return { isNew: true };
  }

  return {
    isNew: true,
    workdir: rawArg
  };
}

function getCurrentWorkdir(openId: string): string {
  return workdirByUser.get(openId) ?? config.opencodeWorkdir;
}

function normalizeWorkdirInput(input: string): string {
  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return resolve(homedir(), input.slice(2));
  }

  return input;
}

function resolveWorkdirInput(input: string, baseDirectory: string): { ok: true; workdir: string } | { ok: false; reason: string } {
  const normalized = normalizeWorkdirInput(input.trim());
  if (!normalized) {
    return { ok: false, reason: "目录不能为空。" };
  }

  const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(baseDirectory, normalized);
  if (!existsSync(candidate)) {
    return { ok: false, reason: `目录不存在：${candidate}` };
  }

  try {
    const stat = statSync(candidate);
    if (!stat.isDirectory()) {
      return { ok: false, reason: `不是目录：${candidate}` };
    }
  } catch {
    return { ok: false, reason: `无法访问目录：${candidate}` };
  }

  return { ok: true, workdir: candidate };
}

function validateExistingWorkdir(directory: string): { ok: true; workdir: string } | { ok: false; reason: string } {
  const workdir = directory.trim();
  if (!workdir) {
    return { ok: false, reason: "该会话未记录工作目录。" };
  }

  if (!existsSync(workdir)) {
    return { ok: false, reason: `会话工作目录不存在：${workdir}` };
  }

  try {
    const stat = statSync(workdir);
    if (!stat.isDirectory()) {
      return { ok: false, reason: `会话工作目录不是目录：${workdir}` };
    }
  } catch {
    return { ok: false, reason: `会话工作目录不可访问：${workdir}` };
  }

  return { ok: true, workdir };
}

function isModelsCommand(text: string): boolean {
  return /^\/models(?:\s+)?$/.test(text.trim());
}

function parseModelCommand(text: string): { isModel: boolean; model?: string } {
  const trimmed = text.trim();
  const modelPattern = new RegExp(`^${escapeRegExp(MODEL_COMMAND)}(?:\\s+(.+))?$`);
  const matched = trimmed.match(modelPattern);
  if (!matched) {
    return { isModel: false };
  }

  const rawArg = matched[1]?.trim();
  if (!rawArg) {
    return { isModel: true };
  }

  return {
    isModel: true,
    model: rawArg.split(/\s+/)[0]
  };
}

function splitLinesByLength(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = line;
      continue;
    }

    chunks.push(line);
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildMarkdownContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      title: "",
      content: [[{ tag: "md", text }]]
    }
  });
}

async function replyText(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
  const content = buildMarkdownContent(text);

  if (replyToMessageId) {
    const result = await client.im.v1.message.reply({
      path: {
        message_id: replyToMessageId
      },
      data: {
        msg_type: "post",
        content
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
      msg_type: "post",
      content
    }
  });

  return result.data?.message_id;
}

async function safeReplyText(
  chatId: string,
  text: string,
  replyToMessageId?: string,
  eventId?: string,
  openId?: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (signal?.aborted) {
    return undefined;
  }

  try {
    const messageId = await replyText(chatId, text, replyToMessageId);
    if (signal?.aborted) {
      return undefined;
    }
    return messageId;
  } catch (error) {
    if (signal?.aborted) {
      return undefined;
    }

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
  const content = buildMarkdownContent(text);

  await client.im.v1.message.update({
    path: {
      message_id: messageId
    },
    data: {
      msg_type: "post",
      content
    }
  });
}

async function safeUpdateTextMessage(
  messageId: string,
  text: string,
  eventId?: string,
  openId?: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  try {
    await updateTextMessage(messageId, text);
    if (signal?.aborted) {
      return false;
    }
    return true;
  } catch (error) {
    if (signal?.aborted) {
      return false;
    }

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
  signal?: AbortSignal;
}): Promise<void> {
  const { chatId, sourceMessageId, senderOpenId, text, eventId, signal } = params;

  if (signal?.aborted) {
    return;
  }

  const newCommand = parseNewCommand(text);

  if (text === RESET_COMMAND || newCommand.isNew) {
    if (text === RESET_COMMAND) {
      sessionByUser.delete(senderOpenId);
      modelByUser.delete(senderOpenId);
      workdirByUser.delete(senderOpenId);
      await safeReplyText(
        chatId,
        "上下文已重置。接下来会开启新会话（默认工作目录）。",
        sourceMessageId,
        eventId,
        senderOpenId,
        signal
      );
      return;
    }

    if (!newCommand.workdir) {
      sessionByUser.delete(senderOpenId);
      modelByUser.delete(senderOpenId);
      workdirByUser.delete(senderOpenId);
      await safeReplyText(
        chatId,
        `上下文已重置。接下来会开启新会话。\n工作目录：${config.opencodeWorkdir}`,
        sourceMessageId,
        eventId,
        senderOpenId,
        signal
      );
      return;
    }

    const baseDirectory = getCurrentWorkdir(senderOpenId);
    const resolvedWorkdir = resolveWorkdirInput(newCommand.workdir, baseDirectory);
    if (!resolvedWorkdir.ok) {
      await safeReplyText(
        chatId,
        `处理失败：${resolvedWorkdir.reason}\n使用方式：/new <工作目录>` ,
        sourceMessageId,
        eventId,
        senderOpenId,
        signal
      );
      return;
    }

    sessionByUser.delete(senderOpenId);
    modelByUser.delete(senderOpenId);
    workdirByUser.set(senderOpenId, resolvedWorkdir.workdir);
    await safeReplyText(
      chatId,
      `上下文已重置。接下来会开启新会话。\n工作目录：${resolvedWorkdir.workdir}`,
      sourceMessageId,
      eventId,
      senderOpenId,
      signal
    );
    return;
  }

  const modelCommand = parseModelCommand(text);
  if (modelCommand.isModel) {
    if (!modelCommand.model) {
      const selectedModel = modelByUser.get(senderOpenId) ?? config.opencodeModel;
      const currentSessionId = sessionByUser.get(senderOpenId);

      if (currentSessionId) {
        try {
          const latestModel = await getOpenCodeSessionLatestModel(currentSessionId);
          if (latestModel) {
            const selectedHint =
              selectedModel && selectedModel !== latestModel.id
                ? `\n当前已选择模型：${selectedModel}`
                : "";
            await safeReplyText(
              chatId,
              `当前会话最近使用模型：${latestModel.id}${selectedHint}`,
              sourceMessageId,
              eventId,
              senderOpenId,
              signal
            );
            return;
          }
        } catch (error) {
          console.warn(
            `[opencode]: fetch_session_model_failed open_id=${senderOpenId} session=${currentSessionId}`,
            error
          );
        }
      }

      if (selectedModel) {
        await safeReplyText(
          chatId,
          `当前已选择模型：${selectedModel}`,
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
        return;
      }

      await safeReplyText(
        chatId,
        "当前未指定模型（使用 OpenCode 默认模型）。",
        sourceMessageId,
        eventId,
        senderOpenId,
        signal
      );
      return;
    }

    modelByUser.set(senderOpenId, modelCommand.model);
    await safeReplyText(
      chatId,
      `已切换当前会话模型：${modelCommand.model}`,
      sourceMessageId,
      eventId,
      senderOpenId,
      signal
    );
    return;
  }

  const resume = parseResumeCommand(text);
  if (resume.isResume) {
    try {
      const sessions = await listOpenCodeSessionsFromDb(30);

      if (!resume.sessionId) {
        if (sessions.length === 0) {
          await safeReplyText(chatId, "当前没有可用的 OpenCode session。", sourceMessageId, eventId, senderOpenId, signal);
          return;
        }

        const lines = sessions.map((session, index) => {
          const title = session.title?.trim() ? session.title.trim() : "(无标题)";
          const updatedAt = session.updated ? new Date(session.updated).toLocaleString("zh-CN", { hour12: false }) : "unknown";
          const directory = session.directory?.trim() || "unknown";
          return `${String(index + 1)}. ${session.id} | ${title} | ${updatedAt} | ${directory}`;
        });

        await safeReplyText(
          chatId,
          `可用 session（最近 ${String(sessions.length)} 条）：\n${lines.join("\n")}\n\n使用方式：/resume <编号|session_id>`,
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
        return;
      }

      const resumeKey = resume.sessionId.trim();
      const indexMatch = /^\d+$/.test(resumeKey) ? Number(resumeKey) : NaN;
      const targetByIndex = Number.isInteger(indexMatch) && indexMatch >= 1 ? sessions[indexMatch - 1] : undefined;
      const target = targetByIndex ?? sessions.find((session) => session.id === resumeKey) ?? (await getOpenCodeSessionByIdFromDb(resumeKey));
      if (!target) {
        await safeReplyText(
          chatId,
          `未找到 session: ${resume.sessionId}\n请先发送 /resume 查看可用会话。`,
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
        return;
      }

      const workdirCheck = validateExistingWorkdir(target.directory ?? "");
      if (!workdirCheck.ok) {
        await safeReplyText(
          chatId,
          `恢复失败：${workdirCheck.reason}\n未执行会话切换，请先处理目录问题后再重试。`,
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
        return;
      }

      sessionByUser.set(senderOpenId, target.id);
      workdirByUser.set(senderOpenId, workdirCheck.workdir);
      const title = target.title?.trim() ? target.title.trim() : "(无标题)";
      await safeReplyText(
        chatId,
        `已恢复 session: ${target.id}\n标题：${title}\n工作目录：${workdirCheck.workdir}`,
        sourceMessageId,
        eventId,
        senderOpenId,
        signal
      );
      return;
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message ? error.message : "查询 session 失败，请稍后再试。";
      await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
      return;
    }
  }

  if (isModelsCommand(text)) {
    try {
      const models = await listOpenCodeModels();
      if (models.length === 0) {
        await safeReplyText(
          chatId,
          "当前没有可用模型（可能尚未配置任何 provider 凭证）。",
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
        return;
      }

      const lines = models.map((model, index) => `${String(index + 1)}. ${model.id}`);
      const chunks = splitLinesByLength(lines, 2800);

      for (let i = 0; i < chunks.length; i += 1) {
        if (signal?.aborted) {
          return;
        }

        const title =
          chunks.length === 1
            ? `可用模型（共 ${String(models.length)} 个）：`
            : `可用模型（共 ${String(models.length)} 个，第 ${String(i + 1)}/${String(chunks.length)} 条）：`;
        await safeReplyText(
          chatId,
          `${title}\n${chunks[i] as string}`,
          sourceMessageId,
          eventId,
          senderOpenId,
          signal
        );
      }
      return;
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message ? error.message : "查询模型失败，请稍后再试。";
      await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
      return;
    }
  }

  const previousSessionId = sessionByUser.get(senderOpenId);
  const currentWorkdir = getCurrentWorkdir(senderOpenId);
  const currentModel = modelByUser.get(senderOpenId) ?? config.opencodeModel;
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
    if (signal?.aborted) {
      return;
    }

    streamSendChain = streamSendChain.then(async () => {
      if (signal?.aborted) {
        return;
      }
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
        senderOpenId,
        signal
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
        senderOpenId,
        signal
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
      senderOpenId,
      signal
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
    if (signal?.aborted) {
      return;
    }

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
      `[opencode]: start open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${previousSessionId ?? "new"} workdir=${currentWorkdir}`
    );
    const result = await askOpenCode({
      message: text,
      sessionId: previousSessionId,
      model: currentModel,
      workdir: currentWorkdir,
      timeoutMs: config.opencodeTimeoutMs,
      onEvent: onStreamEvent,
      signal
    });

    if (signal?.aborted) {
      return;
    }

    sessionByUser.set(senderOpenId, result.sessionId);
    console.log(
      `[opencode]: success open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${result.sessionId}`
    );
    for (const stepKey of stepStates.keys()) {
      flushStep(stepKey, true, true);
    }

    await streamSendChain;

    if (!streamedConcreteOutput) {
      if (signal?.aborted) {
        return;
      }
      await safeReplyText(chatId, result.text, sourceMessageId, eventId, senderOpenId, signal);
      return;
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      console.log(
        `[opencode]: aborted open_id=${senderOpenId} event_id=${eventId ?? "unknown"} message_id=${sourceMessageId ?? "unknown"}`
      );
      return;
    }

    const errorMessage =
      error instanceof Error && error.message
        ? error.message
        : "调用 OpenCode 失败，请稍后重试。";
    console.error(`[opencode]: failed open_id=${senderOpenId}`, error);
    await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.recalled_v1": async (data) => {
    const eventId = data.event_id;
    const now = Date.now();
    cleanupHandledEvents(now);

    if (eventId && handledEvents.has(eventId)) {
      console.log(`[feishu]: skip duplicated event_id=${eventId}`);
      return;
    }

    if (eventId) {
      handledEvents.set(eventId, now);
    }

    const messageId = data.message_id;
    if (!messageId) {
      return;
    }

    const result = handleMessageRecalled(messageId);
    console.log(
      `[feishu]: recalled event_id=${eventId ?? "unknown"} message_id=${messageId} aborted=${result.aborted} removed=${result.removed}`
    );
  },
  "im.message.receive_v1": async (data) => {
    const eventId = data.event_id;
    const now = Date.now();
    cleanupHandledEvents(now);

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

    if (!allowAllOpenIds && !allowedOpenIds.has(senderOpenId)) {
      await safeReplyText(
        chatId,
        `当前用户未授权。你的 open_id：${senderOpenId}。请联系管理员将该 open_id 加入 allowedOpenId。`,
        sourceMessageId,
        eventId,
        senderOpenId
      );
      return;
    }

    if (isStopCommand(text)) {
      const result = stopUserQueue(senderOpenId);
      const detail = result.aborted
        ? `已停止当前任务，并清空队列 ${String(result.removed)} 条待处理消息。`
        : result.removed > 0
          ? `当前没有运行中的任务，已清空队列 ${String(result.removed)} 条待处理消息。`
          : "当前没有运行中的任务，队列也为空。";

      await safeReplyText(chatId, detail, sourceMessageId, eventId, senderOpenId);
      return;
    }

    enqueueUserMessage(senderOpenId, sourceMessageId, async (signal) => {
      await processUserMessage({ chatId, sourceMessageId, senderOpenId, text, eventId, signal });
    });
  }
});

async function bootstrap(): Promise<void> {
  await wsClient.start({ eventDispatcher });
  console.log("[bootstrap]: 飞书长连接已启动，等待消息...");

  opencodeReadyPromise = initOpenCodeServe({
    hostname: config.opencodeServeHost,
    port: config.opencodeServePort
  });
  await opencodeReadyPromise;
  isOpenCodeReady = true;

  console.log("[bootstrap]: OpenCode 已就绪，开始处理队列与新消息...");
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
