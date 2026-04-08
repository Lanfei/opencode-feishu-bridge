import { spawn } from "node:child_process";
import { config } from "./config";

const OPENCODE_ABORT_ERROR = "OPENCODE_ABORT_ERROR";
const OPENCODE_DEFAULT_WORKDIR = config.opencodeWorkdir;

function createAbortError(): Error {
  const error = new Error("OpenCode 请求已取消。") as Error & { code?: string };
  error.code = OPENCODE_ABORT_ERROR;
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: string }).code === OPENCODE_ABORT_ERROR;
}

export type OpenCodeEvent = {
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

type ServeConfig = {
  hostname: string;
  port: number;
  password: string;
};

let serveProcess: ReturnType<typeof spawn> | null = null;
let serveStartPromise: Promise<void> | null = null;
let currentServeConfig: ServeConfig | null = null;

function buildServeUrl(config: ServeConfig): string {
  return `http://${config.hostname}:${config.port}`;
}

export async function initOpenCodeServe(config: ServeConfig): Promise<void> {
  currentServeConfig = config;

  if (serveProcess && !serveProcess.killed) {
    return;
  }

  if (serveStartPromise) {
    await serveStartPromise;
    return;
  }

  serveStartPromise = startServeProcess(config);
  await serveStartPromise;
}

export async function stopOpenCodeServe(): Promise<void> {
  if (!serveProcess || serveProcess.killed) {
    return;
  }

  const processToStop = serveProcess;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!processToStop.killed) {
        processToStop.kill("SIGKILL");
      }
    }, 5000);

    processToStop.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    processToStop.kill("SIGTERM");
  });
}

export async function askOpenCode(params: {
  message: string;
  sessionId?: string;
  model?: string;
  workdir?: string;
  timeoutMs: number;
  onTextDelta?: (text: string) => void;
  onEvent?: (event: OpenCodeEvent) => void;
  signal?: AbortSignal;
}): Promise<{ text: string; sessionId: string }> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }

  if (!currentServeConfig) {
    throw new Error("OpenCode serve 未初始化，请先调用 initOpenCodeServe。");
  }

  await initOpenCodeServe(currentServeConfig);

  const serveUrl = buildServeUrl(currentServeConfig);
  const runWorkdir = params.workdir?.trim() || OPENCODE_DEFAULT_WORKDIR;
  const args = [
    "run",
    "--format",
    "json",
    "--attach",
    serveUrl,
    "--password",
    currentServeConfig.password,
    "--dir",
    runWorkdir
  ];

  if (params.sessionId) {
    args.push("--session", params.sessionId);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.message);

  const textParts: string[] = [];
  let resolvedSessionId = params.sessionId ?? "";

  const { stdout, stderr, code, signal, timedOut, aborted } = await runCommandStreaming(
    args,
    params.timeoutMs,
    currentServeConfig.password,
    params.signal,
    (event) => {
      params.onEvent?.(event);

      if (!resolvedSessionId) {
        resolvedSessionId = event.sessionID ?? event.part?.sessionID ?? "";
      }

      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
        params.onTextDelta?.(event.part.text);
      }
    }
  );

  if (aborted || params.signal?.aborted) {
    throw createAbortError();
  }

  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");

    const timeoutHint = timedOut ? ` | 可能超时（当前超时=${params.timeoutMs}ms）` : "";
    throw new Error(`OpenCode 命令执行失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  const text = textParts.join("").trim();

  if (!text) {
    throw new Error(stderr.trim() || "OpenCode 未返回可解析文本。");
  }

  if (!resolvedSessionId) {
    throw new Error("OpenCode 未返回 sessionID，无法维持上下文。");
  }

  return {
    text,
    sessionId: resolvedSessionId
  };
}

function parseOpenCodeSessionsFromJson(text: string): OpenCodeSession[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const sessions: OpenCodeSession[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) {
      continue;
    }

    sessions.push({
      id,
      title: typeof record.title === "string" ? record.title : undefined,
      updated: typeof record.updated === "number" ? record.updated : undefined,
      created: typeof record.created === "number" ? record.created : undefined,
      projectId: typeof record.projectId === "string" ? record.projectId : undefined,
      directory: typeof record.directory === "string" ? record.directory : undefined
    });
  }

  return sessions;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export async function listOpenCodeSessionsFromDb(maxCount = 20): Promise<OpenCodeSession[]> {
  const safeCount = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 20;
  const query = [
    "select",
    "id,",
    "title,",
    "project_id as projectId,",
    "directory,",
    "time_created as created,",
    "time_updated as updated",
    "from session",
    "where time_archived is null and parent_id is null",
    "order by time_updated desc",
    `limit ${String(safeCount)}`
  ].join(" ");

  const { stdout, stderr, code, signal, timedOut } = await runCommand(["db", query, "--format", "json"], 15000);
  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    const timeoutHint = timedOut ? " | 可能超时" : "";
    throw new Error(`查询 OpenCode 会话失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  return parseOpenCodeSessionsFromJson(stdout);
}

export async function getOpenCodeSessionByIdFromDb(sessionId: string): Promise<OpenCodeSession | undefined> {
  const id = sessionId.trim();
  if (!id) {
    return undefined;
  }

  const query = [
    "select",
    "id,",
    "title,",
    "project_id as projectId,",
    "directory,",
    "time_created as created,",
    "time_updated as updated",
    "from session",
    `where id='${escapeSqlString(id)}'`,
    "limit 1"
  ].join(" ");

  const { stdout, stderr, code, signal, timedOut } = await runCommand(["db", query, "--format", "json"], 15000);
  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    const timeoutHint = timedOut ? " | 可能超时" : "";
    throw new Error(`查询 OpenCode 会话失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  const sessions = parseOpenCodeSessionsFromJson(stdout);
  return sessions[0];
}

export async function listOpenCodeModels(): Promise<OpenCodeModel[]> {
  const providers = await listConfiguredProviderIds();
  if (providers.length === 0) {
    return [];
  }

  const providerSet = new Set(providers);
  const { stdout, stderr, code, signal, timedOut } = await runCommand(["models"], 20000);

  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    const timeoutHint = timedOut ? " | 可能超时" : "";
    throw new Error(`查询 OpenCode 模型失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  const modelIds = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const models: OpenCodeModel[] = [];

  for (const id of modelIds) {
    const separatorIndex = id.indexOf("/");
    if (separatorIndex <= 0) {
      continue;
    }

    const provider = id.slice(0, separatorIndex);
    if (!providerSet.has(provider)) {
      continue;
    }

    models.push({ id, provider });
  }

  return models;
}

export async function getOpenCodeSessionLatestModel(sessionId: string): Promise<OpenCodeSessionModel | undefined> {
  const id = sessionId.trim();
  if (!id) {
    return undefined;
  }

  const { stdout, stderr, code, signal, timedOut } = await runCommand(["export", id], 20000);
  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    const timeoutHint = timedOut ? " | 可能超时" : "";
    throw new Error(`查询 OpenCode 会话模型失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    return undefined;
  }

  const parsed = JSON.parse(stdout.slice(jsonStart)) as {
    messages?: Array<{
      info?: {
        role?: string;
        model?: {
          providerID?: string;
          modelID?: string;
        };
      };
    }>;
  };

  if (!Array.isArray(parsed.messages)) {
    return undefined;
  }

  const messages = parsed.messages;

  const pickLatestModel = (
    role?: string
  ): OpenCodeSessionModel | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (role && info?.role !== role) {
        continue;
      }

      const model = info?.model;
      const providerId = model?.providerID?.trim();
      const modelId = model?.modelID?.trim();
      if (providerId && modelId) {
        return {
          providerId,
          modelId,
          id: `${providerId}/${modelId}`
        };
      }
    }

    return undefined;
  };

  return pickLatestModel("assistant") ?? pickLatestModel();
}

async function listConfiguredProviderIds(): Promise<string[]> {
  const { stdout, stderr, code, signal, timedOut } = await runCommand(["providers", "list"], 15000);

  if (code !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const reason = [
      `code=${String(code)}`,
      signal ? `signal=${signal}` : "",
      stderrText ? `stderr=${stderrText}` : "",
      !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
    const timeoutHint = timedOut ? " | 可能超时" : "";
    throw new Error(`查询 OpenCode provider 失败: ${reason || "未知错误"}${timeoutHint}`);
  }

  const cleanText = stripAnsi(stdout);
  const providerIds: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of cleanText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("●")) {
      continue;
    }

    const rawProvider = line.replace(/^●\s+/, "").trim();
    if (!rawProvider) {
      continue;
    }

    const parts = rawProvider.split(/\s+/);
    const last = parts[parts.length - 1]?.trim();
    if (last && (last.toLowerCase() === "api" || /^[A-Z0-9_]+$/.test(last))) {
      parts.pop();
    }

    const providerName = parts.join(" ").trim();
    if (!providerName) {
      continue;
    }

    const providerId = providerDisplayNameToId(providerName);
    if (!providerId || seen.has(providerId)) {
      continue;
    }

    seen.add(providerId);
    providerIds.push(providerId);
  }

  return providerIds;
}

function providerDisplayNameToId(name: string): string {
  const normalized = name.trim().toLowerCase();
  const mapped: Record<string, string> = {
    anthropic: "anthropic",
    google: "google",
    openai: "openai",
    xai: "xai",
    opencode: "opencode",
    "google vertex": "google-vertex",
    "google vertex anthropic": "google-vertex-anthropic",
    "azure openai": "azure-openai"
  };

  if (mapped[normalized]) {
    return mapped[normalized];
  }

  return normalized
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

async function startServeProcess(config: ServeConfig): Promise<void> {
  const args = [
    "serve",
    "--hostname",
    config.hostname,
    "--port",
    String(config.port)
  ];

  const child = spawn("opencode", args, {
    cwd: OPENCODE_DEFAULT_WORKDIR,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: config.password
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serveProcess = child;

  const prefix = `[opencode-serve ${config.hostname}:${config.port}]`;

  child.stdout.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.log(`${prefix}: ${message}`);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.error(`${prefix}: ${message}`);
    }
  });

  child.once("exit", (code, signal) => {
    console.error(`${prefix}: exited code=${String(code)} signal=${signal ?? "none"}`);
    if (serveProcess === child) {
      serveProcess = null;
      serveStartPromise = null;
    }
  });

  child.once("error", (error) => {
    console.error(`${prefix}: failed`, error);
  });

  try {
    await waitForServeReady(config);
    console.log(`${prefix}: ready`);
  } catch (error) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    serveProcess = null;
    serveStartPromise = null;
    throw error;
  }
}

async function waitForServeReady(config: ServeConfig): Promise<void> {
  const serveUrl = buildServeUrl(config);
  const maxAttempts = 30;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await runCommand(
      [
        "run",
        "--format",
        "json",
        "--attach",
        serveUrl,
        "--password",
        config.password,
        "--dir",
        OPENCODE_DEFAULT_WORKDIR,
        "ping"
      ],
      8000,
      config.password
    );
    if (probe.code === 0) {
      return;
    }

    await sleep(300);
  }

  throw new Error("OpenCode serve 启动超时，请检查本地端口或模型配置。");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCommand(
  args: string[],
  timeoutMs: number,
  password?: string,
  workingDirectory?: string
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: workingDirectory ?? OPENCODE_DEFAULT_WORKDIR,
      env: {
        ...process.env,
        ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutParts.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrParts.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdoutParts).toString("utf8"),
        stderr: Buffer.concat(stderrParts).toString("utf8"),
        code,
        signal,
        timedOut
      });
    });

    child.stdin.end();
  });
}

async function runCommandStreaming(
  args: string[],
  timeoutMs: number,
  password: string,
  abortSignal: AbortSignal | undefined,
  onEvent: (event: OpenCodeEvent) => void
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: OPENCODE_DEFAULT_WORKDIR,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let closed = false;
    let stdoutTextBuffer = "";
    let abortKillTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      aborted = true;
      if (!child.killed) {
        child.kill("SIGTERM");
      }

      if (!abortKillTimer) {
        abortKillTimer = setTimeout(() => {
          if (!closed && child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutParts.push(chunk);

      stdoutTextBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutTextBuffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = stdoutTextBuffer.slice(0, newlineIndex).trim();
        stdoutTextBuffer = stdoutTextBuffer.slice(newlineIndex + 1);

        if (line) {
          try {
            const event = JSON.parse(line) as OpenCodeEvent;
            onEvent(event);
          } catch {
            // Ignore non-JSON output lines.
          }
        }

        newlineIndex = stdoutTextBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrParts.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
      }
      abortSignal?.removeEventListener("abort", onAbort);

      if (stdoutTextBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutTextBuffer.trim()) as OpenCodeEvent;
          onEvent(event);
        } catch {
          // Ignore trailing partial output.
        }
      }

      resolve({
        stdout: Buffer.concat(stdoutParts).toString("utf8"),
        stderr: Buffer.concat(stderrParts).toString("utf8"),
        code,
        signal,
        timedOut,
        aborted
      });
    });

    child.stdin.end();
  });
}
