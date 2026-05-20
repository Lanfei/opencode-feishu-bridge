export type UserMessage = {
  chatId: string;
  sourceMessageId?: string;
  openId: string;
  text: string;
  eventId?: string;
};

export type OpenCodeRawEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    messageID?: string;
    text?: string;
    sessionID?: string;
    tool?: string;
    state?: {
      status?: string;
      input?: {
        description?: string;
      };
    };
  };
};

export type OpenCodeSession = {
  id: string;
  title?: string;
  updated?: number;
  created?: number;
  projectId?: string;
  directory?: string;
};

export type OpenCodeModel = {
  id: string;
  provider: string;
};

export type OpenCodeSessionModel = {
  providerId: string;
  modelId: string;
  id: string;
};

export type ConversationStreamEvent =
  | { type: "step_started"; stepId: string }
  | { type: "step_text"; stepId: string; text: string }
  | { type: "step_tool"; stepId: string; text: string }
  | { type: "step_finished"; stepId: string }
  | { type: "completed"; text: string; sessionId: string };
