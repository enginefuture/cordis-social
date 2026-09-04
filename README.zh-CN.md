# Cordis Social

Cordis Social 是一个面向日常社交平台操作的 Cordis 插件套件。目前通过可见浏览器
支持 X，并为后续接入 Codex、PingClaw Desk、CLI 和桌面应用保留宿主无关接口。

项目遵循 [`cordiverse/cordis`](https://github.com/cordiverse/cordis) v4：

- 使用 `Service` 向 `Context` 注入能力；
- 使用 TypeScript declaration merging 声明 `ctx.social`；
- 消费插件通过 `inject` 声明服务依赖；
- 配置使用 Standard Schema；
- adapter、timer、browser lease 和草稿都绑定 Cordis Fiber，卸载时可逆清理。

Cordis v4 当前仍是 RC，因此项目固定并测试 `cordis@4.0.0-rc.9`。

## 插件包

| 包 | 功能 |
| --- | --- |
| `cordis-plugin-social` | `ctx.social` 核心服务、平台注册、两阶段发布和事件 |
| `cordis-plugin-social-browser` | `ctx.socialBrowser` 抽象契约 |
| `cordis-plugin-social-browser-local` | 无需 key 的本地 Chrome/Edge 持久会话 |
| `cordis-plugin-social-profilefleet` | 通过 ProfileFleet 获取集群浏览器 lease |
| `cordis-plugin-social-x` | X 登录、发帖、回复、引用和图片上传 |
| `cordis-plugin-social-tools` | Codex、PingClaw Desk 等宿主可映射的 JSON 工具 |

## 开发

这些包已经具备 npm 发布结构，但当前尚未发布到 npm：

```bash
git clone https://github.com/enginefuture/cordis-social.git
cd cordis-social
pnpm install
pnpm check
pnpm example
```

测试 X 登录：

```bash
pnpm example -- --login
```

本地 provider 默认优先 Microsoft Edge，其次 Google Chrome，并把独立 profile
保存到 `~/.cordis-social/profiles/x-default`。第一次手动登录，以后自动复用登录态。

## 两阶段发布

```ts
const draft = await ctx.social.preparePost({
  platform: "x",
  text: "准备发布的内容",
});

// 将 draft.text 和 draft.screenshotPath 展示给用户确认。
const result = await ctx.social.publishPost(
  draft.id,
  draft.confirmationToken,
);
```

`preparePost` 永远不会发布；`publishPost` 必须携带一次性 confirmation token。
拒绝发布时调用 `discardPost`，默认 10 分钟未确认也会自动释放浏览器 session。

## 为什么有两种浏览器 provider

- `browser-local` 使用普通 Edge/Chrome，不需要 CloakBrowser key，适合本地日常操作。
- `profilefleet` 负责多 profile、容量、租约、文件锁和崩溃恢复，适合集成到长期运行的宿主。

实际测试中，X 接受普通 Edge 的登录 profile，但拒绝 CloakBrowser 登录流程，因此
X 插件只依赖抽象 `socialBrowser`，不会绑死某个指纹浏览器。

## 接入 Codex / PingClaw Desk

`ctx.socialTools.list()` 返回宿主无关的工具名、JSON Schema 和 `execute()`：

- `social_platforms`
- `social_auth_status`
- `social_login`
- `social_prepare_post`
- `social_publish_post`
- `social_discard_post`

宿主只需注册这些工具、传递 `AbortSignal`，并在发布前展示草稿和截图、获取明确确认。
平台插件不依赖 OpenAI、Codex 或 PingClaw SDK。

### 本地安装到 Codex

仓库提供一个 stdio MCP 入口，它直接映射上述六个工具，并继续强制执行“准备草稿 → 人工确认 → 发布”的两阶段流程：

```bash
pnpm install
codex mcp add cordis-social -- \
  /opt/homebrew/bin/pnpm --dir /absolute/path/to/cordis-social run mcp
```

首次调用 `social_login` 时会打开独立的本地 Edge/Chrome profile，登录态保存在 `~/.cordis-social/profiles/x-default`。MCP 的 stdout 只用于协议消息，预览和发布截图保存在 `~/.cordis-social/artifacts/x`。

当前 X 支持文字、最多四张图片、回复和引用。不会自动填写凭据、绕过 CAPTCHA、
批量互动或无确认发布。

参见 [架构](docs/ARCHITECTURE.md)、[安全策略](SECURITY.md) 和
[可接受使用](ACCEPTABLE_USE.md)。许可证为 MIT。
