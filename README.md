# 视频号解析与下载

把 `https://weixin.qq.com/sph/...` 视频号分享链接粘贴到 Chrome 扩展，预览视频、查看标题与作者，再选择接口提供的视频版本下载。也可以让 AI 通过 Skill 完成同样的操作。

![扩展页面](docs/images/extension.jpg)

## 选择使用方式

| 方式 | 适合谁 | 需要准备什么 |
| --- | --- | --- |
| [Chrome 扩展](#chrome-扩展) | 自己粘贴链接、预览和下载 | Chrome 116+，同一浏览器用户中登录腾讯元宝 |
| [AI Skill](#ai-skill) | 把分享链接交给 AI 下载 | macOS 或 Windows、本地 Node.js 22.22.2+、Chrome 116+ 及一次本地配对 |
| [自部署 API](#自部署-api) | 接入自己的应用或工作流 | Docker 或 Cloudflare，部署者自己的元宝 Cookie |

扩展与 Skill 使用浏览器中的元宝会话。Cookie 留在浏览器；扫码、验证码和登录由你完成。只下载你有权保存和使用的内容。

## Chrome 扩展

默认从 Chrome Web Store 安装。只有你明确选择非商店版本时，才使用 GitHub Release 或源码构建的独立扩展包：

- **商店安装（默认）**：从 [Chrome Web Store](https://chromewebstore.google.com/detail/jdecfnemmnhbpamcfhmgjkcphgomgjoe) 安装。商店版本可能晚于 GitHub Release；以 Chrome 当前安装版本和实际界面为准。
- **非商店安装（需明确选择）**：从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载 `weixin-channels-video-extension-v<版本>.zip`，并按同一 Release 的 `SHA256SUMS` 核验；也可按[构建说明](docs/architecture.md#构建与发布)从源码构建。将 ZIP 解压到会持续保留的位置，再在 `chrome://extensions` 启用开发者模式并加载该目录。不要把扩展放进 Skill 缓存；移动目录可能改变扩展 ID。开发者模式只用于此非商店安装方式。

1. 在安装扩展的 Chrome 用户中登录 [腾讯元宝](https://yuanbao.tencent.com/)。
2. 点击扩展图标，在打开的页面中粘贴分享链接并解析。
3. 预览视频，查看封面、标题、作者和各版本下载链接。
4. 点击所需版本下载。页面会显示完成或中断；关闭页面不会取消 Chrome 已启动的下载。

视频保存位置遵循 Chrome 下载设置，重名时自动改名。H.264、H.265 是编码名称；接口未返回的画质不会生成下载链接。

标题区的“Agent 设置”可打开完整安装提示词。提示词不包含扩展 ID；AI 会安装 Skill，并在配对时使用你当前选定扩展详情页显示的实际 ID。

![Agent 设置](docs/images/agent-settings.jpg)

## AI Skill

本地 Codex CLI/桌面会话可用 Vercel `skills` CLI 安装。先确认 Agent 会话和 Chrome 位于同一台机器，按 [安装与本地运行指引](skills/weixin-channels-video/references/agent-installation.md) 检查 Node.js 22.22.2+，再显式指定目标 Agent：

```sh
npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex
```

该示例将 Skill 安装到 Codex 用户级目录；只有检查目标目录中没有同名 Skill 或本地修改后才运行。已有同名内容时先检查并使用宿主官方更新入口，不用自动确认覆盖。`skills` CLI 对 `codex`、`claude-code`、`trae` 和 `trae-cn` 提供明确目标；WorkBuddy、豆包工作和 QwenWork 使用各自官方的导入入口，不省略 Agent 目标让安装器自行选择。其他产品的目录、启用方式和命令权限见 [六个 Agent 的安装说明](skills/weixin-channels-video/references/agent-installation.md)。

也可以从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载完整 Skill 包，按目标 Agent 的官方方式导入，保留 `SKILL.md`、`scripts/`、`references/` 与包内资源。Codex 用户目录是 `~/.agents/skills/`；其他宿主不要套用该路径。已有同名目录时先检查，保留已有文件与自定义内容。

安装后告诉 AI：

```text
帮我下载这个视频号视频：
https://weixin.qq.com/sph/你的分享链接
```

首次使用，Skill 会准备带校验的运行资源并注册本地桥接。扩展与 Skill 分开安装和更新：扩展缺失时默认引导安装商店版；只有你明确选择非商店版时才使用独立 Release ZIP 或源码构建。已安装且连接有效的扩展直接复用。需要配对时，从选定扩展的详情页取得实际 ID 一次，用于桥接登记和实时握手；实时握手是连接状态依据。按名称选择 Chrome 用户时，profile metadata 查询可作辅助，不要求枚举整个 profile，也不反复验证扩展来源。

需要自己操作时，在安装后的 Skill 目录执行以下命令。先按 reference 确认 OS、实际 Shell/执行环境、Node 与目标 Chrome 在同一台机器；Windows 原生与 WSL 的命令和 Node 路径不可混用：

```sh
node scripts/run.mjs prepare
node scripts/run.mjs install-bridge --extension-id '替换为当前扩展ID'
node scripts/run.mjs pairing-info
node scripts/run.mjs connect
node scripts/run.mjs status
node scripts/run.mjs download --url 'https://weixin.qq.com/sph/你的分享链接'
```

从目标 Chrome 用户中选定扩展的详情页取得实际扩展 ID，再用于 `install-bridge`。提示词本身不提供固定或运行时扩展 ID。

需要指定 Chrome 用户时，在 `install-bridge` 命令后添加 `--profile '目录名或名称'`；不指定时使用手动配对流程。

`prepare` 为从仓库安装的 Skill 获取最新正式 Release，验证 SHA256 和资源包运行协议；普通命令复用本地资源，首次没有资源时自动准备。独立 Skill Release 包自带所需运行资源，可离线准备。运行资源协议为 3，与 Chrome Native Messaging 协议 1 和本地 IPC 协议 2 分开版本管理。首次从源码 Skill 下载资源需要发布了兼容协议资源的正式 Release 和网络连接。

升级 Skill 后先执行 `prepare`，再检查 `status`。首次使用或需要重新配对时运行 `pairing-info`，将 `sessionId` 填入日常 Chrome 扩展的 Agent 设置；保存后自动重连。`connect`、`diagnose` 与 `status` 用于连接及登录状态核实；连接失败时按 `diagnose` 返回的 `nextAction` 处理。profile 可选；不指定时不会枚举 Chrome 用户数据。

下载默认以视频标题命名。`--filename '视频.mp4'` 可指定 Chrome 下载目录内的相对文件名。AI 会在 Chrome 确认完成后展示视频、各版本链接和最终路径。任务超时或断连后不会自动重发，避免重复下载。

扩展“Agent 设置”面板显示实际扩展版本、本地程序的连接阶段和恢复建议。若尚未配对，运行 `pairing-info`，将输出的配对标识填入日常 Chrome 扩展的 Agent 设置；保存后自动重连。配对标识不是 IPC 密钥，常规日志不输出它。商店审核与上线可能有延迟；若商店界面没有 Skill 所需功能，可等待商店更新，或明确选择独立 Release 版本。GitHub 发布或送审不代表商店已更新。登录失效时在同一 Chrome 用户重新登录；网络检查失败不代表未登录。更多恢复步骤见 [Skill 指引](skills/weixin-channels-video/SKILL.md)。

## 自部署 API

Worker 和 Docker 提供同一个 `POST /parse` 接口，返回标题、作者、封面、预览地址和媒体链接，由调用者自行下载。服务使用部署者注入的元宝 Cookie，并以独立的 API 访问凭据保护接口。

### Docker

在仓库根目录创建 `.env`（替换示例值，不提交真实凭据）：

```dotenv
API_TOKEN=替换为随机的服务访问凭据
YUANBAO_COOKIE="替换为部署者自己的元宝Cookie"
```

```sh
chmod 600 .env
docker compose up --build -d
```

服务默认监听 3000。调用者从环境变量提供 API 凭据：

```sh
curl --fail-with-body http://localhost:3000/parse \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://weixin.qq.com/sph/你的分享链接"}'
```

### Cloudflare Worker

先安装仓库依赖，在 `worker/wrangler.toml` 设置自己的 Worker 名称和账号，再通过交互式 Secret 输入配置：

```sh
npm ci
npx wrangler login
npx wrangler secret put API_TOKEN --config worker/wrangler.toml
npx wrangler secret put YUANBAO_COOKIE --config worker/wrangler.toml
npm run worker:deploy
```

输入凭据时关闭终端录制，不把 Cookie 放进命令行参数。对外服务使用 HTTPS。`API_UNAUTHORIZED` 表示 API 凭据无效，`AUTH_EXPIRED` 表示部署者的元宝会话失效。

## 使用条件与隐私

- Chrome 扩展需要有效的腾讯元宝登录；浏览器的第三方 Cookie 策略可能影响会话是否可用。
- Skill 本地桥接运行要求为 Node.js 22.22.2+、Chrome 116+，并需要 Agent 有权在与 Chrome 相同的目标机器运行本地命令。Codex、Claude Code、WorkBuddy、豆包工作、QwenWork 与 TRAE 的本地目录、导入及工具能力不同；豆包工作的公开资料未定义普通用户的本地 Skill 与命令执行契约。详见[安装与本地运行指引](skills/weixin-channels-video/references/agent-installation.md)。
- 分享预览接口和媒体链接有效期由上游决定；临时媒体链接应及时使用。
- 工具按接口返回的地址直接下载，当前没有加入视频解密器。

扩展的权限、数据流和本地桥接说明见 [隐私政策](PRIVACY.md)。解析流程、组件边界、凭据处理、API 契约和构建发布方式见 [架构与维护说明](docs/architecture.md)。

## 参考项目与许可

解析流程参考 [ltaoo/wx_channels_download](https://github.com/ltaoo/wx_channels_download) 的分享链接路线，主要参考其 [Worker 解析实现](https://github.com/ltaoo/wx_channels_download/blob/main/internal/workers/sph/worker.js) 和 [Go 解析实现](https://github.com/ltaoo/wx_channels_download/blob/main/pkg/scraper/wxchannels/yuanbao.go)。

本仓库的许可见 [LICENSE](LICENSE)。参考项目采用 [MIT + Commons Clause](https://github.com/ltaoo/wx_channels_download/blob/main/LICENSE)，包含收费提供基于其功能的产品或服务的限制。若复用其代码，必须保留对应的版权与许可声明；涉及收费产品或服务时，应按其许可取得授权。
