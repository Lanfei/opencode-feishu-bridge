export const LOG_SCOPES = {
  bootstrap: "bootstrap",
  feishu: "feishu",
  queue: "queue",
  conversation: "conversation",
  opencode: "opencode"
} as const;

type LogFieldValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogFieldValue>;

const PRIORITY_FIELD_KEYS = ["chat_id", "open_id", "event_id", "message_id", "session", "action", "message_type"] as const;

function formatMessage(scope: string, message: string): string {
  return `[${scope}]: ${message}`;
}

function formatFieldValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    if (value.length === 0) {
      return "";
    }

    return /\s/.test(value) ? JSON.stringify(value) : value;
  }

  return String(value);
}

function formatFields(fields?: LogFields): string {
  if (!fields) {
    return "";
  }

  const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return "";
  }

  const prioritizedKeys = new Set(PRIORITY_FIELD_KEYS);
  const orderedEntries: Array<[string, LogFieldValue]> = [];

  for (const key of PRIORITY_FIELD_KEYS) {
    const entry = entries.find(([entryKey]) => entryKey === key);
    if (entry) {
      orderedEntries.push(entry);
    }
  }

  for (const entry of entries) {
    if (!prioritizedKeys.has(entry[0] as (typeof PRIORITY_FIELD_KEYS)[number])) {
      orderedEntries.push(entry);
    }
  }

  return orderedEntries
    .map(([key, value]) => `${key}=${formatFieldValue(value as string | number | boolean)}`)
    .join(" ");
}

function formatMessageWithFields(scope: string, message: string, fields?: LogFields): string {
  const formattedFields = formatFields(fields);
  if (!formattedFields) {
    return formatMessage(scope, message);
  }

  return `${formatMessage(scope, message)} ${formattedFields}`;
}

export function log(scope: string, message: string, ...args: unknown[]): void {
  console.log(formatMessage(scope, message), ...args);
}

export function logf(scope: string, message: string, fields?: LogFields, ...args: unknown[]): void {
  console.log(formatMessageWithFields(scope, message, fields), ...args);
}

export function warn(scope: string, message: string, ...args: unknown[]): void {
  console.warn(formatMessage(scope, message), ...args);
}

export function warnf(scope: string, message: string, fields?: LogFields, ...args: unknown[]): void {
  console.warn(formatMessageWithFields(scope, message, fields), ...args);
}

export function error(scope: string, message: string, ...args: unknown[]): void {
  console.error(formatMessage(scope, message), ...args);
}

export function errorf(scope: string, message: string, fields?: LogFields, ...args: unknown[]): void {
  console.error(formatMessageWithFields(scope, message, fields), ...args);
}
