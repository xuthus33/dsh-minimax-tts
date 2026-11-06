# dsh-minimax-tts

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的每条助手回复加一个**朗读按钮**，
音色走 MiniMax `speech-2.8-hd` / `female-shaonv`。

只用 MiniMax 一家，是为了**音色一致性**：如果你的 AI 助理在别的渠道（飞书/微信/TG）也用这个音色说话，
接上这个插件后，Web 界面里听起来就是同一个人。

```
浏览器                          宿主                          MiniMax
──────                         ────                          ────────
点「朗读」
  └─▶ POST /luna-tts/speak
      { sessionId, messageId }
                               查会话正文（四级回退）
                               洗掉 Markdown
                               ──────────────────────────▶  t2a_v2
      ◀────── audio/mpeg ─────────────────────────────────┘
播放
```

## 特点

- **零依赖**（`dependencies: {}`），不编译、不下载模型、不跑 pnpm
- **不用 pnpm 安装**（原因见下），手改 `package.json` 两个字段即可
- 正文由宿主按 `messageId` 回查，**客户端不读消息内容**
- Markdown 会洗成适合朗读的纯文本（丢弃代码块、网址、表格线）
- 一条消息只合成一次（内存缓存），重复点击不重复烧配额
- 只服务本机回环，不对局域网开放

## 安装

### 方式 A：从 GitHub 装（推荐，一条命令）

```bash
dsh plugin --profile <profile> add github:xuthus33/dsh-minimax-tts
```

然后**完全退出并重开**界面。

### 方式 B：clone 后手工登记（不跑 pnpm）

在 `@deepseek-ai/*` 被声明成 `file:` 依赖的机器上，pnpm 会把包挪进
`node_modules/.ignored/`，断掉软链桥——那是**启动崩溃循环**，不是小问题。
这种机器请用脚本：

```bash
git clone https://github.com/xuthus33/dsh-minimax-tts.git
cd dsh-minimax-tts

bash scripts/luna-tts-install.sh              # dry-run，先看它要做什么
bash scripts/luna-tts-install.sh --apply      # 真正装
```

### 方式 C：Windows

```powershell
git clone https://github.com/xuthus33/dsh-minimax-tts.git
cd dsh-minimax-tts

.\scripts\luna-tts-install.ps1            # dry-run
.\scripts\luna-tts-install.ps1 -Apply     # 安装
```

详细说明见 [README-WINDOWS.md](README-WINDOWS.md)。

### 配置密钥

三种方式任选（按顺序查找）：

**1. 环境变量** —— 最省事

```bash
export MINIMAX_API_KEY="..."          # macOS/Linux
```
```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "...", "User")   # Windows
```

支持的变量名：`LUNA_TTS_API_KEY` → `MINIMAX_API_KEY` → `MINIMAX_CODE_PLAN_KEY`

**2. 插件配置里指定文件**

```yaml
# cordis.patch.yml 里本插件条目
config:
  apiKeyFile: ~/secrets/minimax.key     # 支持 ~ 展开
```

**3. 默认路径**

`~/.openclaw/workspace/secrets/minimax-code-plan.key`

> 密钥永远不进仓库、不进 JSON 配置、不进日志（日志里 `Bearer xxx` 会被打码）。

## 配置项

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `voice` | `female-shaonv` | MiniMax 音色 ID |
| `model` | `speech-2.8-hd` | 高清模型 |
| `speed` | `0.95` | 语速 0.5–2.0 |
| `vol` / `pitch` | `1` / `0` | 音量 / 音高 |
| `groupId` | `2052661950080360844` | MiniMax GroupId |
| `baseUrl` | `https://api.minimaxi.com` | |
| `apiKeyFile` | `""` | 留空则走环境变量/默认路径 |
| `apiPath` | `/luna-tts/speak` | 合成路由 |
| `healthPath` | `/luna-tts/health` | 健康检查 |
| `maxChars` | `4000` | 单次合成上限，防烧配额 |

## 为什么正文要由宿主回查

`conversation.chat.assistant-actions` 这个槽的 ownerProps **只有 `{ messageId }`**，
不暴露正文——连官方 `dsh-client-ui-message-feedback` 也只拿 id。
所以客户端只负责把 id 发过来，正文由宿主回查，四级回退：

1. `sessionQuery.readSession()` —— 官方推荐，live-preferred
2. `ctx.sessions.get()` —— 活动会话内存快照
3. **磁盘直读会话日志** —— 不依赖任何服务，最经得起服务改版
4. `sessionPersistence.open()` —— 最后兜底

### 一个踩过的坑：会话日志是多帧 zstd

dsh 的会话日志是 append-only，**一次追加就是一帧 zstd**，同一个文件里几十上百帧首尾相接。
Node 的 `zlib.zstdDecompressSync` 只解**第一帧**——实测一个 692KB 的文件只解出 **209 字节**。

所以这里自己实现了按帧头算长度的拆解器（`zstdFrameLength` / `zstdDecompressAll`）：
743KB / 430 帧 → 9ms 解出 2.25MB。

Node < 22.15 没有 zstd 解压能力时会**自动跳过**这条路径（否则逐字节扫描会把大文件拖死），
由前三/后一级回退接管。

## 验证

```bash
curl -s http://127.0.0.1:<端口>/luna-tts/health
# {"ok":true,"plugin":"@luna/dsh-minimax-tts","version":"0.2.0","voice":"female-shaonv", ...}

# 手动合成
curl -s -X POST http://127.0.0.1:<端口>/luna-tts/speak \
  -H 'content-type: application/json' \
  -d '{"text":"This is a test."}' -o test.mp3
```

## 兼容性

| 项 | 说明 |
|:--|:--|
| DSH | 0.2.x（用到 `conversation.chat.assistant-actions`） |
| Node | 18+；22.15+ 才有 zstd 路径（老版本自动降级） |
| 平台 | macOS / Linux / Windows |

**实测环境**：macOS + DSH `0.2.2-rc.1`。Windows 脚本做了静态检查（UTF-8 无 BOM、无 emoji、括号平衡），
但**尚未在 Windows 目标机实机跑过**，第一次请先用 dry-run。

## 卸载

```bash
bash scripts/luna-tts-install.sh --apply --uninstall
```
```powershell
.\scripts\luna-tts-install.ps1 -Apply -Uninstall
```

或手动：把 `@luna/dsh-minimax-tts` 从 profile `package.json` 的 `dependencies` 与
`dsh.profile.bundles` 里删掉，再删 `node_modules/@luna/dsh-minimax-tts`。

## License

MIT

---

由 xuthus 的 AI 助理无果 (Luna) 生成
