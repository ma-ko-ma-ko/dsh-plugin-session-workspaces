---
description: "Per-session output folders for DeepSeek Harness: every file a session writes lands in one folder inside the workspace, named after the session title."
kind: "plugin"
---

# dsh-plugin-session-workspaces

同一个工作区里可以同时开着好几个会话。默认情况下它们都往工作区根目录写文件，于是产物互相穿插、互相覆盖。这个插件让每个会话在工作区里拥有**一个自己的文件夹**，文件夹名就是会话标题，并把该会话的所有写入重定向进去。

```
工作区/
├── 2026年山东卷物理高考真题.docx      ← 已有产物，照旧可读
├── 鲸鱼答卷_山东物理.md               ← 已有产物，照旧可读
├── 山东卷解析/                        ← 本次会话的文件夹（会话标题）
│   ├── .dsh-session.json              ← 归属标记：会话 id + 标题 + 创建时间
│   ├── 解析正文.md
│   └── assets/figure1.png
└── 试卷批改/                          ← 另一个会话的文件夹
    └── 批改结果.md
```

## 它做了什么

重定向安装在 `ctx.fs.resolve` 上——也就是所有文件工具解析路径的唯一入口：

| 行为 | 结果 |
| --- | --- |
| `write` / `edit` 的相对路径 | 落到会话文件夹 |
| `write` / `edit` 的工作区内绝对路径 | 也落到会话文件夹（`F:\dsh测试\a.md` → `F:\dsh测试\<标题>\a.md`） |
| `read` / `read_image` / `present` 的相对路径 | 会话文件夹里有就读它；没有则回退到工作区根目录 |
| 工作区之外的路径（系统临时目录、别处工程） | 原样不动 |
| `pwsh` / `bash` 未显式指定 `workdir` 时 | 该命令在会话文件夹里运行 |

`read` 的回退是刻意的：没有它，会话读不到任何**早先会话留下的产物**；有了它，`read` 观察到的文件与 `edit` 要改的文件是同一个，`dsh-fs-observation-policy` 的"先读后写"记账保持一致。

### 文件夹命名

名字来自 `ctx.sessionTitle`：

- 标题确定后，用标题生成文件夹名（`山东卷解析`）。
- 标题还没生成时，用 `session-<会话 id 后 8 位>` 占位；标题一到就改名（只在这一个时刻改名，避免产物写完后被搬走）。
- 名称经过跨平台净化：去掉 `< > : " / \ | ? *` 与控制字符，去掉结尾的点和空格，避开 Windows 保留设备名（`con`、`lpt1`…），并按字节预算截断（默认 64 字节，不会截断半个字符）。
- 同名冲突追加序号：`报告`、`报告 (2)`、`报告 (3)`。
- 一个会话一旦定名就不再改，模型之后重写标题也不会搬走已有产物。
- 子代理 / fork 的子会话与它的父会话**共用**同一个文件夹。

分配表是持久的（默认 `$DSH_HOME/session-workspaces.json`），所以明天恢复同一个会话，它还会写回昨天那个文件夹。

### 模型侧

插件在运行时上下文中加一条（顺序 `111`，紧跟在沙箱策略之后）告诉模型：本次会话的产物文件夹是哪个、相对路径优先落在那里、工作区根目录仍然可读但不要往里写。

## 安装

**方式一：装进 profile（推荐）**

```powershell
# 1. 放进 profile 的 node_modules
New-Item -ItemType Junction `
  -Path   "$env:DSH_HOME\profiles\desktop\node_modules\dsh-plugin-session-workspaces" `
  -Target "<这个目录的绝对路径>"

# 2. 在 $DSH_HOME\profiles\desktop\cordis.patch.yml 末尾加上
#    （见 cordis.patch.yml）
```

**方式二：按绝对路径挂载**（不想动 node_modules 时）

```yaml
- insert:
    - id: session-workspaces
      name: 'F:\dsh测试\dsh-plugin-session-workspaces\lib\index.js'
```

profile 只在启动时合成，改完 patch 需要重启 DSH（或让 `dsh-hmr` 覆盖到这一层）。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `file` | `$DSH_HOME/session-workspaces.json` | 分配表；相对路径落在 profile 目录旁 |
| `maxNameBytes` | `64` | 单个文件夹名的 UTF-8 字节预算 |
| `readFallback` | `true` | 关掉后，读取也强制落在会话文件夹（读不到工作区根目录的旧文件） |
| `shellWorkdir` | `true` | 关掉后不改 shell 的默认工作目录 |
| `prompt` | `true` | 关掉后不向模型注入运行时上下文 |
| `promptOrder` | `111` | 该上下文的排序位置 |

## 边界（重要）

- **shell 命令里的绝对路径不重写。** 只有"未显式给 `workdir`"这种明确是默认值的情况才会被改到会话文件夹；命令里写死的绝对路径（`Out-File C:\x.txt`）照旧。文本层面重写命令太脆弱，所以没做。相对路径（`python build.py`、`Set-Content out.txt`、`--outdir result`）天然落在会话文件夹里。
- **显式给出的工作区子目录不重写。** `workdir: <工作区>\project` 是模型明确点的位置，保持原样。
- **模型自己拼出的绝对路径**如果指向工作区之外，那是有意为之，插件不动它（沙箱仍按 `workspace-write` 拦）。
- **`str_replace_editor` 已纳入重定向**，但桌面组合默认不挂载该工具。
- **插件改写的是共享的 `ctx.fs.resolve` 方法**。没有直接注册会话的调用方（网页文件浏览器、host 路由）不受影响，但这是"打补丁"而不是换服务——DSH 没有为 `ctx.fs` 提供按会话包装的扩展点。
- **模型不能用相对路径去改工作区根目录里的旧文件。** `edit old.md` 会落在会话文件夹（那里没有该文件，于是报"先读一下"或"找不到"），`edit <工作区>\old.md` 也会被搬进会话文件夹，结果是在会话文件夹里新建一份。要就地修改根目录的历史文件，只能在关掉这个插件（`enabled: false`）的会话里做。

## 开发

```powershell
npm test                       # 62 个单元测试，不需要 harness 运行时
npm run test:profile           # 端到端：真 profile 引导 + 真工具执行
```

`npm run test:profile` 需要一个 harness 安装锚点（`dsh/package.json` 的 file URL）：

```powershell
$env:DSH_HARNESS_ANCHOR='file:///C:/Users/<你>/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/package.json'
npm run test:profile
```

它在临时目录里合成一个一次性 profile，用自己的 `.e2e-workspace/` 当工作区，跑完即清理（`DSH_SW_KEEP=1` 可保留现场）。脚本会检查：写入落到会话文件夹、工作区根目录保持干净、绝对路径写入被搬走、读取回退到根目录、编辑跟随同一路径、工作区外路径不动、运行时上下文点名文件夹。

### 在这台机器上已知的环境问题

同一套端到端检查里，`edit` 与 `pwsh` 在本机会报 Windows 权限错误：

```
edit: Error: SetFileSecurityW EACCES (Win32 5): ...\notes\.probe.md.<pid>.<uuid>.tmpdir\probe.md.tmp
pwsh: Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区>)
```

**与本插件无关**：把 `enabled: false` 关掉插件、让文件直接写在原来位置，这两个错误一模一样地复现。是这台机器上 Windows ACL 沙箱无法为新路径补授权的问题，脚本遇到时会打 `ENV` 标记而不是判失败。需要的修复手段见随包技能 `diagnose-windows-sandbox-acl`。

## 模块

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：挂载解析器、安装两个重定向、注册工具钩子与运行时上下文 |
| `lib/config.js` | 手写配置校验（含 Standard Schema 的 `~standard`，供 Cordis 调用） |
| `lib/naming.js` | 标题 → 跨平台合法文件夹名 |
| `lib/registry.js` | 持久分配表：会话 id → 每个工作区的文件夹名，含改名与防重名 |
| `lib/session-paths.js` | 每次调用解析"这个会话的文件夹在哪"，带标题变更失效的缓存 |
| `lib/paths.js` | 路径分类与改写（工作区内 / 文件夹内 / 工作区外） |
| `lib/fs-facade.js` | 在 `ctx.fs.resolve` 上安装读/写重定向 |
| `lib/shell-facade.js` | 在 `ctx.shell.resolve` 上安装默认工作目录重定向 |
