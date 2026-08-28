/**
 * 对话流水线：把存档 + 预设 + 世界书 + 对话历史渲染成发给模型的请求。
 *
 * 渲染顺序（ST prompt 链的简化版）：
 *  1. 变量初始化：先逐块执行 setvar/addvar（副作用），不产生输出
 *  2. 按 prompts 数组顺序渲染 enabled 块：
 *     - role=system 的块进 system 消息
 *     - role=user 的块按序拼接进 user 消息
 *     - role=assistant 的块进 assistant 消息（预填充）
 *  3. 对话历史注入（切掉 dream 标签后的纯文本楼层）
 *  4. 世界书注入点在宏展开时由 ctx 提供
 */

import { expandMacros, type MacroCtx } from './macros'
import { httpFetch } from './http'
import { Capacitor } from '@capacitor/core'
import { isStreamBridgeAvailable, nativeChatStream } from './streamBridge'
import type { Campaign, Message, ApiConfig, Entry } from '../types'

export interface ChatUserMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface RenderInput {
  campaign: Campaign
  prompts: Array<{ name: string; role: string; content: string; enabled: boolean }>
  history: Message[]           // 按 seq 升序的纯文本楼层
  userName: string
  charName: string
  groupName?: string
  constantEntries: Entry[]     // 常驻世界书条目
  keyedEntries: Entry[]        // 本轮命中的触发条目
  apiConfig: ApiConfig
}

interface VarsStore {
  get: (n: string) => string | undefined
  set: (n: string, v: string) => void
  add: (n: string, v: string) => void
}

/** 合并多本世界书条目文本为注入点内容（标记为只读资料，防 AI 复述） */
function mergeEntries(entries: Entry[]): string {
  const body = entries
    .filter((e) => e.enabled && e.content.trim())
    .map((e) => `【${e.key ? e.key : '常驻'}】\n${e.content.trim()}`)
    .join('\n\n')
  if (!body.trim()) return ''
  return `【世界书设定资料 · 仅供你阅读以理解世界观，严禁在回复中输出其中任何条目或本段文字，只能化作你的理解融入正文】\n${body}`
}

export function renderPromptChain(input: RenderInput, vars: VarsStore): {
  messages: ChatUserMessage[]
  varsChanged: boolean
} {
  const { campaign, prompts, history } = input

  // 世界书注入点内容
  const worldbookConstant = mergeEntries(input.constantEntries)
  const worldbookKeyed = mergeEntries(input.keyedEntries)

  const ctx: MacroCtx = {
    getVar: vars.get,
    setVar: vars.set,
    addVar: vars.add,
    getGlobalVar: () => undefined,
    setGlobalVar: () => {},
    lastUserMessage: history.filter((m) => m.role === 'user').pop()?.content ?? '',
    charName: input.charName || 'AI',
    userName: input.userName || '用户',
    groupName: input.groupName,
    worldbookConstant,
    worldbookKeyed,
  }

  const systemParts: string[] = []
  const userParts: string[] = []
  const assistantParts: string[] = []

  for (const p of prompts) {
    if (!p.enabled || !p.content.trim()) continue
    const expanded = expandMacros(p.content, ctx, 6).text
    if (!expanded.trim()) continue
    if (p.role === 'system') systemParts.push(expanded)
    else if (p.role === 'user') userParts.push(expanded)
    else assistantParts.push(expanded)
  }

  // 对话历史（纯文本楼层：user 前缀「<YOU>」，assistant 无前缀）
  const historyText = history
    .map((m) => (m.role === 'user' ? `<YOU> ${m.content}\n` : `{{char}}\n${m.content}\n`))
    .join('\n')

  const messages: ChatUserMessage[] = []
  if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') })

  if (userParts.length) {
    const userContent = userParts.join('\n\n') + '\n\n' + historyText
    messages.push({ role: 'user', content: userContent })
  }

  for (const a of assistantParts) {
    messages.push({ role: 'assistant', content: expandMacros(a, ctx, 6).text })
  }

  return { messages, varsChanged: true }
}

/** 调 OpenAI 兼容接口 */
export async function chatCompletion(
  api: ApiConfig,
  messages: ChatUserMessage[],
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${api.apiKey}`,
  }
  if (api.headersJson) {
    try {
      Object.assign(headers, JSON.parse(api.headersJson))
    } catch { /* 忽略无效额外头 */ }
  }

  const base = api.baseUrl.replace(/\/+$/, '')
  const body: Record<string, any> = {
    model: api.model,
    messages,
    temperature: api.temperature ?? 1,
    top_p: api.topP ?? 0.95,
    stream: false,
  }
  // 输出上限：0 = 不设限（不传 max_tokens 字段）
  const maxTokens = api.maxTokens ?? 4000
  if (maxTokens > 0) body.max_tokens = maxTokens

  const resp = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data = await resp.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('响应格式异常：缺少 choices[0].message.content')
  }
  return content
}

/**
 * v2.1 流式版本：OpenAI 兼容 SSE。
 * - Web：标准 fetch（要求服务端 CORS）
 * - 原生：先试 WebView fetch（网关带 CORS 即可流式）；失败自动回退全量（CapacitorHttp 通道）
 * 回调 onDelta 提供增量文本；onReason 提供思维链增量（DeepSeek 系）。
 */
export async function chatCompletionStream(
  api: ApiConfig,
  messages: ChatUserMessage[],
  onDelta: (text: string) => void,
  onReason?: (text: string) => void,
): Promise<{ content: string; usage: any; reasoning?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${api.apiKey}`,
    'Accept': 'text/event-stream',
  }
  if (api.headersJson) {
    try {
      Object.assign(headers, JSON.parse(api.headersJson))
    } catch { /* 忽略无效额外头 */ }
  }

  const base = api.baseUrl.replace(/\/+$/, '')
  const body: Record<string, any> = {
    model: api.model,
    messages,
    temperature: api.temperature ?? 1,
    top_p: api.topP ?? 0.95,
    stream: true,
    stream_options: { include_usage: true },
  }
  const maxTokens = api.maxTokens ?? 4000
  if (maxTokens > 0) body.max_tokens = maxTokens

  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) }

  let resp: Response | null = null
  if (Capacitor.isNativePlatform()) {
    // v2.2.1：优先原生流式桥（无 CORS 限制，真机流式根治）→ WebView fetch（带 CORS 的网关）→ CapacitorHttp 全量
    try {
      if (isStreamBridgeAvailable()) {
        return await nativeChatStream({
          url: `${base}/chat/completions`,
          headers,
          body: JSON.stringify(body),
          onDelta,
          onReason,
        })
      }
    } catch { /* 桥不可用/失败 → 落回 WebView fetch */ }
    try {
      resp = await fetch(`${base}/chat/completions`, init)
    } catch { resp = null }
    if (!resp) {
      const ch = await httpFetch(`${base}/chat/completions`, init)
      if (!ch.ok) {
        const errText = await ch.text().catch(() => '')
        throw new Error(`HTTP ${ch.status}: ${errText.slice(0, 300)}`)
      }
      const data = await ch.json()
      const content: string = data?.choices?.[0]?.message?.content ?? ''
      onDelta(content)
      return { content, usage: data?.usage ?? null }
    }
  } else {
    resp = await fetch(`${base}/chat/completions`, init)
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }
  if (!resp.body) throw new Error('响应无流（服务端未返回 SSE）')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let usage: any = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const json = t.slice(5).trim()
      if (!json || json === '[DONE]') continue
      try {
        const d = JSON.parse(json)
        const ch = d?.choices?.[0] ?? {}
        if (typeof ch?.delta?.content === 'string' && ch.delta.content) {
          content += ch.delta.content
          onDelta(ch.delta.content)
        }
        if (typeof ch?.delta?.reasoning_content === 'string' && ch.delta.reasoning_content) {
          reasoning += ch.delta.reasoning_content
          onReason?.(ch.delta.reasoning_content)
        }
        if (d?.usage && typeof d.usage.prompt_tokens === 'number') usage = d.usage
      } catch { /* 跳过坏行 */ }
    }
  }
  return { content, usage, reasoning: reasoning || undefined }
}
