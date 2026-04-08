#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const entry = resolve(__dirname, "..", "dist", "main.js");

if (!existsSync(entry)) {
  console.error("未找到 dist/main.js，请先执行 npm run build。");
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
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
  console.error("启动服务失败:", error.message);
  process.exit(1);
});
