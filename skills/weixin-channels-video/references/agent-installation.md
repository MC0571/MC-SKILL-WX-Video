# Agent 安装与本地运行边界

本页只说明 Agent、Node、操作系统和扩展安装方式的差异。桥接、实例选择、连接恢复和任务调用统一按 [Skill 指引](../SKILL.md) 执行。下表依据截至 **2026-10-10** 查阅的官方资料；宿主入口以用户当前版本显示为准。

## 确认运行环境

运行 Node 命令前，在当前 Agent 的实际执行环境中确认 OS、CPU 架构、Shell、Node 的版本与绝对路径，并确认目标 Chrome 可从该机器访问。Agent 图标、账号名称或本机另一个终端的信息不能证明这些条件。Skill 用户最低版本为 Node.js **22.22.2**；仓库开发工具使用 Node.js 24+。

| Agent | Skill 安装入口 | 本地执行边界 |
| --- | --- | --- |
| Codex | 完整目录可放在用户级 `$HOME/.agents/skills/` 或项目级 `.agents/skills/`；从仓库安装时显式选择 `codex`。[Skills](https://learn.chatgpt.com/docs/build-skills) | Windows 可用原生 PowerShell 或 WSL2；确认当前任务是在本机、WSL 还是远端运行。WSL/云端不自动获得 Windows Chrome 的访问权。[Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [WSL](https://learn.chatgpt.com/docs/windows/wsl) |
| Claude Code | 个人目录 `~/.claude/skills/<name>/` 或项目目录 `.claude/skills/<name>/`；使用官方 Skill 导入入口。[Skills](https://code.claude.com/docs/en/skills) | Windows 可原生 PowerShell 或 WSL。WSL Node 不能注册 Windows Chrome host。个人目录不用于 Cowork 或云端会话。[设置与平台](https://code.claude.com/docs/en/setup) |
| WorkBuddy | 使用本地“技能市场”导入完整 Skill 包并按应用界面启用。[技能市场](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) | 当前权限模式决定本地命令能力。官方资料未定义固定的 ZIP 根目录或安装路径，按当前导入界面处理。[权限模式](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes) |
| 豆包工作 | 仅按其当前官方入口导入。[Skill 接入](https://open.doubao.com/document/doubao-developer-guide/skill-integration-guide) | 公开资料没有定义普通桌面用户的本地 Skill 目录、Node/Shell 执行或本机 Chrome 访问契约；不能据此声称可执行本地连接准备。 |
| 千问办公（QwenWork） | 使用官方 Skill 页面、仓库安装或界面上传 `SKILL.md` 与完整辅助文件。[Skills](https://docs.qwenwork.cn/features/skills) | 桌面可访问本地文件不代表 Skill 脚本有 Node/Shell 执行权限；按当前应用授权结果核实。[桌面端要求](https://docs.qwenwork.cn/getting-started/desktop-workflow) |
| TRAE | 先确认产品线。TRAE CN 可用官方列出的 `.trae/skills/`、全局目录或上传完整 ZIP。[TRAE CN Skills](https://docs.trae.cn/ide_skills) | 不将 TRAE CN 路径套用到国际版或 TraeWork；单文件导入不包含本 Skill 的脚本和运行资源。[系统要求](https://docs.trae.cn/ide_get-started-with-trae) |

Vercel `skills` CLI 支持特定 Agent 键，不代表宿主已经启用 Skill 或授予本地命令权限。仅在确认宿主和目标目录后使用；显式指定单一 Agent 和 Skill，先检查目标目录是否已有同名内容：

```sh
npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex
```

`--yes` 只跳过相应安装器的确认，不授权覆盖已有 Skill。其他宿主使用自己的官方导入入口，不把 Codex 路径或 CLI 参数套用于它们。无论入口为何，都保留 `SKILL.md`、`scripts/`、`references/` 和包内资源。

## Node 与 Windows/WSL

Node 版本事实以包内 `scripts/runtime-support.mjs` 为准。版本已满足时复用现有 Node；缺失或过旧时，从 [Node.js v22.22.2 官方归档](https://nodejs.org/en/download/archive/v22.22.2)选择目标 OS 和 CPU 架构对应的安装包，按官方说明核对 SHA-256；可以时同时验证 [SHASUMS 签名](https://github.com/nodejs/node#verifying-binaries)。保留已有 Node 与 Shell 配置。不要为安装 Skill 修改全局 PATH、执行策略、安全策略或管理员权限。若宿主或组织策略阻止必要操作，报告受阻步骤和错误类别。

Windows Chrome 需要 Windows Node 与 Windows 文件路径。WSL 中的 Node 是 Linux 程序，不能用于注册 Windows Native Messaging host。只有 Windows interop 已启用且策略允许时，才通过受支持的方式调用 Windows `node.exe`；确认实际 `process.platform` 为 `win32`。否则停止并交接，不能用 Linux Node 伪装 Windows host。

在目标 Agent 执行环境检查它是否能读写 Skill 与下载目录、运行本地 Node、取得 GitHub Release，并调用目标 Chrome。权限拒绝或安全策略阻断时交接最短人工步骤，不降低权限或换用其他桥接入口。profile 元数据只用于辅助诊断；出现 `EPERM` 或 `EACCES` 时停止扫描，不扩大权限或搜索整个磁盘。具体连接失败的人工交接步骤见 [Skill 指引](../SKILL.md)。

## Chrome 扩展安装方式

Skill 与 Chrome 扩展分开安装和更新；Skill 包不包含扩展，也不管理扩展。扩展缺失时默认引导安装 Chrome Web Store 版本。只有用户明确选择非商店版时，才使用 GitHub Release 独立 ZIP 或源码构建产物：

1. 从 `extension-v…` GitHub Release 下载扩展 ZIP，并核对该 Release 的 `SHA256SUMS`；或按 [架构与维护说明](../../../docs/architecture.md#构建与发布)从源码构建。
2. 解压或构建到持续保留的位置，不放在 Skill 缓存中。开发者模式仅用于该非商店安装方式。
3. 在目标 Chrome 用户的 `chrome://extensions` 中打开本扩展详情，按 [Skill 指引](../SKILL.md)确认当前扩展 ID 并安装桥接。本页不规定连接或恢复流程；旧桥接配置不能证明目标用户当前安装状态。

Skill 与扩展版本独立，版本不同本身不表示不兼容；以 Skill 的协议检查结果为准。商店审核与上线可能有延迟。GitHub 发布或送审不代表商店已经更新；若商店版缺少所需功能，可等待商店更新，或由用户明确选择非商店版。
