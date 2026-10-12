---
name: weixin-channels-video
description: 通过本机 Chrome 扩展解析视频号分享链接并下载视频；首次使用时准备 Skill 运行资源并安装本地桥接。
---

# 视频号解析与下载

使用包内 `scripts/run.mjs` 调用本项目 Chrome 扩展。扩展使用 Chrome 中的元宝会话并运行共享解析核心；Skill 不读取 Cookie 或钥匙串，不依赖源码仓库、Docker、远程解析服务或 Codex Chrome 插件。

## 安装与更新

首次运行本地命令前，先读 [Agent 安装与本地运行边界](references/agent-installation.md)，确认当前 Agent、OS、CPU 架构、Shell、Node 与目标 Chrome 位于可互相访问的同一台机器。Skill 的最低 Node.js 版本是 **22.22.2**；开发工具要求更高版本时不提高 Skill 用户门槛。兼容的现有 Node 直接复用。系统或宿主阻止必要操作时，报告被阻止的步骤和错误类别。

从仓库安装或更新的 Skill，先准备带 SHA256 校验的运行资源：

```sh
node <skill-root>/scripts/run.mjs prepare
```

源码 Skill 的 `prepare` 下载最新稳定 Release 的独立运行资源，校验 SHA256 和 runtime package protocol 3，再写入按用户隔离的本地缓存。若尚无已发布且兼容 protocol 3 的资源，准确报告不兼容并停止；不要把旧版正式 Release 当作可用的新资源。普通 CLI 命令复用兼容缓存；首次缓存缺失时会准备后继续。独立 Skill Release 包自带运行资源，可离线准备。准备失败时停止并保留当前缓存。SHA256 校验不是签名验证。IPC protocol 2 的私有 HMAC 端点与 Native Messaging wire protocol 2 独立版本管理。

Skill 和 Chrome 扩展分别构建、发布和更新。扩展安装方式的选择见 [Agent 安装与本地运行边界](references/agent-installation.md)。Skill 包只含 CLI、Native Messaging host 和运行资源，不携带或管理扩展。桥接安装后通过 CLI 与扩展的真实 status 往返确认连接即可结束安装；不要求先登录元宝、解析或下载。扩展版本、host 版本、CLI 版本只按握手实际报告的值描述，缺失时写 `unknown`。

## 连接与登录状态

安装桥接时，从当前 Chrome 中已安装扩展的详情页读取真实扩展 ID：

```sh
node <skill-root>/scripts/run.mjs install-bridge --extension-id <extension-id>
```

每个 Chrome 扩展实例在自己的 `storage.local` 中生成稳定 UUID。桥接为每个实例创建独立私有 endpoint 和 discovery record；Native Messaging host 的 `allowed_origins` 与收到的扩展 `origin` 都按登记的真实扩展 ID 校验。扩展在后台启动及持久 alarm 恢复时自动发现桥接并连接；不要求打开或保留扩展页面，也不使用配对码或临时连接页。桥接安装后需有一次 CLI 与扩展之间真实 status 往返才算连接就绪；这一步不要求元宝已登录。

查看可用连接：

```sh
node <skill-root>/scripts/run.mjs connections
```

结果只列出完成认证且收到扩展真实 status 响应的 active 候选。发现时读取快照，不等待元宝网络。只有一个候选时，本次任务可直接使用它，CLI 不保存选择；多个候选时停止并报告歧义，请用户指定实例。用户确认后可通过 `connect --instance <UUID>` 持久绑定该实例。绑定后实例离线时报告离线，不切换到其他用户；未选择实例时不扫描 profile metadata。profile 只影响 Chrome 启动目标。

开始解析或下载前，读取实例保存的登录 snapshot。快照含 `login`、`checkedAt`（Unix epoch 毫秒或 `null`）及可选错误类别；状态为 `authenticated`、`anonymous`、`failed` 或 `not_checked`。扩展以单一五分钟 heartbeat 更新快照，并在页面打开时强制刷新。查询登录状态或准备新任务时，仅在 snapshot 未知或过期时请求刷新，已有新鲜 snapshot 会复用。扩展响应本身证明桥接往返，不依赖元宝请求成功。明确 `anonymous` 时停止解析/下载并请用户登录；`failed` 表示登录检查失败，不能当作未登录，也不表示桥接连接失败。解析请求收到 `AUTH_EXPIRED` 时，扩展同步将 snapshot 标为匿名。

连接断开后，CLI 先读取 Chrome 是否 `running`、`not_running` 或 `unknown`。`running` 时复用 Chrome 并等待后台恢复；只有明确 `not_running` 时才启动一次 Chrome，不附带 URL。macOS 使用 `open -g` 后台启动；Windows 使用 Chromium `--no-startup-window` 在无窗口状态启动正常 Chrome，让扩展后台运行，不使用 headless 或远程调试。Windows 实机前台焦点行为尚未验证。`unknown` 时报告检测到的错误，不把它当作 Chrome 已关闭。

旧 Native Messaging wire v1 配对的扩展与新版 host 保持给旧 CLI 使用。新版 CLI 遇到 legacy 配置时明确提示升级，不回退到旧握手。新版扩展遇到旧 host 时，用 `install-bridge --extension-id <extension-id>` 更新桥接。同一扩展 ID、Chrome 用户目录与 profile 身份下，已有 IPC protocol 2 私有配置和 secret 在更新时保留；各组件版本按实际握手结果报告。

连接确认后调用：

```sh
node <skill-root>/scripts/run.mjs parse --url <share-link>
node <skill-root>/scripts/run.mjs download --url <share-link> [--filename <relative-mp4-filename>]
```

分享链接必须是 `https://weixin.qq.com/sph/...`。下载默认以视频标题命名；扩展清理非法字符、限制长度，重名时自动改名。`--filename` 仅接受 Chrome 下载目录中的相对 `.mp4` 路径。命令等待 Chrome 报告完成后返回视频信息、各版本媒体链接、最终路径和字节数；中断或超时报错。任务提交后断连或超时不得自动重发，避免重复下载。

回复时嵌入本次结果中的视频，并列出 `mediaVariants` 实际返回的版本链接。已下载时展示最终本地视频和路径；仅解析时展示 `previewUrl`，不为展示擅自下载。没有具体码率时不猜测。不要输出完整 JSON、Cookie、钥匙串凭据、内部 token/eid 或元宝 API 认证 URL。可在本次回复中展示 API 返回的预览和媒体版本链接，包括带签名参数的媒体链接；不要将临时媒体链接写入公共日志。
