#!/usr/bin/env node

const { spawn } = require("node:child_process");

const defaultUrl = "http://127.0.0.1:4096";
const args = process.argv.slice(2);
const hasUrlArg = Boolean(args[0] && !args[0].startsWith("-"));
const url = hasUrlArg ? args[0] : defaultUrl;
const extraArgs = hasUrlArg ? args.slice(1) : args;

const child = spawn("opencode", ["attach", url, "--dir", process.cwd(), ...extraArgs], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("启动 opencode attach 失败:", error.message);
  process.exit(1);
});
