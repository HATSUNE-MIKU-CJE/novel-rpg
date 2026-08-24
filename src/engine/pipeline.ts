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

/** 合并多本世界书条目文本为注入点内容 */
function mergeEntries(entries: Entry[]): string {
  return entries
    .filter((e) => e.enabled && e.content.trim())
    .map((e) => `【${e.key ? e.key : '常驻'}】\n${e.content.trim()}`)
    .join('\n\n')
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

  const resp = await fetch(`${base}/chat/completions`, {
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
