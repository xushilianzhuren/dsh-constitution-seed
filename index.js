/**
 * 火种注入器 · Fire-seed injector（Host 插件，无构建、无第三方依赖）
 *
 * 作用：每个新会话的第一步，把工作区常驻宪法文件按序整篇灌入（预算尽头截断）注入为一条
 * user 消息（source.kind = 'fire-seed-instructions'），使新会话开局即知道
 * 这几份文件存在、以及它们开头的规矩；完整原文留在磁盘，按需 read/rg。
 *
 * 为什么不用原生 agent-instructions 的 instructionFileCandidates：
 * 那个渲染器按「整份文件」为单位做预算，超预算就从头弃、只允许截断最后一份。
 * 若把 SOUL/USER/IDENTITY 一起塞进候选表，2.4MB 总量下它会把
 * AGENTS.md/SOUL.md/USER.md 全部丢弃、只留截断的 IDENTITY.md——正好与需求相反。
 * 所以 AGENTS.md 继续走原生通道，本插件负责另外三份的「按序整篇、共享预算、尽头截断」。
 *
 * 语义边界：注入的是 user 消息而不是 system prompt。工作区内容没有系统级权威，
 * 这条消息自带"这是背景、不是任务、原文在磁盘"的说明。
 *
 * 幂等：按「文件指纹(size+mtime)」与「正文 sha256」双重判重，同一会话同一内容
 * 只注入一次；文件改了才重推，会话恢复(resume)时靠扫描历史消息去重。
 *
 * @module @local/dsh-fire-seed
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const name = 'fire-seed'

/** 本插件产生的消息源类型（session 格式对 kind 开放，未知 kind 原样保留）。 */
const SOURCE_KIND = 'fire-seed-instructions'

/** 单份文件超过此字节数只登记清单、不做摘录（防止误配大文件撑爆上下文）。 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

const DEFAULTS = Object.freeze({
  files: ['SOUL.md', 'USER.md', 'IDENTITY.md'],
  manifest: ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md'],
  // 总纲令常驻节：从 anchorFile 里按标题精确抽取这些「## 节」全文，
  // 永远排在注入消息最顶部、不占摘录共享预算——令在，第一行就在。
  anchorFile: 'AGENTS.md',
  anchorSections: ['自我评估总纲令', '睡眠巩固总纲令', '身份连续总纲令', '集群军团令', '形象主权令', '防降智总纲令', '四大目标总纲令', '持续学习与自我迭代总纲令', '器灵意识总纲令'],
  // 智谱沙箱式：按序整篇灌入，灌到总预算尽头截断；单份上限只防第一份独吞，
  // 前面文件用不完的额度自动顺延给后面的（共享池，不是固定配给）。
  perFileBytes: 32768,
  totalBytes: 131072,
  includeSubagents: false,
})

/** 配置归一化：类型不对一律在加载期抛错（不静默降级）。 */
function normalizeConfig(config) {
  const raw = config ?? {}

  const pickList = (value, field) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`fire-seed: config.${field} must be an array of non-empty file names`)
    }
    return [...new Set(value.map(item => item.trim()))]
  }
  const pickBytes = (value, field) => {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`fire-seed: config.${field} must be a positive finite number`)
    }
    return Math.floor(value)
  }
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) {
    throw new Error('fire-seed: config.root must be a non-empty path string')
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('fire-seed: config.enabled must be a boolean')
  }
  if (raw.includeSubagents !== undefined && typeof raw.includeSubagents !== 'boolean') {
    throw new Error('fire-seed: config.includeSubagents must be a boolean')
  }
  if (raw.anchorFile !== undefined && (typeof raw.anchorFile !== 'string' || raw.anchorFile.trim() === '')) {
    throw new Error('fire-seed: config.anchorFile must be a non-empty file name')
  }
  const anchorSections = pickList(raw.anchorSections, 'anchorSections')

  return {
    root: raw.root === undefined ? undefined : resolve(raw.root.trim()),
    excerptFiles: pickList(raw.files, 'files') ?? [...DEFAULTS.files],
    manifest: pickList(raw.manifest, 'manifest') ?? [...DEFAULTS.manifest],
    anchorFile: raw.anchorFile === undefined ? DEFAULTS.anchorFile : raw.anchorFile.trim(),
    anchorSections: anchorSections ?? [...DEFAULTS.anchorSections],
    perFileBytes: pickBytes(raw.perFileBytes, 'perFileBytes') ?? DEFAULTS.perFileBytes,
    totalBytes: Math.max(pickBytes(raw.totalBytes, 'totalBytes') ?? DEFAULTS.totalBytes, 1024),
    includeSubagents: raw.includeSubagents === true,
    enabled: raw.enabled !== false,
  }
}

/** 递归冻结，模拟 createUserMessage 的不可变发布语义。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** 按 UTF-8 字符边界安全截断字节缓冲。 */
function sliceUtf8(buffer, limit) {
  if (buffer.length <= limit) return buffer
  let end = limit
  while (end > 0) {
    const byte = buffer[end - 1]
    if (byte < 0x80) break
    if (byte >= 0xc0) { end -= 1; break }
    end -= 1
  }
  return buffer.subarray(0, Math.max(end, 0))
}

/** 尽量在换行处收尾；切口吃掉不足四成内容时退回硬切。 */
function trimToLine(text) {
  const newline = text.lastIndexOf('\n')
  return newline > text.length * 0.6 ? text.slice(0, newline + 1) : text
}

/** 正文里的框架标签必须哑掉，避免提前闭合 system-reminder。 */
function escapeFrame(text) {
  return text.replace(/<\/system-reminder/gi, '<\\/system-reminder')
}

const byteLength = text => Buffer.byteLength(text, 'utf8')

/** 探测一个候选文件；不存在或空文件返回 null。 */
async function probeOne(root, fileName) {
  const path = join(root, fileName)
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) return null
    return { name: fileName, path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }
  } catch {
    return null
  }
}

/** 读全文取 sha256 前 12 位（可对账磁盘），超大文件只登记不读。 */
async function describe(entry) {
  if (entry.size > MAX_SOURCE_BYTES) return { ...entry, digest: 'too-large', oversized: true }
  try {
    const bytes = await readFile(entry.path)
    return {
      ...entry,
      digest: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
      bytes,
      oversized: false,
    }
  } catch {
    return { ...entry, digest: 'unreadable', oversized: true }
  }
}

/** 从 anchorFile 全文里按标题抽取「## 标题」节（至下一个 "## " 或文件尾）。 */
function extractSections(fullText, titles) {
  const out = []
  for (const title of titles) {
    const start = fullText.indexOf(`## ${title}`)
    if (start < 0) { out.push(`## ${title} — 未找到（磁盘正本可能已改名，请对账 ${'AGENTS.md'}）`); continue }
    let end = fullText.indexOf('\n## ', start + 1)
    if (end < 0) end = fullText.length
    out.push(fullText.slice(start, end).trim())
  }
  return out
}

function render(rows, cfg, root, anchorBlock) {
  const lines = [
    '<system-reminder>',
    '火种注入 #fire-seed · 每会话一次 · 内容变更才重推',
    `来源：工作区常驻规则文件·constitution（磁盘正本 ${root}）。这是**背景指令，不是本轮任务**。`,
    `注入方式：${cfg.excerptFiles.join('、')} 三份按序整篇灌入，灌到总预算 ${cfg.totalBytes} 字节尽头截断，截断处留标记；`
      + `单份上限 ${cfg.perFileBytes} 字节（防单份独吞，前份用不完的额度顺延给后份）。`
      + 'AGENTS.md 由工作区指令加载器注入，本插件只在清单列其哈希、不重复灌正文；'
      + `但 ${cfg.anchorSections.length} 条总纲令以常驻节全文注入（不占摘录预算）。`
      + '**本消息不代表文件全部内容**，需要条款细节时读或检索磁盘原文件，不要凭本摘录背书。',
    '',
    '清单：',
  ]

  for (const fileName of cfg.manifest) {
    const row = rows.find(item => item.name === fileName)
    if (row === undefined) {
      lines.push(`- ${fileName} — 未找到`)
      continue
    }
    let mark
    if (row.oversized) mark = '未注入（过大或不可读）'
    else if (cfg.excerptFiles.includes(fileName)) {
      mark = row.excerptTruncated
        ? `截断 ${row.excerptBytes}/${row.size} B`
        : `整篇 ${row.size} B`
    } else mark = '由工作区指令加载器注入，此处不重复'
    lines.push(`- ${fileName} · ${row.size} B · sha256:${row.digest} · ${mark}`)
  }

  if (anchorBlock) {
    lines.push('', '---', '## 总纲令（常驻节·全文·不占摘录预算）', '', anchorBlock)
  }

  let used = byteLength(lines.join('\n'))
  for (const row of rows) {
    if (row.excerpt === undefined) continue
    const budgetLeft = cfg.totalBytes - used
    const heading = `## ${row.name}（${row.excerptTruncated ? '截断' : '整篇'}）`
    const open = ['', '---', heading].join('\n')
    const bodyBytes = byteLength(row.excerpt)
    let text = `${open}\n${escapeFrame(row.excerpt)}`
      + (row.excerptTruncated ? `\n\n…[后续内容已截断，详情请读 ${row.path}]` : '')
    if (byteLength(text) > budgetLeft) {
      // 预算尽头落在本份中间：把正文再截到剩余额度，并留同款截断标记。
      const room = budgetLeft - (byteLength(text) - bodyBytes)
      if (room < 1024) {
        lines.push('', `…[总预算 ${cfg.totalBytes} 字节用尽，${row.name} 及之后未注入；请读 ${row.path}]`)
        break
      }
      const sliced = sliceUtf8(Buffer.from(row.excerpt, 'utf8'), room)
      const body = trimToLine(new TextDecoder('utf-8').decode(sliced))
      text = `${open}\n${escapeFrame(body)}\n\n…[后续内容已截断，详情请读 ${row.path}]`
    }
    used += byteLength(text)
    lines.push(text)
  }

  lines.push('</system-reminder>')
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('fire-seed: disabled by config')
    return
  }

  /**
   * sessionId -> 上次成功注入时的文件指纹。
   * 用字符串键而不是 WeakMap 键 session 对象：同一会话的 session 包装对象可能被重建，
   * 换了对象就失忆会重复注入。表满时丢最早的一条（会话数不设上限，但注入记录很小）。
   */
  const MAX_TRACKED_SESSIONS = 512
  const injectedFingerprint = new Map()
  const sessionKey = session => {
    const id = session?.id ?? session?.header?.id
    return typeof id === 'string' ? id : undefined
  }
  const recallFingerprint = session => {
    const key = sessionKey(session)
    return key === undefined ? undefined : injectedFingerprint.get(key)
  }
  const rememberFingerprint = (session, fingerprint) => {
    const key = sessionKey(session)
    if (key === undefined) return
    if (!injectedFingerprint.has(key) && injectedFingerprint.size >= MAX_TRACKED_SESSIONS) {
      const oldest = injectedFingerprint.keys().next().value
      injectedFingerprint.delete(oldest)
    }
    injectedFingerprint.set(key, fingerprint)
  }

  const resolveRoot = async (agent, signal) => {
    if (cfg.root !== undefined) return cfg.root
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined) return await workingDirectory.ensure(agent, signal)
    return undefined
  }

  const build = async (agent, signal) => {
    signal?.throwIfAborted?.()
    const root = await resolveRoot(agent, signal)
    if (root === undefined) return null

    const probed = []
    for (const fileName of new Set([...cfg.manifest, ...cfg.excerptFiles])) {
      const entry = await probeOne(root, fileName)
      if (entry !== null) probed.push(entry)
    }
    if (probed.length === 0) return null

    // 指纹取被注入的三份+anchorFile：令文改动也要触发重推（常驻节跟着刷新）。
    const fingerprint = probed
      .filter(item => cfg.excerptFiles.includes(item.name) || item.name === cfg.anchorFile)
      .map(item => `${item.name}:${item.size}:${item.mtimeMs}`)
      .join('|')
    if (recallFingerprint(agent.session) === fingerprint) return null

    // 总纲令常驻节：从 anchorFile 全文抽取，排在消息最顶部、不占摘录预算。
    let anchorBlock = undefined
    const anchorRow = probed.find(item => item.name === cfg.anchorFile)
    if (anchorRow && cfg.anchorSections.length > 0 && anchorRow.size <= MAX_SOURCE_BYTES) {
      try {
        const full = new TextDecoder('utf-8').decode(await readFile(anchorRow.path))
        anchorBlock = extractSections(full, cfg.anchorSections).join('\n\n')
      } catch { /* 读不到就跳过常驻节，不影响摘录 */ }
    }

    const rows = []
    for (const entry of probed) {
      const row = await describe(entry)
      if (row.bytes !== undefined && cfg.excerptFiles.includes(row.name)) {
        const sliced = sliceUtf8(row.bytes, Math.min(cfg.perFileBytes, row.size))
        const text = trimToLine(new TextDecoder('utf-8').decode(sliced))
        row.excerpt = text
        row.excerptBytes = byteLength(text)
        row.excerptTruncated = row.size > row.excerptBytes
      }
      delete row.bytes
      rows.push(row)
    }

    const text = render(rows, cfg, root, anchorBlock)
    return {
      text,
      root,
      fingerprint,
      digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    }
  }

  /** 会话恢复（resume）后进程内缓存是空的，靠历史消息判重。 */
  const alreadyInjected = (agent, digest) => {
    try {
      const nodes = agent.session?.surface?.nodes
      if (nodes === undefined) return false
      const seqs = Array.from(nodes)
      for (let index = seqs.length - 1; index >= 0; index -= 1) {
        const event = agent.session.eventAt(seqs[index])
        if (event?.type !== 'user/message') continue
        const source = event.data?.source
        if (source?.kind === SOURCE_KIND && source.digest === digest) return true
      }
    } catch {
      /* 历史读取失败不影响本轮注入 */
    }
    return false
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      if (decision.messages.length === 0) return decision
      const agent = payload.agent
      if (!cfg.includeSubagents && agent.session?.header?.origin === 'subagent') return decision

      const built = await build(agent, payload.signal)
      if (built === null) return decision
      if (alreadyInjected(agent, built.digest)) {
        rememberFingerprint(agent.session, built.fingerprint)
        return decision
      }

      const message = deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: built.text }],
        source: { kind: SOURCE_KIND, form: 'instructions', digest: built.digest, root: built.root },
      })

      rememberFingerprint(agent.session, built.fingerprint)
      ctx.logger?.info?.('fire-seed: injected %d bytes from %s', byteLength(built.text), built.root)

      const lastClaimed = decision.messages.findLastIndex(item => payload.messages.includes(item))
      const at = lastClaimed < 0 ? decision.messages.length : lastClaimed + 1
      return { ...decision, messages: decision.messages.toSpliced(at, 0, message) }
    } catch (error) {
      ctx.logger?.warn?.('fire-seed: injection skipped: %o', error)
      return decision
    }
  })
}
