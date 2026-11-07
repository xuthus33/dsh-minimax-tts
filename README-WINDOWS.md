# Luna TTS — Windows 安装说明

给 DeepSeek Harness 的每条助手回复加一个**朗读按钮**，音色固定 MiniMax `female-shaonv`
（与 Luna 在飞书语音里用的完全一致）。

---

## 一、先看这个包是什么

```
dsh-minimax-tts/                 ← 仓库根 = 插件本体（package.json 就在这一层）
├── package.json
├── cordis.patch.yml
├── README.md                    ← 主说明（安装方式 A/B/C）
├── README-WINDOWS.md            ← 本文件
├── lib/
│   ├── index.js                 ← 宿主半：HTTP 路由 + MiniMax 调用 + 会话正文回查
│   └── client.js                ← 浏览器半：回复下方的朗读按钮
└── scripts/
    ├── luna-tts-install.ps1     ← Windows 安装脚本（不跑 pnpm）
    └── luna-tts-install.sh      ← macOS/Linux 等价脚本
```

**零第三方依赖**（`dependencies: {}`），不编译、不下载模型、不跑 pnpm。

---

## 二、前置条件

| 项 | 要求 | 说明 |
|:--|:--|:--|
| DeepSeek Harness | 0.2.x | 用到 `conversation.chat.assistant-actions` 槽 |
| MiniMax 密钥 | 必备 | 见第三节，三种方式任选 |
| 网络 | 能访问 `api.minimaxi.com` | |
| Node | 可选 | dsh 桌面版自带 node；**不需要**加到 PATH（不在 PATH 时安装脚本自动跳过语法校验）|

---

## 三、配密钥（三选一）

**方式 A — 环境变量（最省事）**

```powershell
# 只对当前窗口有效
$env:MINIMAX_API_KEY = "你的key"

# 永久（写用户环境变量，需要重开终端）
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "你的key", "User")
```

支持的变量名，按顺序找：`LUNA_TTS_API_KEY` → `MINIMAX_API_KEY` → `MINIMAX_CODE_PLAN_KEY`

**方式 B — 密钥文件**

放到 `%USERPROFILE%\.openclaw\workspace\secrets\minimax-code-plan.key`（纯文本，只写 key）。
Windows 上记得收紧权限：

```powershell
icacls "$env:USERPROFILE\.openclaw\workspace\secrets\minimax-code-plan.key" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

**方式 C — 在插件配置里指定路径**

在 profile 的 `cordis.patch.yml` 里给本插件条目加 `apiKeyFile: C:/path/to/key.txt`
（也支持 `~/xxx` 写法）。

---

## 四、安装

```powershell
# 1. 克隆（或直接下载 ZIP 解压）
git clone https://github.com/xuthus33/dsh-minimax-tts.git
cd dsh-minimax-tts

# 2. 先看它要做什么（不改任何东西）
.\scripts\luna-tts-install.ps1

# 3. 确认没问题再执行
.\scripts\luna-tts-install.ps1 -Apply
```

如果 dsh 数据不在默认位置：

```powershell
.\luna-tts-install.ps1 -Apply -DshHome "D:\dsh-data" -Profile desktop
```

**执行脚本被系统拦下时**（执行策略）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\luna-tts-install.ps1 -Apply
```

### 脚本做了什么

1. 复制**仓库根目录**到 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@luna\dsh-minimax-tts\`（真目录，不是软链）
2. 在 profile 的 `package.json` 里登记 `dependencies` 和 `dsh.profile.bundles`
3. 改之前先备份成 `package.json.bak-luna-tts-<时间戳>`
4. 校验：node import 宿主半、客户端半语法、JSON 合法性
5. **全程不跑 pnpm**（见第六节）

### 生效

**完全退出 DeepSeek Harness 再重开**（托盘退出，不是关窗口）。

历史会话都在磁盘，重启不会丢。

---

## 五、验证

```powershell
# 健康检查（端口以实际为准，见 GUI 地址）
# 端口取 GUI 地址里的那个（见应用窗口地址栏 / 启动日志）
curl.exe -s http://127.0.0.1:<端口>/luna-tts/health
```

期望返回：

```json
{"ok":true,"plugin":"@luna/dsh-minimax-tts","version":"0.2.0","voice":"female-shaonv", ...}
```

界面验证：随便让助手回一句，回复下方出现「朗读」按钮 → 点一下应出声，再点停止。

手动测合成（不经界面）：

```powershell
curl.exe -s -X POST http://127.0.0.1:<端口>/luna-tts/speak `
  -H "content-type: application/json" `
  -d "{\"text\":\"This is a test.\"}" -o test.mp3
```

---

## 六、为什么不用 `dsh plugin add`

`dsh plugin add` 会走 pnpm。在「`@deepseek-ai/*` 被声明成 `file:` 依赖 + `node_modules` 是软链桥」
的机器上，pnpm 会把这些包挪进 `node_modules/.ignored/`，软链桥一断就是**启动崩溃循环**。

本脚本只手改 `package.json` 的两个字段 + 复制目录，没有任何副作用，且可随时回滚。

---

## 七、卸载 / 回滚

```powershell
.\scripts\luna-tts-install.ps1 -Apply -Uninstall
```

或者手动回滚：把 `package.json.bak-luna-tts-<时间戳>` 覆盖回 `package.json`，再删掉
`node_modules\@luna\dsh-minimax-tts`。

---

## 八、可调参数

在 profile 的 `cordis.patch.yml` 里本插件条目的 `config` 下覆盖（都有默认值）：

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `voice` | `female-shaonv` | **音色一致性的关键，别乱改** |
| `model` | `speech-2.8-hd` | 高清音质 |
| `speed` | `0.95` | 语速 0.5–2.0 |
| `apiKeyFile` | `""` | 留空则走环境变量 / 默认路径 |
| `groupId` | `2052661950080360844` | MiniMax GroupId |
| `maxChars` | `4000` | 单次合成上限，防烧配额 |
| `apiPath` | `/luna-tts/speak` | 改了就同步改客户端 |
| `healthPath` | `/luna-tts/health` | |

---

## 九、已知限制

1. **只服务本机回环**（`127.0.0.1`/`::1`），不对局域网开放。
2. **正文回查有四级回退**：`sessionQuery` → 内存 Session → 磁盘直读 → `sessionPersistence`。
   正常情况下第一级就命中；某级不可用会自动降级，不会报错给用户。
3. **只朗读文本块**，跳过 reasoning 和工具输出（读代码没意义还费配额）。
4. 表格、代码块会被清洗掉或简化，不追求逐字还原。

---

## 十、排错

| 现象 | 先查这个 |
|:--|:--|
| 按钮不出现 | 是否**完全退出重开**了 App；profile 名对不对（desktop / web）|
| 点了没声音 | `curl /luna-tts/health` 通不通；密钥配了没 |
| 报「找不到 MiniMax 密钥」 | 环境变量在本进程可见吗（重开 App 后才会读到新的用户环境变量）|
| 报 `session not found` | 会话还没落盘或 id 过期；换一条更早的回复试 |
| 启动后界面打不开 | 按第七节回滚备份，然后把 `package.json` 和报错发我 |

---

— 由 xuthus 的 AI 助理无果 (Luna) 生成
