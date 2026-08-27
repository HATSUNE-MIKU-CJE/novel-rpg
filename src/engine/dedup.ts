/**
 * v2.0 归并判定：世界书防重核心。
 * 两条事实（条目）是否「是同一条」：
 *  1. 触发词词级相交（相同词）→ 直接判同一条
 *  2. 触发词不相交时，同类别 + 内容相似度 ≥ 阈值 → 疑似同一（供「合并建议」）
 * 相似度用字符 bigram Jaccard（中文短文本够用，无外部依赖）。
 */

/** 触发词解析（逗号/中文逗号分隔） */
export function splitKeys(key?: string): string[] {
  return (key ?? '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
}

/** 触发词词级相交 */
export function keysIntersect(a?: string, b?: string): boolean {
  const ka = splitKeys(a), kb = splitKeys(b)
  if (!ka.length || !kb.length) return false
  return ka.some((x) => kb.includes(x))
}

/** 字符 bigram 集合 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '')
  const out = new Set<string>()
  if (t.length <= 2) { if (t) out.add(t); return out }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 内容相似度 0..1（bigram Jaccard；短文本退化处理） */
export function contentSimilarity(a: string, b: string): number {
  const x = (a ?? '').replace(/\s+/g, '')
  const y = (b ?? '').replace(/\s+/g, '')
  if (!x.length || !y.length) return 0
  if (x === y) return 1
  const sa = bigrams(x), sb = bigrams(y)
  let inter = 0
  for (const g of sa) if (sb.has(g)) inter++
  const uni = sa.size + sb.size - inter
  // 短文本（无足够 bigram 时）退化为字符集重合
  if (uni === 0) {
    const ca = new Set(x), cb = new Set(y)
    let ci = 0
    for (const ch of ca) if (cb.has(ch)) ci++
    return ci / (ca.size + cb.size - ci || 1)
  }
  return inter / uni
}

/** 疑似同一阈值（保守：宁缺勿滥，更可能的真实重叠会命中 key 规则） */
export const SIMILAR_THRESHOLD = 0.62

/**
 * 归并判定：newItem 是否与已有条目视为同一条。
 * @returns 'same'（key 相交，确定同一条）| 'similar'（内容高度相似，疑似）| null（新条目）
 */
export function dedupStatus(
  existing: { key?: string; content: string; category?: string },
  incoming: { key?: string; content: string; category?: string },
): 'same' | 'similar' | null {
  if (keysIntersect(existing.key, incoming.key)) return 'same'
  if (contentSimilarity(existing.content, incoming.content) >= SIMILAR_THRESHOLD
    && (existing.category ?? '其他') === (incoming.category ?? '其他')) return 'similar'
  return null
}
