/**
 * v2.2.1 原生流式桥（JS 侧）：调用 StreamBridge 插件，把 SSE 行解析为增量回调。
 * 仅原生环境使用；插件不可用/失败时由调用方回退（WebView fetch → CapacitorHttp 全量）。
 *
 * 数据流：原生逐行 notifyListeners("chunk", {id, data}) → 本模块按 id 过滤 → 解析 JSON
 * delta（与 Web 路径的解析逻辑保持一致，见 pipeline.chatCompletionStream）。
 */
import { registerPlugin } from '@capacitor/core'

const StreamBridge = registerPlugin<any>('StreamBridge')

export interface NativeStreamResult {
  content: string
  usage: any
  reasoning?: string
}

/** 唯一性 id：每次调用生成，原生回传时按 id 过滤旧流串台 */
let seq = 0
function nextId(): string {
  return `s${Date.now()}_${++seq}`
}

export function isStreamBridgeAvailable(): boolean {
  try {
    return !!StreamBridge && typeof StreamBridge.chatStream === 'function'
  } catch {
    return false
  }
}

/**
 * 原生流式请求。resolve 于流结束（含 usage）；reject 于网络错误/HTTP 错误。
 */
export function nativeChatStream(opts: {
  url: string
  headers: Record<string, string>
  body: string
  onDelta: (text: string) => void
  onReason?: (text: string) => void
}): Promise<NativeStreamResult> {
  return new Promise((resolve, reject) => {
    const id = nextId()
    let content = ''
    let reasoning = ''
    let usage: any = null
    let settled = false

    const cleanup = () => {
      try { StreamBridge.removeAllListeners() } catch { /* ignore */ }
    }
    const settle = (err?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(new Error(err))
      else resolve({ content, usage, reasoning: reasoning || undefined })
    }

    const onChunk = (d: any) => {
      if (!d || d.id !== id) return
      const line = typeof d.data === 'string' ? d.data.trim() : ''
      if (!line.startsWith('data:')) return
      const json = line.slice(5).trim()
      if (!json || json === '[DONE]') return
      try {
        const p = JSON.parse(json)
        const ch = p?.choices?.[0] ?? {}
        if (typeof ch?.delta?.content === 'string' && ch.delta.content) {
          content += ch.delta.content
          opts.onDelta(ch.delta.content)
        }
        if (typeof ch?.delta?.reasoning_content === 'string' && ch.delta.reasoning_content) {
          reasoning += ch.delta.reasoning_content
          opts.onReason?.(ch.delta.reasoning_content)
        }
        if (p?.usage && typeof p.usage.prompt_tokens === 'number') usage = p.usage
      } catch { /* 坏行跳过 */ }
    }
    const onDone = (d: any) => { if (!d || d.id === id) settle() }
    const onError = (d: any) => { if (!d || d.id === id) settle(d?.message || '原生流式请求失败') }

    StreamBridge.addListener('chunk', onChunk)
    StreamBridge.addListener('done', onDone)
    StreamBridge.addListener('error', onError)

    StreamBridge.chatStream({ id, url: opts.url, headersJson: JSON.stringify(opts.headers), body: opts.body })
      .catch((e: any) => settle(String(e?.message || e)))
  })
}
