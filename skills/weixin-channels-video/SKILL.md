---
name: weixin-channels-video
description: 通过本机 Chrome 插件解析视频号分享链接并下载视频；首次使用时协助安装插件与本地通信桥接。
---

# 视频号解析与下载

使用包内 `scripts/run.mjs` 调用本项目 Chrome 插件。插件复用用户自己的元宝登录态，执行共享解析核心并下载视频；Skill 不操作上游页面、不读取 Cookie 或钥匙串，不依赖 Docker、远程解析服务或 Codex Chrome 插件。

## 先确认 Agent 与本地环境

在运行任何 `node`、`npm`、`npx` 或 `prepare` 命令前，先读 [Agent 安装与本地运行边界](references/agent-installation.md)。确认当前 Agent 的实际产品、命令执行环境、OS、CPU 架构和目标 Chrome 所在机器；云端或远端 Agent 只有在已确认能操作同一台 Chrome 主机时才继续。宿主导入方式、启用步骤和命令权限按该 reference 的对应产品说明处理。

Skill 本身需要 Node.js **22.22.2** 或更高版本；判断依据是本包 `scripts/runtime-support.mjs`。在 Agent 实际运行的环境中核对 Node 版本和绝对路径。兼容版本直接复用。若缺失或过旧，按 reference 从 Node 官方来源取得匹配系统与架构的包并核验 SHA-256；保留旧 Node 与 Shell 配置，不为此修改全局安全策略或提权。宿主或系统阻断安装/命令时，停止被拦截步骤并交接具体原因。

## 首次使用与 Skill 更新

通过宿主官方入口安装完整 Skill 文件夹后，或执行其受支持的 Skill 更新流程后，先运行：

```sh
node <skill-root>/scripts/run.mjs prepare
```

源码 Skill 首次准备时从本项目最新稳定 GitHub Release 下载独立运行资源，校验 `SHA256SUMS` 和资源包运行协议，并将资源缓存到本机工具专属目录；它不直接运行 Skill 目录外的源码模块。第一次直接调用其他 CLI 命令时，如果缓存不存在，也会自动准备并继续执行。显式 `prepare` 会检查最新稳定 Release；普通 CLI 命令只复用兼容缓存，不联网。Release Skill 包已包含运行资源，`prepare` 可离线复用。运行资源协议为 3，与 Native Messaging 协议 1、IPC 协议 2 分开管理。源码 Skill 仅在协议 3 资源正式发布后才能取得该资源。

`prepare` 成功后输出 JSON，其中 `version`、`runtimeProtocol`、`minimumNodeVersion` 和 `runtimeCLI` 分别是资源版本、资源包协议、最低 Node 版本和实际 CLI 路径。扩展不在运行资源包中。协议不兼容、资源缺失、下载失败或校验失败时停止并报告错误；升级失败不会切换当前缓存。准备资源不会改动 Chrome、扩展、桥接注册或配对。运行资源缓存协议 1/2 与现有扩展加载目录均保留，不迁移或删除；更新 Skill 时使用新版 Skill 文件与运行资源，不以旧 runner 调用新版资源。

Skill 更新后执行 `prepare`，再运行 `status` 检查桥接与扩展的 Native Messaging 握手。Skill 更新不安装或更新扩展，也不改动已安装扩展目录；旧版本扩展可能尚无当前 Skill 所需界面或功能。若商店版本缺少功能，说明商店更新可能尚未上线，让用户等待商店，或明确选择单独的 GitHub Release 扩展 ZIP；发版或送审不代表商店已更新。版本分别报告实际 CLI、host 和扩展版本；旧 host 或扩展缺少版本信息时对应字段为 `unknown`，不能据此认定组件已同步。配对身份变化时需重新配对。`pairing-info` 会显式输出配对标识 `sessionId`，仅用于填入扩展的 Agent 设置；它不是 IPC secret，常规日志不输出该标识。

## 检测与恢复连接

需要 Node.js 22.22.2+、Chrome 116+，以及能在目标 Chrome 所在机器运行本地 Node/文件操作的 Agent 会话。Windows、macOS 和 WSL 的调用边界见 [Agent 安装与本地运行边界](references/agent-installation.md)。源码安装或 Skill 更新后按上节执行 `prepare`，然后检查状态：

```sh
node <skill-root>/scripts/run.mjs status
```

结果分开报告配置、连接和登录状态。只有插件已连接时才检查实际元宝登录；未连接不代表未登录，检查失败不代表登录失效。已连接时直接使用，不打开插件页。

未连接、配置无效或通信失败时，先执行只读诊断：

```sh
node <skill-root>/scripts/run.mjs diagnose
```

普通 `diagnose` 返回环境状态、`actions` 和按优先级排列的单项顶层 `nextAction`。先处理这个 `nextAction` 指明的一件事，再重新诊断。`runtime` 来自包内 `runtime.json`，包含 `version`、`runtimeProtocol` 和 `minimumNodeVersion`；缺失或不匹配时字段为 `unknown`。`currentNode.version` 和 `currentNode.absolutePath` 是运行本命令的 Node；`bridge.node` / `bridge.nodeVersion` 则检查注册桥接实际使用的 Node。桥接 Node 状态可能为 `available`、`missing`、`access_failed`、`version_incompatible`、`invalid` 或 `unknown`。

profile 是可选项；`diagnose` 可以读取指定 profile 的记录作为故障诊断，但这不是安装前提或扩展来源验证。只有需要按显示名称选择用户时才运行 `list-profiles`；不枚举整个 profile。也可对已选 profile 与实际扩展 ID 执行候选故障诊断：

```sh
node <skill-root>/scripts/run.mjs list-profiles
node <skill-root>/scripts/run.mjs diagnose --profile <profile-directory-or-name> --extension-id <extension-id>
```

候选诊断只检查 profile metadata 记录，不读取桥接配置、不做实时握手或来源验证，也不替代 `status` 的实时握手。取得用户选定扩展详情页中的实际 ID 后，将它用于 `install-bridge --extension-id <extension-id>`。提示词、商店条目 ID 或历史记录都不能代替该实际 ID；不反复验证扩展来源或扫描整个 profile。

只报告与当前故障有关的已确认事实和应对方式，不把完整 JSON 当作用户指引。普通诊断中的 `unknown` 表示无法确认；`recorded_unknown` 表示已有扩展记录但无法确认启用状态；`missing_or_id_mismatch_possible` 表示记录缺失也可能是 ID 不匹配。诊断、候选 profile 记录或连接超时都不能替代实时握手，也不能单独证明扩展来源或未安装。

- **Chrome 未安装或版本不足**：提供 [Chrome 官方下载入口](https://www.google.com/chrome/) 和安装/更新步骤；获得授权且有桌面工具时协助安装。首次运行、许可确认、系统授权和登录由用户完成。安装位置、版本或启动原因无法确认时说明已知信息，不把启动失败统一说成未安装。
- **Chrome 未运行**：仅在配置了目标 profile 时，`connect` 才会尝试启动该 Chrome 并等待握手；启动不等于扩展已连通。优先使用后台操作，但 Chrome 或操作系统可能将窗口带到前台。无 profile 时 `connect` 只等待手动配对，不启动 Chrome。冷启动若受沙箱阻止，改为用户打开日常 Chrome 并手动配对。
- **profile 未选择或元数据无法读取**：profile 可选。无 profile 时注册桥接不枚举 Chrome 用户数据；让用户打开日常 Chrome，在扩展 Agent 设置中输入 `pairing-info` 输出的 `sessionId`，保存后自动重连。显式指定 profile 时目录名可直接引用；按显示名称查找才需要 Chrome 元数据。读取权限错误时可手动配对，不反复重装或扩大权限。
- **扩展缺失或配对失败**：缺失时默认引导用户安装 Chrome Web Store 版本；只有用户明确选择非商店版时，才从独立 Release ZIP 安装或按源码构建。已安装且握手有效时直接复用。配对时从选定扩展详情页取得实际 ID 一次；实时握手决定连接是否有效。
- **桥接未注册、文件缺失、配置过期或配对不匹配**：依据具体诊断检查桥接注册、host、launcher、Node.js 与配对。已有授权范围内可重新注册本工具的桥接；不覆盖无关文件。配置有效但未连接时执行 `connect`，不先重装。无法确认或恢复失败时给出具体错误类别与下面的手动步骤。
- **通信正常但元宝未登录或登录失效**：请用户在同一 Chrome profile 中登录，再执行 `status`。`LOGIN_CHECK_FAILED` 表示无法可靠检查登录；网络或响应失败不能当作未登录，也不通过重装处理。

按故障阶段报告：资源准备、Chrome 启动、扩展配对、Native Messaging 连接、元宝登录。先解决实际失败的阶段，再检查后续状态；登录检查失败不能改报为认证失效。

恢复只发生在提交任务之前。解析或下载任务发出后若断连、超时，不自动重发；Chrome 下载可能仍在进行，应报告实际状态并引导检查扩展的下载记录。

## 首次安装与手动指引

Chrome 缺失且需要手动安装时，按 [Google 官方安装指引](https://support.google.com/chrome/answer/95346) 选择目标 OS 对应的安装包，完成首次启动后重新诊断。已有 Chrome 的启动问题按实际错误排查；不猜测安装路径，也不因启动失败就重复安装。

确认扩展缺失时，默认从 [README 的 Chrome Web Store 安装入口](https://github.com/MC0571/weixin-channels-video#chrome-扩展) 引导用户安装；只有用户明确选择非商店版时，才提供 GitHub Release 的独立扩展 ZIP（核验同一 Release 的 `SHA256SUMS`）或源码构建。非商店扩展需解压到会持续保留的位置，不能放入 Skill 缓存；Skill 更新不移动或覆盖该目录，路径变化可能改变扩展 ID。扩展与 Skill 独立构建、发布、安装和更新。说明扩展可访问元宝和视频号站点、管理本项目的下载、为固定视频详情请求设置请求头，并通过 `nativeMessaging` 与本地桥接通信；`storage` 保存配对信息，`offscreen` 承接隐藏 iframe 与旧配对迁移，`alarms` 用于后台重连。桥接注册在当前用户的 Chrome NativeMessagingHosts；本地配置和 IPC 通道按目标 OS 限制为当前用户可访问，IPC secret 不进入 Native Messaging 握手消息或日志。Cookie 不交给桥接或 Agent。

授权可来自本次或仍有效的既有委托，对象与权限范围相同时不重复请求。安装商店版时使用 Chrome Web Store 页面；只有用户明确选择非商店版时，才协助从 Release 下载并校验 ZIP、解压到持续保留的目录，再启用开发者模式并加载该目录。复用已经安装且握手有效的扩展，不重复安装或核验来源。

首次配对时，先查看实际扩展版本和页面是否提供 Agent 设置。如果商店版当前没有所需配对界面，不要求用户填写不存在的表单；说明可等待商店更新，或由用户明确选择独立 Release 版后再继续配对。GitHub 发布或送审不代表商店已经更新。

需要按 Chrome 显示名称选择 profile 时，才可选地列出 profile；手动配对不依赖此步骤：

```sh
node <skill-root>/scripts/run.mjs list-profiles
```

使用用户已选定的 profile；有多个且用户未指定时请用户选择，不逐个尝试登录。取得用户选定扩展详情页中的实际 ID 后执行：

```sh
node <skill-root>/scripts/run.mjs install-bridge --extension-id <extension-id>
node <skill-root>/scripts/run.mjs pairing-info
node <skill-root>/scripts/run.mjs connect
node <skill-root>/scripts/run.mjs status
```

将 `pairing-info` 输出的 `sessionId` 输入日常 Chrome 扩展 Agent 设置并保存；页面会自动重连。无 profile 时 `connect` 只等待此手动配对，不启动 Chrome，也不枚举 profile metadata。指定 profile 时才会尝试一次启动所选 Chrome 并等待连接；macOS 直接启动 Chrome 实际程序。桥接注册需要写入当前用户的 Chrome NativeMessagingHosts；若系统拒绝该写入，只说明该路径所需的最小临时文件访问授权。metadata 读取受限时仍可手动配对，不要求完整磁盘访问或关闭沙箱。桥接程序升级或安装时使用的 Node.js 可执行文件位置变化后重新注册桥接。

需要指定 Chrome 用户时，在 `install-bridge` 命令后添加 `--profile <目录名或名称>`；不指定时走手动配对。

安装失败或没有桌面代操作能力时，报告失败步骤与错误类别，并提供对应方式的手动指引。商店安装按 Chrome Web Store 页面完成；仅用户明确选择非商店方式时使用以下步骤：

1. 下载所选版本的独立扩展 ZIP，并核对同一 Release 的 `SHA256SUMS`；或按架构说明构建扩展。
2. 解压或构建到会持续保留的位置；不要放入 Skill 缓存。打开选定 Chrome 用户的 `chrome://extensions`，启用开发者模式并加载扩展目录。
3. 打开扩展详情，取得当前运行扩展的实际 ID；运行 `install-bridge --extension-id <ID>`。仅在需要指定 Chrome 用户时附加 `--profile <目录名>`。
4. 运行 `pairing-info`，在扩展 Agent 设置中输入输出的 `sessionId` 并保存；再运行 `connect` 和 `status`。连接失败时运行 `diagnose`，按错误阶段处理；元宝未登录时在同一 Chrome 用户登录再检查。`status` 的实时握手确认连接，不以商店/Release 来源或 profile 元数据替代。

若系统策略或目录权限阻止安装，明确说明被阻止的步骤。macOS 仅在 NativeMessagingHosts 写入确实被拒绝时，解释该路径所需的最小临时文件访问授权；profile metadata 读取失败可直接手动配对，不要求完整磁盘访问或关闭沙箱。不能通过 Cookie 提取、远程调试或其他入口绕过。

元宝未登录时，请用户在同一 Chrome profile 中登录，再检查状态。扫码、验证码和必须由用户完成的系统确认交给用户；工具允许代操作且已授权的普通安装步骤继续完成。

## 解析与下载

```sh
node <skill-root>/scripts/run.mjs parse --url <share-link>
node <skill-root>/scripts/run.mjs download --url <share-link> [--filename <relative-mp4-filename>]
```

分享链接格式为 `https://weixin.qq.com/sph/...`。下载采用共享核心的默认媒体版本，默认文件名为 `<title>.mp4`：扩展清理标题中的文件名非法字符并限制长度，重名时自动改名。用户没有指定名称时省略 `--filename`，不要另取通用文件名。文件名相对于 Chrome 下载目录，位置选择遵循 Chrome 下载设置。不要把用户的绝对保存路径直接传给 `--filename`；需要另存时，在下载完成后用宿主文件工具移动，并保留已有文件。

下载命令等待 Chrome 确认完成后返回最终路径与字节数。只据此报告保存成功；中断或超时报告错误，不把开始下载当作完成。用户要求可播放验收时，再用可用的播放器或媒体工具检查文件。

下载成功结果同时包含视频信息、`previewUrl` 和 `mediaVariants`，直接使用本次结果组织回复，不为展示链接再次解析或下载。

## 返回视频与下载链接

获取视频链接或完成下载后，在回复中嵌入视频，并列出 `mediaVariants` 中实际返回的各版本下载链接。链接使用返回的 `label`；没有具体码率数值时不猜测，也不把 H.264 / H.265 编码当作高低码率。

已下载时优先嵌入最终 `path` 指向的本地视频，并给出可点击的本地文件路径；仅解析时嵌入 `previewUrl`，不为了展示擅自下载。使用宿主支持的媒体展示方式；Codex 可用 `![视频标题](<绝对视频路径或预览URL>)`，含空格的本地路径用尖括号包裹，文件链接用 `[本地视频](<绝对视频路径>)`。宿主不能嵌入时给出预览链接，不通过另行下载规避显示限制。

回复保留标题、视频嵌入、各版本下载链接，以及下载完成时的最终路径和字节数。不要展开完整 JSON、Cookie、钥匙串凭据或内部 token/eid；临时媒体链接只用于本次预览和下载，不写入公共日志。

插件或桥接不可用时报告缺少的组件，不自行回退到 Cookie 提取或重新实现解析。宿主工具明确拒绝的操作不能通过桥接改道重试。
