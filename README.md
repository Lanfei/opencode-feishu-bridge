# opencode-feishu-bridge

`opencode-feishu-bridge` 是一个连接飞书与 OpenCode 的轻量级桥接服务。它通过飞书长连接接收消息，转发给 OpenCode 处理，并将结果回传到会话中。

## 运行方式

方式一：全局安装

```bash
npm i -g opencode-feishu-bridge
```

启动服务：

```bash
ofbs
```

启动 OpenCode 并连接到服务：

```bash
# ofbc <url>
ofbc
```

方式二：直接使用 npx（无需安装）

```bash
npx --package opencode-feishu-bridge ofbs
```

启动 OpenCode 并连接到服务：

```bash
# npx --package opencode-feishu-bridge ofbc <url>
npx --package opencode-feishu-bridge ofbc
```

看到 `飞书长连接已启动，等待消息...` 后：

1. 配置 `allowedOpenId` 后，只有白名单内的用户可以使用机器人；未授权用户会收到提示。
2. 若 `allowedOpenId` 为空，则允许所有用户接入（启动时会打印安全告警日志）。
3. 发送消息后，机器人会返回 OpenCode 的回答。
4. 如需清空上下文，发送 `/reset` 或 `/new`；如需新会话切到指定目录，发送 `/new <工作目录>`。
5. 如需停止当前任务并清空当前用户队列，发送 `/stop`。
6. 如需查看可恢复会话，发送 `/resume`；如需切换到某个会话，发送 `/resume <编号|session_id>`。
7. 如需查看已配置 provider 的可用模型，发送 `/models`。
8. 如需查看当前会话最近使用模型，发送 `/model`；如需切换模型，发送 `/model <model_id>`。

## 飞书后台最小配置

- 启用机器人能力
- 开启事件订阅（长连接模式）
- 订阅 `接收消息 v2.0`（`im.message.receive_v1`）和 `消息撤回事件`（`im.message.recalled_v1`）
- 授权机器人可读取并发送消息
