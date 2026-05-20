import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { ConversationStreamEvent, OpenCodeRawEvent, UserMessage } from "./contracts";
import { FeishuClient } from "./feishu";
import { errorf, LOG_SCOPES, logf, warnf } from "./logger";
import { OpenCodeClient } from "./opencode";

const RESET_COMMAND = "/reset";
const NEW_COMMAND = "/new";
const SESSION_COMMAND = "/session";
const MODELS_COMMAND = "/models";
const MODEL_COMMAND = "/model";

type CreateOrchestratorParams = {
  opencode: OpenCodeClient;
  defaultModel?: string;
  defaultWorkdir: string;
  replyText: FeishuClient["safeReplyText"];
  createStream: FeishuClient["createStream"];
};

export type Orchestrator = {
  handleMessage(params: UserMessage & { signal?: AbortSignal }): Promise<void>;
};

export function createOrchestrator(params: CreateOrchestratorParams): Orchestrator {
  const sessionByChat = new Map<string, string>();
  const modelByChat = new Map<string, string>();
  const workdirByChat = new Map<string, string>();

  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseResumeCommand(text: string): { isResume: boolean; sessionId?: string } {
    const trimmed = text.trim();
    const resumePattern = new RegExp(`^${escapeRegExp(SESSION_COMMAND)}(?:\\s+(.+))?$`);
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

  function getCurrentWorkdir(chatId: string): string {
    return workdirByChat.get(chatId) ?? params.defaultWorkdir;
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

  function createStreamEventTranslator(): { translate(event: OpenCodeRawEvent): ConversationStreamEvent[] } {
    function createStepTracker(): {
      open(event?: OpenCodeRawEvent): string;
      ensure(event?: OpenCodeRawEvent): { stepId: string; opened: boolean };
      finish(event?: OpenCodeRawEvent): string | undefined;
    } {
      const activeStepStack: string[] = [];
      const stepByPartId = new Map<string, string>();
      const stepByMessageId = new Map<string, string>();
      let anonymousStepCounter = 0;

      const createAnonymousStepId = (): string => {
        anonymousStepCounter += 1;
        return `step_${anonymousStepCounter}`;
      };

      const mapEventToStep = (event: OpenCodeRawEvent | undefined, stepId: string): void => {
        const partId = event?.part?.id;
        const messageId = event?.part?.messageID;

        if (partId) {
          stepByPartId.set(partId, stepId);
        }
        if (messageId) {
          stepByMessageId.set(messageId, stepId);
        }
      };

      const resolveMappedStep = (event?: OpenCodeRawEvent): string | undefined => {
        const messageId = event?.part?.messageID;
        if (messageId && stepByMessageId.has(messageId)) {
          return stepByMessageId.get(messageId);
        }

        const partId = event?.part?.id;
        if (partId && stepByPartId.has(partId)) {
          return stepByPartId.get(partId);
        }

        return undefined;
      };

      const removeStep = (stepId: string): void => {
        const stackIndex = activeStepStack.lastIndexOf(stepId);
        if (stackIndex >= 0) {
          activeStepStack.splice(stackIndex, 1);
        }

        for (const [partId, mappedStepId] of stepByPartId.entries()) {
          if (mappedStepId === stepId) {
            stepByPartId.delete(partId);
          }
        }

        for (const [messageId, mappedStepId] of stepByMessageId.entries()) {
          if (mappedStepId === stepId) {
            stepByMessageId.delete(messageId);
          }
        }
      };

      const open = (event?: OpenCodeRawEvent): string => {
        const existingStepId = resolveMappedStep(event);
        if (existingStepId) {
          if (activeStepStack[activeStepStack.length - 1] !== existingStepId) {
            activeStepStack.push(existingStepId);
          }
          return existingStepId;
        }

        const stepId = createAnonymousStepId();
        mapEventToStep(event, stepId);
        activeStepStack.push(stepId);
        return stepId;
      };

      const ensure = (event?: OpenCodeRawEvent): { stepId: string; opened: boolean } => {
        const mappedStepId = resolveMappedStep(event);
        if (mappedStepId) {
          return { stepId: mappedStepId, opened: false };
        }

        const currentStepId = activeStepStack[activeStepStack.length - 1];
        if (currentStepId) {
          mapEventToStep(event, currentStepId);
          return { stepId: currentStepId, opened: false };
        }

        const stepId = open(event);
        return { stepId, opened: true };
      };

      const finish = (event?: OpenCodeRawEvent): string | undefined => {
        const resolvedStepId = resolveMappedStep(event) ?? activeStepStack[activeStepStack.length - 1];
        if (!resolvedStepId) {
          return undefined;
        }

        removeStep(resolvedStepId);
        return resolvedStepId;
      };

      return {
        open,
        ensure,
        finish
      };
    }

    const tracker = createStepTracker();

    return {
      translate(event: OpenCodeRawEvent): ConversationStreamEvent[] {
        if (event.type === "step_start") {
          const stepId = tracker.open(event);
          return [{ type: "step_started", stepId }];
        }

        if (event.type === "text" && event.part?.text) {
          const { stepId, opened } = tracker.ensure(event);
          return [
            ...(opened ? [{ type: "step_started", stepId } as const] : []),
            { type: "step_text", stepId, text: event.part.text }
          ];
        }

        if (event.type === "tool_use") {
          const { stepId, opened } = tracker.ensure(event);
          const toolName = event.part?.tool ?? "unknown";
          const status = event.part?.state?.status ?? "running";
          const description = event.part?.state?.input?.description;
          const text = description ? `${toolName} (${status}) - ${description}` : `${toolName} (${status})`;
          return [
            ...(opened ? [{ type: "step_started", stepId } as const] : []),
            { type: "step_tool", stepId, text }
          ];
        }

        if (event.type === "step_finish") {
          const stepId = tracker.finish(event);
          if (!stepId) {
            return [];
          }

          return [{ type: "step_finished", stepId }];
        }

        return [];
      }
    };
  }

  async function handleMessage(message: UserMessage & { signal?: AbortSignal }): Promise<void> {
    const { chatId, sourceMessageId, openId, text, eventId, signal } = message;

    if (signal?.aborted) {
      return;
    }

    const newCommand = parseNewCommand(text);
    if (text === RESET_COMMAND || newCommand.isNew) {
      if (text === RESET_COMMAND) {
        sessionByChat.delete(chatId);
        modelByChat.delete(chatId);
        workdirByChat.delete(chatId);
        await params.replyText({
          chatId,
          text: "上下文已重置。接下来会开启新会话（默认工作目录）。",
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }

      if (!newCommand.workdir) {
        sessionByChat.delete(chatId);
        modelByChat.delete(chatId);
        workdirByChat.delete(chatId);
        await params.replyText({
          chatId,
          text: `上下文已重置。接下来会开启新会话。\n工作目录：${params.defaultWorkdir}`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }

      const baseDirectory = getCurrentWorkdir(chatId);
      const resolvedWorkdir = resolveWorkdirInput(newCommand.workdir, baseDirectory);
      if (!resolvedWorkdir.ok) {
        await params.replyText({
          chatId,
          text: `处理失败：${resolvedWorkdir.reason}\n使用方式：/new <工作目录>`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }

      sessionByChat.delete(chatId);
      modelByChat.delete(chatId);
      workdirByChat.set(chatId, resolvedWorkdir.workdir);
      await params.replyText({
        chatId,
        text: `上下文已重置。接下来会开启新会话。\n工作目录：${resolvedWorkdir.workdir}`,
        replyToMessageId: sourceMessageId,
        eventId,
        openId,
        signal
      });
      return;
    }

    const modelCommand = parseModelCommand(text);
    if (modelCommand.isModel) {
      if (!modelCommand.model) {
        const selectedModel = modelByChat.get(chatId) ?? params.defaultModel;
        const currentSessionId = sessionByChat.get(chatId);

        if (currentSessionId) {
          try {
            const latestModel = await params.opencode.getSessionLatestModel(currentSessionId);
            if (latestModel) {
              const selectedHint =
                selectedModel && selectedModel !== latestModel.id ? `\n当前已选择模型：${selectedModel}` : "";
              await params.replyText({
                chatId,
                text: `当前聊天最近使用模型：${latestModel.id}${selectedHint}`,
                replyToMessageId: sourceMessageId,
                eventId,
                openId,
                signal
              });
              return;
            }
          } catch (error) {
            warnf(
              LOG_SCOPES.conversation,
              "fetch_session_model_failed",
              {
                chat_id: chatId,
                open_id: openId,
                session: currentSessionId
              },
              error
            );
          }
        }

        if (selectedModel) {
          await params.replyText({
            chatId,
            text: `当前聊天已选择模型：${selectedModel}`,
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
          return;
        }

        await params.replyText({
          chatId,
          text: "当前聊天未指定模型（使用 OpenCode 默认模型）。",
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }

      modelByChat.set(chatId, modelCommand.model);
      await params.replyText({
        chatId,
        text: `已切换当前聊天模型：${modelCommand.model}`,
        replyToMessageId: sourceMessageId,
        eventId,
        openId,
        signal
      });
      return;
    }

    const resume = parseResumeCommand(text);
    if (resume.isResume) {
      try {
        const sessions = await params.opencode.listSessions(30);

        if (!resume.sessionId) {
          if (sessions.length === 0) {
            await params.replyText({
              chatId,
              text: "当前没有可用的 OpenCode session。",
              replyToMessageId: sourceMessageId,
              eventId,
              openId,
              signal
            });
            return;
          }

          const lines = sessions.map((session, index) => {
            const title = session.title?.trim() ? session.title.trim() : "(无标题)";
            const updatedAt = session.updated ? new Date(session.updated).toLocaleString("zh-CN", { hour12: false }) : "unknown";
            return `${String(index + 1)}. ${session.id} | ${title} | ${updatedAt}`;
          });

          await params.replyText({
            chatId,
            text: `可用 session（最近 ${String(sessions.length)} 条）：\n${lines.join("\n")}\n\n使用方式：/session <编号|session_id>`,
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
          return;
        }

        const resumeKey = resume.sessionId.trim();
        const indexMatch = /^\d+$/.test(resumeKey) ? Number(resumeKey) : NaN;
        const targetByIndex = Number.isInteger(indexMatch) && indexMatch >= 1 ? sessions[indexMatch - 1] : undefined;
        const target = targetByIndex ?? sessions.find((session) => session.id === resumeKey) ?? (await params.opencode.getSessionById(resumeKey));
        if (!target) {
          await params.replyText({
            chatId,
            text: `未找到 session: ${resume.sessionId}\n请先发送 /session 查看可用会话。`,
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
          return;
        }

        const workdirCheck = validateExistingWorkdir(target.directory ?? "");
        if (!workdirCheck.ok) {
          await params.replyText({
            chatId,
            text: `恢复失败：${workdirCheck.reason}\n未执行会话切换，请先处理目录问题后再重试。`,
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
          return;
        }

        sessionByChat.set(chatId, target.id);
        modelByChat.delete(chatId);
        workdirByChat.set(chatId, workdirCheck.workdir);
        const title = target.title?.trim() ? target.title.trim() : "(无标题)";
        await params.replyText({
          chatId,
          text: `已恢复 session: ${target.id}\n标题：${title}`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      } catch (error) {
        const errorMessage = error instanceof Error && error.message ? error.message : "查询 session 失败，请稍后再试。";
        await params.replyText({
          chatId,
          text: `处理失败：${errorMessage}`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }
    }

    if (isModelsCommand(text)) {
      try {
        const models = await params.opencode.listModels();
        if (models.length === 0) {
          await params.replyText({
            chatId,
            text: "当前没有可用模型（可能尚未配置任何 provider 凭证）。",
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
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
              : `可用模型（共 ${String(models.length)} 个，第 ${String(i + 1)}/${String(chunks.length)} 页）：`;
          await params.replyText({
            chatId,
            text: `${title}\n${chunks[i] as string}`,
            replyToMessageId: sourceMessageId,
            eventId,
            openId,
            signal
          });
        }
        return;
      } catch (error) {
        const errorMessage = error instanceof Error && error.message ? error.message : "查询模型失败，请稍后再试。";
        await params.replyText({
          chatId,
          text: `处理失败：${errorMessage}`,
          replyToMessageId: sourceMessageId,
          eventId,
          openId,
          signal
        });
        return;
      }
    }

    const previousSessionId = sessionByChat.get(chatId);
    const currentWorkdir = getCurrentWorkdir(chatId);
    const currentModel = modelByChat.get(chatId) ?? params.defaultModel;
    const stream = params.createStream({
      chatId,
      sourceMessageId,
      eventId,
      openId,
      signal
    });
    const translator = createStreamEventTranslator();

    try {
      logf(
        LOG_SCOPES.conversation,
        "start",
        {
          chat_id: chatId,
          open_id: openId,
          event_id: eventId ?? "unknown",
          session: previousSessionId ?? "new",
          workdir: currentWorkdir
        }
      );

      const result = await params.opencode.ask({
        message: text,
        sessionId: previousSessionId,
        model: currentModel,
        workdir: currentWorkdir,
        onEvent: (event) => {
          for (const streamEvent of translator.translate(event)) {
            stream.onEvent(streamEvent);
          }
        },
        signal
      });

      if (signal?.aborted) {
        await stream.abort();
        return;
      }

      sessionByChat.set(chatId, result.sessionId);
      logf(LOG_SCOPES.conversation, "success", {
        chat_id: chatId,
        open_id: openId,
        event_id: eventId ?? "unknown",
        session: result.sessionId
      });
      stream.onEvent({ type: "completed", text: result.text, sessionId: result.sessionId });
      await stream.flush();
    } catch (error) {
      if (params.opencode.isAbortError(error) || signal?.aborted) {
        await stream.abort();
        logf(
          LOG_SCOPES.conversation,
          "aborted",
          {
            chat_id: chatId,
            open_id: openId,
            event_id: eventId ?? "unknown",
            message_id: sourceMessageId ?? "unknown"
          }
        );
        return;
      }

      const errorMessage = error instanceof Error && error.message ? error.message : "调用 OpenCode 失败，请稍后重试。";
      errorf(LOG_SCOPES.conversation, "failed", {
        chat_id: chatId,
        open_id: openId,
        event_id: eventId ?? "unknown"
      }, error);
      await params.replyText({
        chatId,
        text: `处理失败：${errorMessage}`,
        replyToMessageId: sourceMessageId,
        eventId,
        openId,
        signal
      });
    }
  }

  return {
    handleMessage
  };
}
