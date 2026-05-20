import { errorf, LOG_SCOPES, logf } from "./logger";

export type ChatQueueTask = (signal: AbortSignal) => Promise<void>;

type ChatQueueItem = {
  sourceMessageId?: string;
  task: ChatQueueTask;
  controller: AbortController;
};

type ChatQueueState = {
  items: ChatQueueItem[];
  isProcessing: boolean;
  activeItem?: ChatQueueItem;
};

type CreateChatQueueParams = {
  waitUntilReady: () => Promise<void>;
  isAbortError: (error: unknown) => boolean;
};

export type ChatQueue = {
  enqueue(chatId: string, sourceMessageId: string | undefined, task: ChatQueueTask): void;
  recall(messageId: string): { aborted: number; removed: number };
  stop(chatId: string): { aborted: boolean; removed: number };
};

export function createChatQueue(params: CreateChatQueueParams): ChatQueue {
  const { waitUntilReady, isAbortError } = params;
  const chatMessageQueues = new Map<string, ChatQueueState>();

  function getOrCreateQueueState(chatId: string): ChatQueueState {
    const existed = chatMessageQueues.get(chatId);
    if (existed) {
      return existed;
    }

    const created: ChatQueueState = {
      items: [],
      isProcessing: false
    };
    chatMessageQueues.set(chatId, created);
    return created;
  }

  async function drainQueue(chatId: string, state: ChatQueueState): Promise<void> {
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
        await waitUntilReady();

        if (!current.controller.signal.aborted) {
          await current.task(current.controller.signal);
        }
      } catch (error) {
        if (isAbortError(error)) {
          logf(LOG_SCOPES.queue, "skipped_aborted_task", {
            chat_id: chatId,
            message_id: current.sourceMessageId ?? "unknown"
          });
        } else {
          errorf(
            LOG_SCOPES.queue,
            "task_failed",
            {
              chat_id: chatId,
              message_id: current.sourceMessageId ?? "unknown"
            },
            error
          );
        }
      } finally {
        state.activeItem = undefined;
      }
    }

    state.isProcessing = false;

    if (state.items.length === 0 && !state.activeItem) {
      chatMessageQueues.delete(chatId);
    }
  }

  function enqueue(chatId: string, sourceMessageId: string | undefined, task: ChatQueueTask): void {
    const state = getOrCreateQueueState(chatId);
    state.items.push({
      sourceMessageId,
      task,
      controller: new AbortController()
    });

    const queueSize = state.items.length + (state.activeItem ? 1 : 0);
    if (queueSize > 1) {
      logf(LOG_SCOPES.queue, "queued", {
        chat_id: chatId,
        queued: queueSize
      });
    }

    void drainQueue(chatId, state);
  }

  function recall(messageId: string): { aborted: number; removed: number } {
    let aborted = 0;
    let removed = 0;

    for (const [chatId, state] of chatMessageQueues.entries()) {
      if (state.activeItem?.sourceMessageId === messageId && !state.activeItem.controller.signal.aborted) {
        state.activeItem.controller.abort();
        aborted += 1;
      }

      const before = state.items.length;
      state.items = state.items.filter((item) => item.sourceMessageId !== messageId);
      const removedCount = before - state.items.length;
      if (removedCount > 0) {
        removed += removedCount;
        logf(LOG_SCOPES.queue, "removed_pending", {
          chat_id: chatId,
          message_id: messageId,
          removed: removedCount
        });
      }

      if (!state.isProcessing && state.items.length === 0 && !state.activeItem) {
        chatMessageQueues.delete(chatId);
      }
    }

    return { aborted, removed };
  }

  function stop(chatId: string): { aborted: boolean; removed: number } {
    const state = chatMessageQueues.get(chatId);
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
      chatMessageQueues.delete(chatId);
    }

    return { aborted, removed };
  }

  return {
    enqueue,
    recall,
    stop
  };
}
