import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  OpenCodeModel,
  OpenCodeRawEvent,
  OpenCodeSession,
  OpenCodeSessionModel
} from "./contracts";
import { error as logError, log, LOG_SCOPES } from "./logger";

const OPENCODE_ABORT_ERROR = "OPENCODE_ABORT_ERROR";
const FORCE_KILL_DELAY_MS = 5000;
const SERVE_PROBE_TIMEOUT_MS = 2000;

type ServeConfig = {
  hostname: string;
  port: number;
};

type CreateOpenCodeParams = {
  defaultWorkdir: string;
  hostname: string;
  port: number;
  timeoutMs: number;
};

export type OpenCodeClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
  ask(params: {
    message: string;
    sessionId?: string;
    model?: string;
    workdir?: string;
    onEvent?: (event: OpenCodeRawEvent) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string; sessionId: string }>;
  listModels(): Promise<OpenCodeModel[]>;
  listSessions(maxCount?: number): Promise<OpenCodeSession[]>;
  getSessionById(sessionId: string): Promise<OpenCodeSession | undefined>;
  getSessionLatestModel(sessionId: string): Promise<OpenCodeSessionModel | undefined>;
  isAbortError(error: unknown): boolean;
};

function createAbortError(): Error {
  const error = new Error("OpenCode 请求已取消。") as Error & { code?: string };
  error.code = OPENCODE_ABORT_ERROR;
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: string }).code === OPENCODE_ABORT_ERROR;
}

export function createOpenCode(params: CreateOpenCodeParams): OpenCodeClient {
  const serveConfig: ServeConfig = {
    hostname: params.hostname,
    port: params.port
  };

  let serveProcess: ReturnType<typeof spawn> | null = null;
  let serveStartPromise: Promise<void> | null = null;

  function buildServeUrl(config: ServeConfig): string {
    return `http://${config.hostname}:${config.port}`;
  }

  function requestChildTermination(
    child: ReturnType<typeof spawn>,
    state: { closed: boolean; forceKillTimer?: NodeJS.Timeout }
  ): void {
    if (!child.killed) {
      child.kill("SIGTERM");
    }

    if (!state.forceKillTimer) {
      state.forceKillTimer = setTimeout(() => {
        if (!state.closed && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
    }
  }

  async function start(): Promise<void> {
    if (serveProcess && !serveProcess.killed) {
      return;
    }

    if (serveStartPromise) {
      await serveStartPromise;
      return;
    }

    serveStartPromise = startServeProcess(serveConfig);
    await serveStartPromise;
  }

  async function stop(): Promise<void> {
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

  async function ask(request: {
    message: string;
    sessionId?: string;
    model?: string;
    workdir?: string;
    onEvent?: (event: OpenCodeRawEvent) => void;
    signal?: AbortSignal;
  }): Promise<{ text: string; sessionId: string }> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    await start();

    const serveUrl = buildServeUrl(serveConfig);
    const runWorkdir = request.workdir?.trim() || params.defaultWorkdir;
    const args = [
      "run",
      "--format",
      "json",
      "--attach",
      serveUrl,
      "--dir",
      runWorkdir
    ];

    if (request.sessionId) {
      args.push("--session", request.sessionId);
    }

    if (request.model) {
      args.push("--model", request.model);
    }

    args.push(request.message);

    const textParts: string[] = [];
    let resolvedSessionId = request.sessionId ?? "";

    const { stdout, stderr, code, signal, timedOut, aborted } = await runCommandStreaming(
      args,
      params.timeoutMs,
      request.signal,
      (event) => {
        request.onEvent?.(event);

        if (!resolvedSessionId) {
          resolvedSessionId = event.sessionID ?? event.part?.sessionID ?? "";
        }

        if (event.type === "text" && event.part?.text) {
          textParts.push(event.part.text);
        }
      }
    );

    if (aborted || request.signal?.aborted) {
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

      const timeoutHint = timedOut ? ` | 可能超时（当前超时=${String(Math.ceil(params.timeoutMs / 1000))}s）` : "";
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

  async function listSessions(maxCount = 20): Promise<OpenCodeSession[]> {
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

  async function getSessionById(sessionId: string): Promise<OpenCodeSession | undefined> {
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

  async function listModels(): Promise<OpenCodeModel[]> {
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
      if (!provider.trim()) {
        continue;
      }

      models.push({ id, provider });
    }

    return models;
  }

  async function getSessionLatestModel(sessionId: string): Promise<OpenCodeSessionModel | undefined> {
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

    const pickLatestModel = (role?: string): OpenCodeSessionModel | undefined => {
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
  async function startServeProcess(config: ServeConfig): Promise<void> {
    const args = [
      "serve",
      "--hostname",
      config.hostname,
      "--port",
      String(config.port)
    ];

    const child = spawn("opencode", args, {
      cwd: params.defaultWorkdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    serveProcess = child;

    const prefix = `[opencode-serve ${config.hostname}:${config.port}]`;

    child.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        log(LOG_SCOPES.opencode, `${prefix} ${message}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        logError(LOG_SCOPES.opencode, `${prefix} ${message}`);
      }
    });

    child.once("exit", (code, signal) => {
      logError(LOG_SCOPES.opencode, `${prefix} exited code=${String(code)} signal=${signal ?? "none"}`);
      if (serveProcess === child) {
        serveProcess = null;
        serveStartPromise = null;
      }
    });

    child.once("error", (error) => {
      logError(LOG_SCOPES.opencode, `${prefix} failed`, error);
    });

    try {
      await waitForServeReady(config);
      log(LOG_SCOPES.opencode, `${prefix} ready`);
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
    const maxAttempts = 30;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (await probeServePort(config, SERVE_PROBE_TIMEOUT_MS)) {
        return;
      }

      await sleep(300);
    }

    throw new Error("OpenCode serve 启动超时，请检查本地端口或模型配置。");
  }

  async function probeServePort(config: ServeConfig, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = createConnection({
        host: config.hostname,
        port: config.port
      });

      let settled = false;

      const settle = (ready: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(ready);
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        settle(true);
      });
      socket.once("timeout", () => {
        settle(false);
      });
      socket.once("error", () => {
        settle(false);
      });
    });
  }

  async function runCommand(
    args: string[],
    timeoutMs: number,
    workingDirectory?: string
  ): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    return await new Promise((resolve, reject) => {
      const child = spawn("opencode", args, {
        cwd: workingDirectory ?? params.defaultWorkdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutParts: Buffer[] = [];
      const stderrParts: Buffer[] = [];
      let timedOut = false;
      const terminationState: { closed: boolean; forceKillTimer?: NodeJS.Timeout } = {
        closed: false
      };

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
        requestChildTermination(child, terminationState);
      }, timeoutMs);

      child.on("close", (code, signal) => {
        terminationState.closed = true;
        clearTimeout(timeout);
        if (terminationState.forceKillTimer) {
          clearTimeout(terminationState.forceKillTimer);
        }
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
    abortSignal: AbortSignal | undefined,
    onEvent: (event: OpenCodeRawEvent) => void
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
        cwd: params.defaultWorkdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutParts: Buffer[] = [];
      const stderrParts: Buffer[] = [];
      let timedOut = false;
      let aborted = false;
      let stdoutTextBuffer = "";
      const terminationState: { closed: boolean; forceKillTimer?: NodeJS.Timeout } = {
        closed: false
      };

      const onAbort = (): void => {
        aborted = true;
        requestChildTermination(child, terminationState);
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
              const event = JSON.parse(line) as OpenCodeRawEvent;
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
        requestChildTermination(child, terminationState);
      }, timeoutMs);

      child.on("close", (code, signal) => {
        terminationState.closed = true;
        clearTimeout(timeout);
        if (terminationState.forceKillTimer) {
          clearTimeout(terminationState.forceKillTimer);
        }
        abortSignal?.removeEventListener("abort", onAbort);

        if (stdoutTextBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutTextBuffer.trim()) as OpenCodeRawEvent;
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

  return {
    start,
    stop,
    ask,
    listModels,
    listSessions,
    getSessionById,
    getSessionLatestModel,
    isAbortError
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
