import { spawn } from "node:child_process";

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    sessionID?: string;
  };
};

export async function askOpenCode(params: {
  message: string;
  sessionId?: string;
  model?: string;
  timeoutMs: number;
}): Promise<{ text: string; sessionId: string }> {
  const args = ["run", "--format", "json"];

  if (params.sessionId) {
    args.push("--session", params.sessionId);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.message);

  const { stdout, stderr, code, signal, timedOut } = await runCommand(args, params.timeoutMs);

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

async function runCommand(
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd: process.cwd(),
      env: process.env,
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
