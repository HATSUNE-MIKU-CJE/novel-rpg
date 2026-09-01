/**
 * v3.1 类型化世界书 · 卡片引擎（纯函数核心）。
 *
 * 世界书 = 唯一事实源。
 * - kind=character 条目 = 人物卡（payload 存结构化表格）
 * - hook = 常驻精要（每轮必读一行，AI 生成可手改）
 * - timeline = 时期标签（非当前时期自动封存）
 * - 老 characters 表 → 只读兼容：提供 toCharacterEntry（迁移/升级用）与
 *   entryToLegacyShape（渲染层继续读老字段，避免 UI 大改）
 */

import type { Entry, CharacterPayload, Character } from '../types'

// ---------------- payload 读写（纯函数，坏数据安全） ----------------

export function parseCharacterPayload(json?: string): CharacterPayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const attrs = Array.isArray(p.attributes)
        ? p.attributes
            .filter((a: any) => a?.label?.trim() && typeof a.value === 'number' && isFinite(a.value))
            .slice(0, 12)
            .map((a: any) => ({ label: String(a.label).trim(), value: Math.max(0, Math.min(100, Math.round(a.value))) }))
        : undefined
      const barValues = p.barValues && typeof p.barValues === 'object' && !Array.isArray(p.barValues)
        ? Object.fromEntries(Object.entries(p.barValues).map(([k, v]) => [k, Number(v) || 0]))
        : undefined
      return {
        name: String(p.name ?? '').trim(),
        identity: p.identity?.trim() || undefined,
        realm: p.realm?.trim() || undefined,
        attributes: attrs,
        behavior: p.behavior?.trim() || undefined,
        barValues,
      }
    }
  } catch { /* 坏数据 → 空 */ }
  return { name: '' }
}

export function characterPayloadJson(p: CharacterPayload): string {
  const out: Record<string, any> = {}
  if (p.name) out.name = p.name
  if (p.identity) out.identity = p.identity
  if (p.realm) out.realm = p.realm
  if (p.attributes?.length) out.attributes = p.attributes
  if (p.behavior) out.behavior = p.behavior
  if (p.barValues && Object.keys(p.barValues).length) out.barValues = p.barValues
  return JSON.stringify(out)
}

// ---------------- 老表 → 人物卡条目（迁移/升级/合并） ----------------

/** 老 characters 行 → kind=character 条目（未入库，调用方负责 put/add） */
export function characterRowToEntry(row: Character, notebookWorldbookId: number, card?: Entry): Entry {
  const base: CharacterPayload = {
    name: row.name,
    identity: row.identity?.trim() || undefined,
    realm: row.realm?.trim() || undefined,
    barValues: undefined,
  }  // attributesJson 旧格式 [ {label, value} ] → payload.attributes
  try {
    const arr = JSON.parse(row.attributesJson || '[]') as Array<{ label?: string; value?: number }>
    if (Array.isArray(arr)) base.attributes = arr
      .filter((a) => a?.label?.trim())
      .map((a) => ({ label: String(a.label).trim(), value: Math.max(0, Math.min(100, Math.round(Number(a.value) || 0))) }))
  } catch { /* ignore */ }
  try {
    const bar = JSON.parse(row.barValuesJson || '{}') as Record<string, number>
    if (bar && typeof bar === 'object' && !Array.isArray(bar)) base.barValues = bar
  } catch { /* ignore */ }

  const hook = card?.hook
    ?? (base.name && base.identity ? `${base.name}：${base.identity}` : base.name)
  const key = card?.key ?? base.name
  return {
    worldbookId: notebookWorldbookId,
    kind: 'character',
    payloadJson: characterPayloadJson(base),
    hook: hook || undefined,
    timeline: card?.timeline,
    isMain: card?.isMain ?? 0,
    key,
    content: card?.content ?? row.description ?? '',
    enabled: card?.enabled ?? 1,
    source: card?.source ?? 'ai',
    status: card?.status ?? 'accepted',
    category: card?.category ?? '其他',
    createdAt: card?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
}

/** 条目 → 渲染层友好形状（向下兼容 CharacterDetail 等读取老字段） */
export function entryToCharacterShape(e: Entry): Character & { entryId: number } {
  const p = parseCharacterPayload(e.payloadJson)
  return {
    id: e.id,
    entryId: e.id ?? 0,
    campaignId: 0, // 由调用方补（条目 worldbookId → 存档）
    name: p.name || e.hook?.split(/[：:]/)[0] || '未命名',
    identity: p.identity,
    realm: p.realm,
    attributesJson: p.attributes?.length ? JSON.stringify(p.attributes) : undefined,
    barValuesJson: p.barValues && Object.keys(p.barValues).length ? JSON.stringify(p.barValues) : undefined,
    description: e.content || (p.behavior ? p.behavior : ''),
    source: e.source === 'manual' ? 'manual' : 'ai',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

// ---------------- 注入分级（纯函数） ----------------

export interface InjectionLayer {
  /** P0 必带：主角 hook + 当前时期 + 世界观基调（rule kind=note 的 hook） */
  p0: string[]
  /** P1 常驻：其他人物/地点的 hook 一行（按重要度排队，容量内取） */
  p1: string[]
  /** P2 触发：命中的完整详情 */
  p2: Entry[]
}

/**
 * 计算一轮游戏流的注入分层。
 * @param entries 已过滤（enabled、非 rejected）的候选条目
 * @param mainEntryId 主角人物卡条目 id（P0 必带其 hook）
 * @param currentTimeline 存档当前时期（空 = 不启用封存）
 * @param recentText 最近对话文本（触发词匹配）
 * @param p1Budget P1 最多带几条（作者限重；默认 8）
 */
export function computeInjectionLayers(
  entries: Entry[],
  mainEntryId?: number,
  currentTimeline?: string,
  recentText = '',
  p1Budget = 8,
): InjectionLayer {
  const p0: string[] = []
  const p1: string[] = []
  const p2: Entry[] = []

  const active = entries.filter((e) => {
    // 时期封存：条目标了时期且 ≠ 当前时期 → 不注入（当前时期空 = 不激活封存）
    if (currentTimeline && e.timeline && e.timeline !== currentTimeline) return false
    return true
  })

  // 主角入口（mainEntryId）：即使未标 isMain，它也是 P0（兜底：第一张启用卡）
  const mainIs = new Set<number>()
  if (mainEntryId != null) mainIs.add(mainEntryId)

  for (const e of active) {
    const hook = e.hook?.trim()
    // P0：主角卡 hook + 时期卡 hook（note/其他 kind 的常驻由 v2 注入机制处理，避免重复）
    if (mainIs.has(e.id ?? -1) && hook) { p0.push(hook); continue }
    if ((e.kind === 'timeline') && hook) { p0.push(hook); continue }
    if (e.kind !== 'character') continue // 非人物/时期卡不参与 hook 分层（老世界书 note 走 v2 机制）

    // 触发匹配？
    const keys = e.key.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    const hit = keys.length > 0 && recentText.trim().length > 0 && keys.some((k) => recentText.includes(k))
    if (hit) { p2.push(e); continue }

    // P1：有 hook 的常驻/角色精要排队
    if (hook) p1.push(hook)
  }

  return { p0, p1: p1.slice(0, p1Budget), p2 }
}

/** 渲染注入文本：P0 + P1 拼成常驻段，P2 逐条展开详情 */
export function renderInjectionText(layers: InjectionLayer): { constant: string; keyed: string[] } {
  const constant = [
    ...layers.p0.map((h) => `【${h}】`),
    ...layers.p1.map((h) => `【${h}】`),
  ].join('\n')
  const keyed = layers.p2.map((e) => {
    const p = e.kind === 'character' ? parseCharacterPayload(e.payloadJson) : null
    const detail = e.content?.trim() || p?.behavior?.trim() || ''
    if (!detail) return ''
    const head = p?.name || e.key
    return `${head}：${detail}`
  }).filter(Boolean)
  return { constant, keyed }
}
