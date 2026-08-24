/**
 * DeepSeek 官方价格折算。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-08 抓取）
 * 峰谷规则：高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00；其余为空闲。
 * 价格单位：元 / 百万 token。
 */

export interface DeepSeekPriceRow {
  /** 输入·缓存命中（空闲/高峰） */
  hitIdle: number
  hitPeak: number
  /** 输入·缓存未命中（空闲/高峰） */
  missIdle: number
  missPeak: number
  /** 输出（空闲/高峰） */
  outIdle: number
  outPeak: number
}

/** 内置价格表（元/百万 token）。model 与 API 文档模型名精确匹配。 */
export const DEEPSEEK_PRICES: Record<string, DeepSeekPriceRow> = {
  'deepseek-v4-flash': {
    hitIdle: 0.05, hitPeak: 0.10,
    missIdle: 1.5, missPeak: 3.0,
    outIdle: 4.5, outPeak: 9.0,
  },
  'deepseek-v4-pro': {
    hitIdle: 0.15, hitPeak: 0.30,
    missIdle: 4.5, missPeak: 9.0,
    outIdle: 13.5, outPeak: 27.0,
  },
  'deepseek-v4-flash-vision-exp': {
    hitIdle: 0.05, hitPeak: 0.10,
    missIdle: 1.5, missPeak: 3.0,
    outIdle: 4.5, outPeak: 9.0,
  },
}

/** 价格表抓取日期（提醒用户价格可能变动） */
export const PRICE_SOURCE_DATE = '2026-08'

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** DeepSeek 特有：缓存命中的输入 token 数 */
  cacheHitTokens?: number
  cacheMissTokens?: number
}

export interface CostEstimate {
  model: string
  peak: boolean
  /** 元（保留 4 位小数） */
  costYuan: number
  detail: { hit: number; miss: number; out: number }
}

/** 判断某时刻是否为高峰时段（北京时间，周一~周五 9-12/14-18） */
export function isPeakHour(date: Date): boolean {
  // 转为北京时间（UTC+8），不依赖本地时区
  const bj = new Date(date.getTime() + 8 * 3600 * 1000)
  const utcDay = bj.getUTCDay()          // 0=周日
  const utcHour = bj.getUTCHours()
  if (utcDay === 0 || utcDay === 6) return false
  return (utcHour >= 9 && utcHour < 12) || (utcHour >= 14 && utcHour < 18)
}

/**
 * 折算金额。
 * - 模型不在内置表：返回 null（调用方仅显示 token）
 * - 优先级：DeepSeek 缓存字段 > prompt 全部按未命中计
 */
export function estimateCostYuan(model: string, usage: UsageInfo, at: Date): CostEstimate | null {
  const row = DEEPSEEK_PRICES[model]
  if (!row) return null
  const peak = isPeakHour(at)

  const hit = usage.cacheHitTokens ?? 0
  const miss = usage.cacheMissTokens !== undefined
    ? usage.cacheMissTokens
    : Math.max(0, usage.promptTokens - hit)

  const hitCost = (hit / 1e6) * (peak ? row.hitPeak : row.hitIdle)
  const missCost = (miss / 1e6) * (peak ? row.missPeak : row.missIdle)
  const outCost = (usage.completionTokens / 1e6) * (peak ? row.outPeak : row.outIdle)

  return {
    model,
    peak,
    costYuan: Math.round((hitCost + missCost + outCost) * 10000) / 10000,
    detail: { hit: hit, miss: miss, out: usage.completionTokens },
  }
}

/** 解析 OpenAI 响应中的 usage 字段 */
export function parseUsage(data: any): UsageInfo | null {
  const u = data?.usage
  if (!u || typeof u.prompt_tokens !== 'number') return null
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? u.prompt_tokens + (u.completion_tokens ?? 0),
    cacheHitTokens: typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens : undefined,
    cacheMissTokens: typeof u.prompt_cache_miss_tokens === 'number' ? u.prompt_cache_miss_tokens : undefined,
  }
}
