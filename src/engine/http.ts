/**
 * 统一 HTTP 客户端：
 * - 原生环境（Capacitor）：走 CapacitorHttp（原生通道，无 CORS 限制；
 *   opencode-go 等服务端网关无 CORS 头也能直连）
 * - Web 环境：标准 fetch（浏览器 CORS 规则）
 *
 * 保持 fetch API 兼容：返回 Promise<Response>
 */

import { Capacitor } from '@capacitor/core'
import { CapacitorHttp } from '@capacitor/core'

export async function httpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!Capacitor.isNativePlatform()) {
    return fetch(input, init)
  }

  // 原生：CapacitorHttp
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const opts: any = init ?? {}
  if (typeof input !== 'string' && !(input instanceof URL) && input) {
    opts.method = input.method ?? opts.method
    opts.headers = { ...(input.headers as any) }
    if (input.body) opts.body = input.body
  }

  const res = await CapacitorHttp.request({
    url,
    method: (opts.method ?? 'GET').toUpperCase(),
    headers: opts.headers ?? {},
    data: opts.body,
    connectTimeout: 30000,
    readTimeout: 300000,
    webFetchExtra: opts,
  })

  // 转成标准 Response（兼容 resp.ok / resp.status / resp.json / resp.text）
  const respAny = res as any
  const rawData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
  const isJson = String(res.headers?.['content-type'] ?? '').includes('application/json')
  const response = new Response(rawData, {
    status: res.status,
    statusText: respAny.statusText ?? '',
    headers: {
      'content-type': String(res.headers?.['content-type'] ?? (isJson ? 'application/json' : 'text/plain')),
    },
  })
  // 兼容 resp.text()/resp.json()：standard Response 已支持
  return response
}
