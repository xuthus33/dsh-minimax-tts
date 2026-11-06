/**
 * @luna/dsh-minimax-tts — 宿主半（Host half）v0.1
 *
 * 职责：把「一条已完成的助手回复」变成一段语音。
 *
 *   客户端只发 { sessionId, messageId }，正文由宿主从会话日志里取——
 *   因为 conversation.chat.assistant-actions 这个槽只暴露 messageId，
 *   不暴露正文（连官方 dsh-client-ui-message-feedback 也只拿 id）。
 *
 * 设计约束（见 skills/dsh-plugin-standards）：
 *   - apply() 里所有 Promise 都有 catch：任何逃逸 rejection 都会 fail-loud 带崩宿主。
 *   - 长活资源（HTTP 路由）用 ctx.effect 注册，fiber 卸载自动回收。
 *   - 不持有服务引用跨卸载周期；sessionPersistence 走 ctx.get 软探测。
 *   - 不 import 任何 @deepseek-ai/* 裸包，避免 pnpm 挪包导致的解析断桥（死点 4）。
 */

const name = "luna-minimax-tts";
const version = "0.2.0";

/** 硬依赖只有 webServer（必挂）。sessionPersistence 走软探测。 */
const inject = ["webServer"];

const DEFAULTS = {
  apiPath: "/luna-tts/speak",
  healthPath: "/luna-tts/health",
  /** MiniMax 密钥文件（mode 600，不进 JSON、不进 git）。 */
  apiKeyFile: "",
  groupId: "2052661950080360844",
  baseUrl: "https://api.minimaxi.com",
  model: "speech-2.8-hd",
  voice: "female-shaonv",
  speed: 0.95,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  /** 单次合成最大字符数，超出截断（防误发整章小说把配额烧光）。 */
  maxChars: 4000
};

/** 请求体上限，防止超大 body 打爆内存。 */
const MAX_BODY_BYTES = 64 * 1024;

function maskSecrets(text) {
  return String(text).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
}

function logLine(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === "function" ? ctx.logger(name) : undefined;
    if (logger && typeof logger[level] === "function") logger[level](maskSecrets(message));
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function isLoopback(req) {
  try {
    const address = req.socket === undefined || req.socket === null ? undefined : req.socket.remoteAddress;
    if (typeof address !== "string") return false;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  } catch {
    return false;
  }
}

function writeJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* 连接已断 */
    }
  }
}

function writeError(res, status, message) {
  writeJson(res, status, { ok: false, error: message });
}

/** 读 POST body（带上限）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("请求体过大"));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/**
 * 把 Markdown 洗成适合朗读的纯文本。
 * 目标是「别念出星号、反引号和网址」，不是完美排版。
 */
function cleanForSpeech(input) {
  let text = String(input);

  // 围栏代码块整体丢弃（读代码没有意义，还会拖长合成时间）
  text = text.replace(/```[\s\S]*?```/g, " ");
  // 行内代码保留内容、去掉反引号
  text = text.replace(/`([^`]*)`/g, "$1");
  // 图片丢弃、链接只留文字
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 裸网址丢弃
  text = text.replace(/https?:\/\/\S+/g, " ");
  // 标题井号、强调符号、引用符号
  text = text.replace(/^#{1,6}\s*/gm, "");
  text = text.replace(/[*_~]{1,3}/g, "");
  text = text.replace(/^\s*>\s?/gm, "");
  // 表格竖线与分隔线
  text = text.replace(/^\s*\|.*\|\s*$/gm, " ");
  text = text.replace(/^\s*[-:| ]{3,}\s*$/gm, "");
  // HTML 注释与标签
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  // 折叠空白
  text = text.replace(/[ \t\u00a0]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** 从 message.content 里只取文本块（丢弃 reasoning、tool-call 等）。 */
function collectMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

/** 在事件数组里找指定 messageId 的助手正文；找不到返回 null。 */
function matchAssistantText(events, messageId) {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "assistant/message") continue;
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    const message = data.message;
    if (message === null || typeof message !== "object") continue;
    if (message.id !== messageId) continue;
    const text = collectMessageText(message.content);
    // 只有 reasoning / 工具块、没有正文时，视为没找到，让调用方继续回退
    return text.trim().length === 0 ? null : text;
  }
  return null;
}

/** 在已解压的 JSONL 文本里找指定 messageId 的助手正文。 */
function findInJsonl(text, messageId) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.length === 0 || line.indexOf(messageId) === -1) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
    const message = event.data === null || typeof event.data !== "object" ? undefined : event.data.message;
    if (message === null || typeof message !== "object" || message.id !== messageId) continue;
    const collected = collectMessageText(message.content);
    if (collected.trim().length === 0) continue;
    return collected;
  }
  return null;
}

/** zstd 帧魔数（小端读出的 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 算出一个 zstd 帧的总字节长度。
 *
 * ⚠️ 为什么需要这个：dsh 的会话日志是 **append-only**，一次追加就是一帧 zstd，
 * 同一个文件里几十上百帧首尾相接。Node 的 zstdDecompressSync 只解**第一帧**
 * （实测 692KB 的文件只解出 209 字节），所以必须自己按帧头拆开。
 * @returns 帧长度；不是合法帧时返回 -1。
 */
function zstdFrameLength(buf, offset) {
  if (offset + 5 > buf.length) return -1;
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return -1;
  let p = offset + 4;
  const descriptor = buf[p];
  p += 1;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (singleSegment === 0) p += 1; // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];
  p += contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0)
    : contentSizeFlag === 1 ? 2
    : contentSizeFlag === 2 ? 4 : 8;
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 0 || type === 2) p += size;
    else if (type === 1) p += 1;
    else return -1;
    if (last === 1) break;
    if (p > buf.length) return -1;
  }
  if (checksum === 1) p += 4;
  if (p > buf.length) return -1;
  return p - offset;
}

/** 把多帧 zstd 缓冲整体解压成 utf8 文本。 */
function zstdDecompressAll(buf, zlib) {
  // 老 Node（<22.15）没有 zstd 解压能力：直接返回空，让调用方回退到其它路径。
  // 不加这道判断的话，逐字节扫描会让大文件退化成几百万次循环，等于卡死。
  if (zlib === undefined || zlib === null || typeof zlib.zstdDecompressSync !== "function") return "";
  const parts = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) {
      pos += 1;
      continue;
    }
    const length = zstdFrameLength(buf, pos);
    if (length <= 0) {
      pos += 1;
      continue;
    }
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(pos, pos + length)));
      pos += length;
    } catch {
      pos += 1;
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * 兜底：直接扫磁盘上的会话日志。
 * 不依赖任何 cordis 服务，只依赖「会话文件按 session-<id> 命名」这一事实。
 * 优点是完全可离线验证；缺点是会话很大时要解压一次（有大小上限保护）。
 */
async function textFromDisk(sessionId, messageId) {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const zlib = await import("node:zlib");

  const MAX_BYTES = 96 * 1024 * 1024;
  const roots = [
    process.env.DSH_HOME === undefined ? null : nodePath.join(process.env.DSH_HOME, "sessions"),
    nodePath.join(os.homedir(), ".dsh", "sessions"),
    nodePath.join(os.homedir(), ".deepseek-harness", "sessions"),
    // Windows 上 dsh 也可能把数据放在 LOCALAPPDATA 下
    process.env.LOCALAPPDATA === undefined ? null : nodePath.join(process.env.LOCALAPPDATA, "dsh", "sessions"),
    process.env.APPDATA === undefined ? null : nodePath.join(process.env.APPDATA, "dsh", "sessions")
  ].filter((item) => typeof item === "string" && item.length > 0);

  const target = `session-${sessionId}`;
  const FILE_PATTERN = /^session(?:\.v(\d+))?\.jsonl(?:\.zst|\.zstd)?$/;

  for (const root of roots) {
    let slugs;
    try {
      slugs = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const dir = nodePath.join(root, slug.name, target);
      let files;
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      // 先读版本号最大的那份（同目录可能同时留着旧版，全读会重复）
      const candidates = files
        .map((file) => {
          const match = FILE_PATTERN.exec(file);
          if (match === null) return null;
          return { file, v: match[1] === undefined ? 0 : Number(match[1]) };
        })
        .filter((item) => item !== null)
        .sort((a, b) => b.v - a.v);

      for (const candidate of candidates) {
        const full = nodePath.join(dir, candidate.file);
        let text;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_BYTES) continue;
          const raw = await fs.readFile(full);
          text = candidate.file.endsWith(".zstd") || candidate.file.endsWith(".zst")
            ? zstdDecompressAll(raw, zlib)
            : raw.toString("utf8");
        } catch {
          continue;
        }
        const hit = findInJsonl(text, messageId);
        if (hit !== null) return hit;
        // 版本号最大的文件里没有，就不再退到旧版本（内容重叠，查了也白查）
        break;
      }
    }
  }
  return null;
}

/**
 * 按 messageId 取助手回复正文。四级回退，全部走软探测：
 *   1. sessionQuery.readSession()  —— 官方推荐（live-preferred，异步）
 *   2. ctx.sessions.get()          —— 活动会话内存快照
 *   3. 磁盘直读会话日志            —— 不依赖服务，最经得起重启/改版
 *   4. sessionPersistence.open()   —— 最后兜底
 *
 * 注意：单靠 sessionPersistence.open(id) 在这个部署下会 "session not found"
 * （JSONL 后端要按 cwd 算路径，光有 id 定位不到）。
 */
async function textForMessage(ctx, sessionId, messageId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("缺少 sessionId");
  if (typeof messageId !== "string" || messageId.length === 0) throw new Error("缺少 messageId");

  const failures = [];
  let opened = false;

  // 1) sessionQuery（推荐路径）
  const query = ctx.get("sessionQuery");
  if (query !== undefined && query !== null && typeof query.readSession === "function") {
    try {
      const snapshot = await query.readSession(sessionId);
      opened = true;
      const hit = matchAssistantText(snapshot === null || snapshot === undefined ? [] : snapshot.events, messageId);
      if (hit !== null) return hit;
    } catch (error) {
      failures.push(`sessionQuery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2) 活动会话的内存快照
  const store = ctx.get("sessions");
  if (store !== undefined && store !== null && typeof store.get === "function") {
    try {
      const session = store.get(sessionId);
      if (session !== undefined && session !== null) {
        opened = true;
        const events = typeof session.snapshotEvents === "function"
          ? session.snapshotEvents()
          : typeof session.ownEvents === "function" ? session.ownEvents() : [];
        const hit = matchAssistantText(events, messageId);
        if (hit !== null) return hit;
      }
    } catch (error) {
      failures.push(`sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3) 磁盘直读（不依赖服务）
  try {
    const hit = await textFromDisk(sessionId, messageId);
    if (hit !== null) {
      opened = true;
      return hit;
    }
  } catch (error) {
    failures.push(`disk: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4) 持久化日志兜底
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && persistence !== null && typeof persistence.open === "function") {
    let handle;
    try {
      handle = await persistence.open(sessionId, "read");
      opened = true;
      const result = await handle.read();
      const hit = matchAssistantText(result === null || result === undefined ? [] : result.events, messageId);
      if (hit !== null) return hit;
    } catch (error) {
      failures.push(`sessionPersistence: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        if (handle !== undefined && handle !== null && typeof handle.close === "function") await handle.close();
      } catch {
        /* 关闭失败不影响已读到的结果 */
      }
    }
  }

  if (failures.length > 0) logLine(ctx, "warn", `取正文降级: ${failures.join(" | ")}`);
  if (failures.length > 0 && !opened) throw new Error(`取不到会话: ${failures.join(" | ")}`);
  return null;
}

/** 把 `~/xxx`、`~\\xxx` 展开成绝对路径（Windows 上 `~` 不会自动展开）。 */
function expandHome(input, homedir, join) {
  if (typeof input !== "string" || input.length === 0) return "";
  if (input === "~") return homedir;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir, input.slice(2));
  return input;
}

/**
 * 读 MiniMax 密钥。跨平台顺序：
 *   1. 环境变量（Windows 上最省事，不用造目录结构）
 *   2. config.apiKeyFile（支持 `~` 展开）
 *   3. Luna 既有的 secrets 文件（macOS 装机习惯；Windows 上没有就跳过）
 */
async function resolveApiKey(cfg) {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const envNames = ["LUNA_TTS_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CODE_PLAN_KEY"];
  for (const envName of envNames) {
    const value = process.env[envName];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }

  const candidates = [];
  const configured = expandHome(cfg.apiKeyFile, homedir(), join);
  if (configured.length > 0) candidates.push(configured);
  candidates.push(join(homedir(), ".openclaw", "workspace", "secrets", "minimax-code-plan.key"));
  candidates.push(join(homedir(), ".openclaw", "workspace", "secrets", "minimax.key"));

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const key = raw.trim();
      if (key.length > 0) return key;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    "找不到 MiniMax 密钥：请设环境变量 MINIMAX_API_KEY，或在插件 config 里指定 apiKeyFile"
  );
}

/** 调 MiniMax T2A v2，返回 mp3 Buffer。 */
async function synthesize(cfg, text) {
  const key = await resolveApiKey(cfg);
  const url = `${cfg.baseUrl}/v1/t2a_v2?GroupId=${encodeURIComponent(cfg.groupId)}`;
  const body = {
    model: cfg.model,
    text,
    stream: false,
    voice_setting: { voice_id: cfg.voice, speed: cfg.speed, vol: cfg.vol, pitch: cfg.pitch },
    audio_setting: {
      sample_rate: cfg.sampleRate,
      bitrate: cfg.bitrate,
      format: "mp3",
      channel: 1
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`MiniMax HTTP ${response.status} ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const base = payload === null || typeof payload !== "object" ? {} : payload.base_resp || {};
  if (base.status_code !== undefined && base.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${base.status_code}: ${base.status_msg || "未知"}`);
  }
  const hex = payload?.data?.audio;
  if (typeof hex !== "string" || hex.length === 0) throw new Error("MiniMax 未返回音频");
  return Buffer.from(hex, "hex");
}

/** 路由处理：POST { sessionId, messageId } 或 { text }。 */
function createSpeakHandler(ctx, cfg, cache) {
  return (req, res) => {
    const run = async () => {
      if (!isLoopback(req)) {
        writeError(res, 403, "本插件只服务本机回环请求");
        return;
      }
      if (req.method !== "POST") {
        writeError(res, 405, "只支持 POST");
        return;
      }

      let payload;
      try {
        const raw = await readBody(req);
        payload = raw.length === 0 ? {} : JSON.parse(raw);
      } catch (error) {
        writeError(res, 400, `请求体解析失败: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (payload === null || typeof payload !== "object") payload = {};

      // 缓存键：同一条消息只合成一次
      const cacheKey = typeof payload.messageId === "string" && payload.messageId.length > 0
        ? `m:${payload.messageId}`
        : null;
      if (cacheKey !== null) {
        const hit = cache.get(cacheKey);
        if (hit !== undefined) {
          sendAudio(res, hit);
          return;
        }
      }

      let text;
      try {
        if (typeof payload.text === "string" && payload.text.trim().length > 0) {
          text = payload.text;
        } else {
          text = await textForMessage(ctx, payload.sessionId, payload.messageId);
          if (text === null) {
            writeError(res, 404, "没找到这条消息");
            return;
          }
        }
      } catch (error) {
        writeError(res, 500, error instanceof Error ? error.message : String(error));
        return;
      }

      const spoken = cleanForSpeech(text).slice(0, cfg.maxChars);
      if (spoken.length === 0) {
        writeError(res, 400, "这条消息没有可朗读的正文");
        return;
      }

      let audio;
      try {
        audio = await synthesize(cfg, spoken);
      } catch (error) {
        logLine(ctx, "warn", `合成失败: ${error instanceof Error ? error.message : String(error)}`);
        writeError(res, 502, error instanceof Error ? error.message : String(error));
        return;
      }

      if (cacheKey !== null) {
        cache.set(cacheKey, audio);
        if (cache.size > 32) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
      }
      sendAudio(res, audio);
    };

    run().catch((error) => {
      logLine(ctx, "error", `speak 路由异常: ${error instanceof Error ? error.message : String(error)}`);
      try {
        writeError(res, 500, "内部错误");
      } catch {
        /* 响应已发出 */
      }
    });
  };
}

function sendAudio(res, buffer) {
  try {
    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": buffer.length,
      "cache-control": "private, max-age=300"
    });
    res.end(buffer);
  } catch {
    try {
      res.end();
    } catch {
      /* 连接已断 */
    }
  }
}

function apply(ctx, rawConfig) {
  const cfg = Object.assign({}, DEFAULTS, rawConfig !== null && typeof rawConfig === "object" ? rawConfig : {});
  const cache = new Map();

  // 1) 合成路由
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: cfg.apiPath,
    handler: createSpeakHandler(ctx, cfg, cache)
  }));

  // 2) 健康检查
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: cfg.healthPath,
    handler: (req, res) => {
      try {
        if (!isLoopback(req)) {
          writeError(res, 403, "本插件只服务本机回环请求");
          return;
        }
        const persistence = ctx.get("sessionPersistence");
        writeJson(res, 200, {
          ok: true,
          plugin: "@luna/dsh-minimax-tts",
          version,
          apiPath: cfg.apiPath,
          voice: cfg.voice,
          model: cfg.model,
          sessionPersistence: persistence !== undefined && persistence !== null
        });
      } catch {
        writeError(res, 500, "健康检查失败");
      }
    }
  }));

  logLine(ctx, "info", `已装载（音色 ${cfg.voice} / 模型 ${cfg.model}）`);
}

export { apply, cleanForSpeech, collectMessageText, findInJsonl, inject, name, resolveApiKey, textFromDisk, version, zstdDecompressAll, zstdFrameLength };
