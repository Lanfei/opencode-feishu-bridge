import * as Lark from "@larksuiteoapi/node-sdk";
import { ConversationStreamEvent } from "./contracts";
import { errorf, LOG_SCOPES } from "./logger";

const THINKING_TEXT = "Thinking...";
const STREAM_FLUSH_INTERVAL_MS = 1000;
const STREAM_MIN_DELTA_CHARS = 20;

export type FeishuMessageReceivedEvent = {
  event_id?: string;
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
    };
  };
  message?: {
    chat_id?: string;
    message_id?: string;
    message_type?: string;
    content: string;
  };
};

export type FeishuMessageRecalledEvent = {
  event_id?: string;
  message_id?: string;
};

type ReplyTextParams = {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  eventId?: string;
  openId?: string;
  signal?: AbortSignal;
  ignoreAbort?: boolean;
};

type UpdateTextMessageParams = {
  messageId: string;
  text: string;
  eventId?: string;
  openId?: string;
  signal?: AbortSignal;
  ignoreAbort?: boolean;
};

type CreateFeishuParams = {
  appId: string;
  appSecret: string;
};

type CreateStreamParams = {
  chatId: string;
  sourceMessageId?: string;
  eventId?: string;
  openId?: string;
  signal?: AbortSignal;
};

type FeishuHandlers = {
  onMessageReceived: (data: FeishuMessageReceivedEvent) => Promise<void>;
  onMessageRecalled: (data: FeishuMessageRecalledEvent) => Promise<void>;
};

type StepState = {
  messageId?: string;
  content: string;
  toolLogs: string[];
  lastPushedText: string;
  lastQueuedText: string;
  lastStreamSentAt: number;
  phase: "thinking" | "streaming" | "final";
};

export type FeishuStream = {
  onEvent(event: ConversationStreamEvent): void;
  flush(): Promise<void>;
  abort(): Promise<void>;
};

export type FeishuClient = {
  parseTextContent(content: string): string;
  safeReplyText(params: ReplyTextParams): Promise<string | undefined>;
  safeUpdateTextMessage(params: UpdateTextMessageParams): Promise<boolean>;
  createStream(params: CreateStreamParams): FeishuStream;
  createEventDispatcher(handlers: FeishuHandlers): Lark.EventDispatcher;
  start(params: { eventDispatcher: Lark.EventDispatcher }): Promise<void>;
  close(): void;
};

export function createFeishu(params: CreateFeishuParams): FeishuClient {
  const client = new Lark.Client({
    appId: params.appId,
    appSecret: params.appSecret
  });

  const wsClient = new Lark.WSClient({
    appId: params.appId,
    appSecret: params.appSecret,
    autoReconnect: true,
    loggerLevel: Lark.LoggerLevel.info
  });

  function parseTextContent(content: string): string {
    try {
      const payload = JSON.parse(content) as { text?: string };
      return payload.text?.trim() ?? "";
    } catch {
      return "";
    }
  }

  function buildMarkdownContent(text: string): string {
    return JSON.stringify({
      zh_cn: {
        title: "",
        content: [[{ tag: "md", text }]]
      }
    });
  }

  async function replyText(params: ReplyTextParams): Promise<string | undefined> {
    const content = buildMarkdownContent(params.text);

    if (params.replyToMessageId) {
      const result = await client.im.v1.message.reply({
        path: {
          message_id: params.replyToMessageId
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
        receive_id: params.chatId,
        msg_type: "post",
        content
      }
    });

    return result.data?.message_id;
  }

  async function safeReplyText(params: ReplyTextParams): Promise<string | undefined> {
    if (params.signal?.aborted && !params.ignoreAbort) {
      return undefined;
    }

    try {
      const messageId = await replyText(params);
      if (params.signal?.aborted && !params.ignoreAbort) {
        return undefined;
      }
      return messageId;
    } catch (error) {
      if (params.signal?.aborted && !params.ignoreAbort) {
        return undefined;
      }

      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "unknown")
          : "unknown";
      errorf(
        LOG_SCOPES.feishu,
        "reply_failed",
        {
          open_id: params.openId ?? "unknown",
          event_id: params.eventId ?? "unknown",
          code: errorCode
        },
        error
      );
      return undefined;
    }
  }

  async function updateTextMessage(params: UpdateTextMessageParams): Promise<void> {
    const content = buildMarkdownContent(params.text);

    await client.im.v1.message.update({
      path: {
        message_id: params.messageId
      },
      data: {
        msg_type: "post",
        content
      }
    });
  }

  async function safeUpdateTextMessage(params: UpdateTextMessageParams): Promise<boolean> {
    if (params.signal?.aborted && !params.ignoreAbort) {
      return false;
    }

    try {
      await updateTextMessage(params);
      if (params.signal?.aborted && !params.ignoreAbort) {
        return false;
      }
      return true;
    } catch (error) {
      if (params.signal?.aborted && !params.ignoreAbort) {
        return false;
      }

      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "unknown")
          : "unknown";
      errorf(
        LOG_SCOPES.feishu,
        "update_failed",
        {
          open_id: params.openId ?? "unknown",
          event_id: params.eventId ?? "unknown",
          message_id: params.messageId,
          code: errorCode
        },
        error
      );
      return false;
    }
  }

  function createStream(params: CreateStreamParams): FeishuStream {
    const stepStates = new Map<string, StepState>();
    const finalizedStepKeys = new Set<string>();
    const finalizingStepKeys = new Set<string>();
    let streamedConcreteOutput = false;
    let completedText: string | undefined;
    let streamSendChain = Promise.resolve();
    let abortHandled = false;

    const queueStreamOperation = (operation: () => Promise<void>): void => {
      if (params.signal?.aborted) {
        return;
      }

      streamSendChain = streamSendChain.then(async () => {
        if (params.signal?.aborted) {
          return;
        }

        await operation();
      });
    };

    const getOrCreateStepState = (stepId: string): StepState => {
      const existing = stepStates.get(stepId);
      if (existing) {
        return existing;
      }

      const created: StepState = {
        content: "",
        toolLogs: [],
        lastPushedText: "",
        lastQueuedText: "",
        lastStreamSentAt: 0,
        phase: "thinking"
      };
      stepStates.set(stepId, created);
      return created;
    };

    const renderStepText = (state: StepState): string => {
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

    const pushStepContent = async (state: StepState, normalized: string): Promise<boolean> => {
      if (!state.messageId) {
        const createdMessageId = await safeReplyText({
          chatId: params.chatId,
          text: normalized,
          replyToMessageId: params.sourceMessageId,
          eventId: params.eventId,
          openId: params.openId,
          signal: params.signal
        });

        if (!createdMessageId) {
          return false;
        }

        state.messageId = createdMessageId;
        return true;
      }

      return await safeUpdateTextMessage({
        messageId: state.messageId,
        text: normalized,
        eventId: params.eventId,
        openId: params.openId,
        signal: params.signal
      });
    };

    const flushStep = (stepId: string, force: boolean, finalize = false): void => {
      if (finalize && (finalizedStepKeys.has(stepId) || finalizingStepKeys.has(stepId))) {
        return;
      }

      const state = stepStates.get(stepId);
      if (!state) {
        return;
      }

      const normalized = renderStepText(state);
      if (!normalized || normalized === "工具调用：") {
        if (finalize) {
          finalizedStepKeys.add(stepId);
        }
        return;
      }

      const replacingThinking = state.phase === "thinking";

      if (!force && !replacingThinking && normalized.length - state.lastPushedText.length < STREAM_MIN_DELTA_CHARS) {
        return;
      }

      if (!force && !replacingThinking && Date.now() - state.lastStreamSentAt < STREAM_FLUSH_INTERVAL_MS) {
        return;
      }

      if (normalized === state.lastQueuedText) {
        if (finalize) {
          finalizingStepKeys.add(stepId);
          queueStreamOperation(async () => {
            if (state.lastPushedText === normalized) {
              state.phase = "final";
              finalizedStepKeys.add(stepId);
              finalizingStepKeys.delete(stepId);
              return;
            }

            const pushed = await pushStepContent(state, normalized);
            if (pushed) {
              streamedConcreteOutput = true;
              state.lastPushedText = normalized;
              state.lastStreamSentAt = Date.now();
              state.phase = "final";
              finalizedStepKeys.add(stepId);
              finalizingStepKeys.delete(stepId);
            } else {
              state.lastQueuedText = state.lastPushedText;
              finalizingStepKeys.delete(stepId);
            }
          });
        }
        return;
      }

      state.lastQueuedText = normalized;
      if (finalize) {
        finalizingStepKeys.add(stepId);
      }

      queueStreamOperation(async () => {
        const pushed = await pushStepContent(state, normalized);
        if (pushed) {
          streamedConcreteOutput = true;
          state.lastPushedText = normalized;
          state.lastStreamSentAt = Date.now();
          state.phase = finalize ? "final" : "streaming";
          if (finalize) {
            finalizedStepKeys.add(stepId);
            finalizingStepKeys.delete(stepId);
          }
        } else {
          state.lastQueuedText = state.lastPushedText;
          if (finalize) {
            finalizingStepKeys.delete(stepId);
          }
        }
      });
    };

    const sendThinkingForStep = (stepId: string): void => {
      const state = getOrCreateStepState(stepId);

      queueStreamOperation(async () => {
        if (state.messageId) {
          return;
        }

        const thinkingMessageId = await safeReplyText({
          chatId: params.chatId,
          text: THINKING_TEXT,
          replyToMessageId: params.sourceMessageId,
          eventId: params.eventId,
          openId: params.openId,
          signal: params.signal
        });
        if (!thinkingMessageId) {
          return;
        }

        state.messageId = thinkingMessageId;
        state.lastPushedText = THINKING_TEXT;
        state.lastQueuedText = THINKING_TEXT;
        state.lastStreamSentAt = Date.now();
        state.phase = "thinking";
      });
    };

    function onEvent(event: ConversationStreamEvent): void {
      if (params.signal?.aborted) {
        return;
      }

      if (event.type === "step_started") {
        getOrCreateStepState(event.stepId);
        sendThinkingForStep(event.stepId);
        return;
      }

      if (event.type === "step_text") {
        const state = getOrCreateStepState(event.stepId);
        state.content += event.text;
        flushStep(event.stepId, false, false);
        return;
      }

      if (event.type === "step_tool") {
        const state = getOrCreateStepState(event.stepId);
        state.toolLogs.push(event.text);
        if (state.toolLogs.length > 6) {
          state.toolLogs = state.toolLogs.slice(-6);
        }
        flushStep(event.stepId, true, false);
        return;
      }

      if (event.type === "step_finished") {
        flushStep(event.stepId, true, true);
        return;
      }

      completedText = event.text;
    }

    async function flush(): Promise<void> {
      for (const stepId of stepStates.keys()) {
        flushStep(stepId, true, true);
      }

      await streamSendChain;

      if (!streamedConcreteOutput && completedText && !params.signal?.aborted) {
        await safeReplyText({
          chatId: params.chatId,
          text: completedText,
          replyToMessageId: params.sourceMessageId,
          eventId: params.eventId,
          openId: params.openId,
          signal: params.signal
        });
      }
    }

    async function abort(): Promise<void> {
      if (abortHandled) {
        await streamSendChain;
        return;
      }

      abortHandled = true;
      await streamSendChain;

      for (const state of stepStates.values()) {
        if (!state.messageId) {
          continue;
        }

        const rendered = renderStepText(state);
        const stoppedText = !rendered || state.phase === "thinking" ? "已停止。" : `${rendered}\n\n已停止。`;
        if (state.lastPushedText === stoppedText) {
          continue;
        }

        const updated = await safeUpdateTextMessage({
          messageId: state.messageId,
          text: stoppedText,
          eventId: params.eventId,
          openId: params.openId,
          signal: params.signal,
          ignoreAbort: true
        });

        if (updated) {
          state.lastPushedText = stoppedText;
          state.lastQueuedText = stoppedText;
          state.phase = "final";
        }
      }
    }

    return {
      onEvent,
      flush,
      abort
    };
  }

  function createEventDispatcher(handlers: FeishuHandlers): Lark.EventDispatcher {
    return new Lark.EventDispatcher({}).register({
      "im.message.recalled_v1": handlers.onMessageRecalled,
      "im.message.receive_v1": handlers.onMessageReceived
    });
  }

  async function start(params: { eventDispatcher: Lark.EventDispatcher }): Promise<void> {
    await wsClient.start({ eventDispatcher: params.eventDispatcher });
  }

  function close(): void {
    wsClient.close();
  }

  return {
    parseTextContent,
    safeReplyText,
    safeUpdateTextMessage,
    createStream,
    createEventDispatcher,
    start,
    close
  };
}
