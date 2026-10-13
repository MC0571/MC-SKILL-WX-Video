# 视频号解析与下载

把 `https://weixin.qq.com/sph/...` 视频号分享链接粘贴到 Chrome 扩展，预览视频、查看标题与作者，再选择接口提供的视频版本下载。也可以让 AI 通过 Skill 完成同样的操作。

![扩展页面](docs/images/extension.jpg)

## 选择使用方式

| 方式 | 适合谁 | 需要准备什么 |
| --- | --- | --- |
| [Chrome 扩展](#chrome-扩展) | 自己粘贴链接、预览和下载 | Chrome 116+，同一浏览器用户中登录腾讯元宝 |
| [AI Skill](#ai-skill) | 把分享链接交给 AI 下载 | macOS 或 Windows、本地 Node.js 22.22.2+、Chrome 116+ 及本地桥接 |
| [自部署 API](#自部署-api) | 接入自己的应用或工作流 | Docker 或 Cloudflare，部署者自己的元宝 Cookie |

扩展与 Skill 使用浏览器中的元宝会话。Cookie 留在浏览器；扫码、验证码和登录由你完成。只下载你有权保存和使用的内容。

## Chrome 扩展

默认从 Chrome Web Store 安装。只有你明确选择非商店版本时，才使用 GitHub Release 或源码构建的独立扩展包：

- **商店安装（默认）**：从 [Chrome Web Store](https://chromewebstore.google.com/detail/jdecfnemmnhbpamcfhmgjkcphgomgjoe) 安装。商店版本可能晚于 GitHub Release；以 Chrome 当前安装版本和实际界面为准。
- **非商店安装（需明确选择）**：从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载 `weixin-channels-video-extension-v<版本>.zip`，并按同一 Release 的 `SHA256SUMS` 核验；也可按[构建说明](docs/architecture.md#构建与发布)从源码构建。将 ZIP 解压到会持续保留的位置，再在 `chrome://extensions` 启用开发者模式并加载该目录。不要把扩展放进 Skill 缓存；移动目录可能改变扩展 ID。开发者模式只用于此非商店安装方式。

商店安装版在 Chrome 确认更新已下载后显示提示；选择立即更新时，会等当前任务和扩展下载结束再安全应用。非商店版低频检查公开的稳定 `extension-v…` Release，有更新时只提醒手动更新；检查结果未知时不会称为最新版。GitHub 发布或提交商店审核不代表 Chrome Web Store 已发布该版本，商店版以 Chrome 实际提供的更新为准。

1. 在安装扩展的 Chrome 用户中登录 [腾讯元宝](https://yuanbao.tencent.com/)。
2. 点击扩展图标，在打开的页面中粘贴分享链接并解析。
3. 预览视频，查看封面、标题、作者和各版本下载链接。
4. 点击所需版本下载。页面会显示完成或中断；关闭页面不会取消 Chrome 已启动的下载。

扩展页还会列出最近 5 条本扩展下载，并可按本地日期查看完整记录、定位仍存在的文件；Chrome 中已清除的记录也会从列表移除。未点击过仓库链接时显示“Star 一下”，每次打开页面播放一次 3 秒星标动画；点击后记住选择，显示“Github”，不检测实际 Star。首次成功解析后，会显示可关闭的一次性商店评价提示，不区分安装来源。页面底部提供隐私政策与飞书问题和建议表单入口，表单需由用户自行填写和提交。

视频保存位置遵循 Chrome 下载设置。默认文件名是清理后的短标题和浏览器本地日期（`短标题_YYYYMMDD.mp4`）；显式相对 `.mp4` 文件名按原路径传给 Chrome，重名时由 Chrome 自动追加后缀。H.264、H.265 是编码名称；接口未返回的画质不会生成下载链接。

标题区的“Agent 设置”会展示 ChatGPT、Claude Code 与 WorkBuddy 图标及连接状态灯：已连接为绿灯，连接失败或断开为闪烁红灯，正在连接为橙灯，尚未确认为灰灯；减少动态效果时红灯不闪烁。它可打开完整安装提示词，其中会自动填入当前 Chrome 用户的实际扩展 ID 和稳定实例 UUID。把提示词交给目标 Agent 即表示选定这个 Chrome 用户；AI 会按 Skill 指引检查或修复桥接并连接该实例，不需要手动查找或复制 ID。元宝已登录时收起登录提示，未登录或检查失败时仍显示对应状态。

![Agent 设置](docs/images/agent-settings.jpg)

## AI Skill

先按[安装与本地运行指引](skills/weixin-channels-video/references/agent-installation.md)确认 Agent 的运行环境与安装入口。Skill 用户需要 Node.js 22.22.2+、Chrome 116+，并能在目标 Chrome 所在机器运行本地命令。Codex 可通过 Vercel `skills` CLI 安装完整 Skill：

```sh
npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex
```

先检查目标目录没有同名 Skill 或本地修改；已有内容时使用宿主官方更新入口，不自动覆盖。其他 Agent 按 reference 中对应的官方导入方式安装完整文件夹与资源。

也可以从 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 下载 `skill-v…` 完整 Skill 包，再按目标 Agent 的官方方式导入。Skill 包包含 `SKILL.md`、`scripts/`、`references/` 和运行资源，不包含 Chrome 扩展。非商店扩展包使用独立的 `extension-v…` Release；Skill 与扩展版本分别维护，版本不同本身不代表不兼容，运行时按协议检查兼容性。

安装后可直接把分享链接交给 AI：

```text
帮我下载这个视频号视频：
https://weixin.qq.com/sph/你的分享链接
```

如果收到的是旧提示词且没有扩展 ID 或实例 UUID，先在目标 Chrome 用户的“Agent 设置”中重新复制。无法重新复制旧提示词时，才手动打开该用户的 `chrome://extensions`，找到本扩展并打开“详情”，复制当前扩展 ID；旧桥接配置不能证明当前安装的 ID。在安装后的 Skill 目录先检查并连接：

```sh
node scripts/run.mjs prepare
node scripts/run.mjs connect --extension-id '粘贴同一扩展 ID'
```

只有 `connect` 明确报告 `BRIDGE_NOT_CONFIGURED` 或 `BRIDGE_EXTENSION_MISMATCH` 时，才用该 Chrome 用户的实际 ID 更新桥接，然后重试 `connect`：

```sh
node scripts/run.mjs install-bridge --extension-id '粘贴当前扩展 ID'
node scripts/run.mjs connect --extension-id '粘贴同一扩展 ID'
```

连接成功后再查看状态或下载：

```sh
node scripts/run.mjs status
node scripts/run.mjs download --url 'https://weixin.qq.com/sph/你的分享链接'
```

扩展与 Skill 独立安装和更新。扩展缺失时默认引导安装 Chrome Web Store 版本；只有你明确选择非商店版时，才使用独立 Release ZIP 或源码构建产物。安装 Skill 和桥接后，通过 `connect` 确认一次与扩展的真实往返即可完成准备；不要求先登录元宝、解析或下载。Chrome 扩展在后台自动发现桥接并恢复连接；不需要打开或保留扩展页面。常规连接不需要读取 Chrome profile 元数据。若用户明确选择 profile，可在登记桥接时提供 `--profile`；CLI 只会在 Chrome 明确未运行且该 profile 已确认时后台启动一次，状态未知或 profile 未确认时请手动打开所选 Chrome 用户。完整连接及失败处理按 [Skill 指引](skills/weixin-channels-video/SKILL.md)执行。

`connections` 仅列出已认证且实际响应 status 的在线扩展实例。多个候选时，按用户选择通过 `connect --instance <UUID>` 指定；绑定实例离线时不会自动切换到另一 Chrome 用户。下载默认使用清理后的短标题和浏览器本地日期（`短标题_YYYYMMDD.mp4`），显式相对 `.mp4` 文件名按原路径传递，重名时由 Chrome 自动追加后缀；命令等待 Chrome 确认完成后才报告成功。任务提交后断连或超时不会自动重发。登录状态报告和失败时的下一步见 [Skill 指引](skills/weixin-channels-video/SKILL.md)。

连接失败时按 Skill 指引处理，不要循环等待或反复重启、重装。

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
