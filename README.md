# opencode-feishu

飞书长连接单人机器人：基于 open_id 白名单接入，未授权用户通过临时 token 完成绑定。

## 1. 安装依赖

```bash
npm install
```

## 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写：

- `FEISHU_APP_ID`: 飞书应用 App ID
- `FEISHU_APP_SECRET`: 飞书应用 App Secret
- `ALLOWED_OPEN_ID`: 已授权用户的 open_id 列表（逗号分隔，用户验证成功后会自动写入）
- `OPENCODE_MODEL`: 可选，指定模型（如 `openai/gpt-5.3-codex`）
- `OPENCODE_TIMEOUT_MS`: 可选，OpenCode 超时时间（默认 `300000`）

## 3. 本地运行

```bash
npm run dev
```

看到 `飞书长连接已启动，等待消息...` 后：

1. 未授权用户发送任意消息后，服务会在日志打印该用户的临时 token（10 分钟有效）。
2. 用户向机器人发送该 token（需完全匹配）后，当前 `open_id` 会自动写入 `.env` 的 `ALLOWED_OPEN_ID`。
3. 完成授权后发送消息，机器人会返回 OpenCode 的回答。
4. 如需清空上下文，发送 `/reset`。

## 4. 飞书后台最小配置

- 启用机器人能力
- 开启事件订阅（长连接模式）
- 订阅 `接收消息 v2.0` 事件（`im.message.receive_v1`）
- 授权机器人可读取并发送消息

## 5. 说明

- 当前按飞书用户 `open_id` 在内存里维护 `session_id`，用于保持上下文。
- 进程重启后会话映射会丢失，属于预期行为；若需要持久化可接 SQLite/Redis。
