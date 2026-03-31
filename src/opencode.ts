import { spawn } from "node:child_process";

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    sessionID?: string;
  };
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
  timeoutMs: number;
}): Promise<{ text: string; sessionId: string }> {
  if (!currentServeConfig) {
    throw new Error("OpenCode serve 未初始化，请先调用 initOpenCodeServe。");
  }

  await initOpenCodeServe(currentServeConfig);

  const serveUrl = buildServeUrl(currentServeConfig);
  const args = ["run", "--format", "json", "--attach", serveUrl, "--password", currentServeConfig.password];

  if (params.sessionId) {
    args.push("--session", params.sessionId);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.message);

  const { stdout, stderr, code, signal, timedOut } = await runCommand(
    args,
    params.timeoutMs,
    currentServeConfig.password
  );

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

  let resolvedSessionId = params.sessionId ?? "";
  const textParts: string[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let event: OpenCodeEvent;
    try {
      event = JSON.parse(line) as OpenCodeEvent;
    } catch {
      continue;
    }

    if (!resolvedSessionId) {
      resolvedSessionId = event.sessionID ?? event.part?.sessionID ?? "";
    }

    if (event.type === "text" && event.part?.text) {
      textParts.push(event.part.text);
    }
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

async function startServeProcess(config: ServeConfig): Promise<void> {
  const args = [
    "serve",
    "--hostname",
    config.hostname,
    "--port",
    String(config.port)
  ];

  const child = spawn("opencode", args, {
    cwd: process.cwd(),
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
      console.log(`${prefix} ${message}`);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.error(`${prefix} ${message}`);
    }
  });

  child.once("exit", (code, signal) => {
    console.error(`${prefix} exited code=${String(code)} signal=${signal ?? "none"}`);
    if (serveProcess === child) {
      serveProcess = null;
      serveStartPromise = null;
    }
  });

  child.once("error", (error) => {
    console.error(`${prefix} failed`, error);
  });

  try {
    await waitForServeReady(config);
    console.log(`${prefix} ready`);
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
      ["run", "--format", "json", "--attach", serveUrl, "--password", config.password, "ping"],
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
  password?: string
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: process.cwd(),
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
