# 视频号解析与下载

把 `https://weixin.qq.com/sph/...` 视频号分享链接粘贴到 Chrome 扩展，预览视频、查看标题与作者，再选择接口提供的视频版本下载。也可以让 AI 通过 Skill 完成同样的操作。

![扩展页面](docs/images/extension.jpg)

## 选择使用方式

| 方式 | 适合谁 | 需要准备什么 |
| --- | --- | --- |
| [Chrome 扩展](#chrome-扩展) | 自己粘贴链接、预览和下载 | Chrome 116+，同一浏览器用户中登录腾讯元宝 |
| [Agent Skill](#agent-skill) | 把分享链接交给 AI 下载 | macOS 或 Windows、本地 Node.js 22.22.2+、Chrome 116+ 及本地桥接 |
| [自部署 API](#自部署-api) | 接入自己的应用或工作流 | Docker 或 Cloudflare，部署者自己的元宝 Cookie |

扩展与 Skill 使用浏览器中的元宝会话。Cookie 留在浏览器；扫码、验证码和登录由你完成。只下载你有权保存和使用的内容。

## Chrome 扩展

默认从 Chrome Web Store 安装。只有你明确选择非商店版本时，才使用 GitHub Release 或源码构建的独立扩展包：

- **商店安装（默认）**：从 [Chrome Web Store](https://chromewebstore.google.com/detail/jdecfnemmnhbpamcfhmgjkcphgomgjoe) 安装。商店版本可能晚于 GitHub Release；以 Chrome 当前安装版本和实际界面为准。
- **非商店安装（需明确选择）**：从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载 `weixin-channels-video-extension-v<版本>.zip`，并按同一 Release 的 `SHA256SUMS` 核验；也可按[构建说明](docs/architecture.md#构建与发布)从源码构建。将 ZIP 解压到会持续保留的位置，再在 `chrome://extensions` 启用开发者模式并加载该目录。不要把扩展放进 Skill 缓存；移动目录可能改变扩展 ID。开发者模式只用于此非商店安装方式。

安装后，在同一 Chrome 用户中登录腾讯元宝，即可粘贴分享链接、预览视频并下载。分享链接草稿保存在当前用户的扩展本地存储中，清空输入框即可清除。有新版时，页面版本号替换为动态 `NEW` 图标，扩展图标显示 `NEW` 角标；商店版点击页面 `NEW` 进入插件详情页，ZIP 版直接下载安装包并打开扩展管理页。详细操作、下载记录、更新提示和 Agent 设置见[扩展使用说明](docs/extension.md)。

## Agent Skill

先按[安装与本地运行指引](skills/weixin-channels-video/references/agent-installation.md)确认 Agent 的运行环境与安装入口。Skill 用户需要 Node.js 22.22.2+、Chrome 116+，并能在目标 Chrome 所在机器运行本地命令。Codex 可通过 Vercel `skills` CLI 安装完整 Skill：

```sh
npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex
```

先检查目标目录没有同名 Skill 或本地修改；已有内容时使用宿主官方更新入口，不自动覆盖。其他 Agent 按 reference 中对应的官方导入方式安装完整文件夹与资源。

也可以从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载 `skill-v…` 完整 Skill 包，再按目标 Agent 的官方方式导入。Skill 包包含 `SKILL.md`、`scripts/`、`references/` 和运行资源，不包含 Chrome 扩展。非商店扩展包使用独立的 `extension-v…` Release；Skill 与扩展版本分别维护，版本不同本身不代表不兼容，运行时按协议检查兼容性。

安装后可直接把分享链接交给 Agent：

```text
帮我下载这个视频号视频：
https://weixin.qq.com/sph/你的分享链接
```

在目标 Chrome 用户中打开扩展的“Agent 设置”，复制提示词交给 Agent。提示词包含该扩展实例的身份和复制时的状态；Agent 会按该身份验证真实连接，再确认元宝登录。桥接连接就绪不要求先登录元宝、解析或下载；扩展在后台自动发现桥接，无需保留扩展页面。

连接、首次桥接登记、旧提示词兼容和故障修复统一按 [Skill 指引](skills/weixin-channels-video/SKILL.md#连接与登录状态)执行。Agent 只在有诊断证据和既有授权时进行一次必要修复，再验证原实例；离线时不会切换 Chrome 用户，失败或超时也不会自动重发下载。扩展缺失时默认安装 Chrome Web Store 版本，非商店版需要明确选择。

下载默认采用清理后的短标题和浏览器本地日期（`短标题_YYYYMMDD.mp4`），也可指定相对 `.mp4` 文件名；重名由 Chrome 自动追加后缀。只有 Chrome 确认完成后才报告下载成功。

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
