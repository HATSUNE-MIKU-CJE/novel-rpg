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

import type { Entry, CharacterPayload, Character, LocationPayload, ItemPayload, EventPayload, RulePayload, FactionPayload, TimelinePayload } from '../types'

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

/** v3.2：地理卡 payload */
export function parseLocationPayload(json?: string): LocationPayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return {
        name: String(p.name ?? '').trim(),
        region: p.region?.trim() || undefined,
        danger: typeof p.danger === 'number' && isFinite(p.danger) ? Math.max(0, Math.min(100, Math.round(p.danger))) : undefined,
        features: p.features?.trim() || undefined,
        residents: p.residents?.trim() || undefined,
      }
    }
  } catch { /* 坏数据 → 空 */ }
  return { name: '' }
}

export function locationPayloadJson(p: LocationPayload): string {
  const out: Record<string, any> = {}
  if (p.name) out.name = p.name
  if (p.region) out.region = p.region
  if (p.danger != null) out.danger = p.danger
  if (p.features) out.features = p.features
  if (p.residents) out.residents = p.residents
  return JSON.stringify(out)
}

/** v3.2：按 kind 解析 payload（注入/渲染共用） */
export function parseCardPayload(kind: string, json?: string): any {
  switch (kind) {
    case 'character': return parseCharacterPayload(json)
    case 'location': return parseLocationPayload(json)
    case 'item': return parseItemPayload(json)
    case 'event': return parseEventPayload(json)
    case 'rule': return parseRulePayload(json)
    case 'faction': return parseFactionPayload(json)
    case 'timeline': return parseTimelinePayload(json)
    default: return {}
  }
}

/** v3.2：物品卡 */
export function parseItemPayload(json?: string): ItemPayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return { name: String(p.name ?? '').trim(), category: p.category?.trim() || undefined, effect: p.effect?.trim() || undefined, holder: p.holder?.trim() || undefined, state: p.state?.trim() || undefined }
    }
  } catch { /* ignore */ }
  return { name: '' }
}
export function itemPayloadJson(p: ItemPayload): string {
  const o: Record<string, any> = {}
  if (p.name) o.name = p.name
  if (p.category) o.category = p.category
  if (p.effect) o.effect = p.effect
  if (p.holder) o.holder = p.holder
  if (p.state) o.state = p.state
  return JSON.stringify(o)
}

/** v3.2：事件卡 */
export function parseEventPayload(json?: string): EventPayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return { name: String(p.name ?? '').trim(), time: p.time?.trim() || undefined, place: p.place?.trim() || undefined, detail: p.detail?.trim() || undefined }
    }
  } catch { /* ignore */ }
  return { name: '' }
}
export function eventPayloadJson(p: EventPayload): string {
  const o: Record<string, any> = {}
  if (p.name) o.name = p.name
  if (p.time) o.time = p.time
  if (p.place) o.place = p.place
  if (p.detail) o.detail = p.detail
  return JSON.stringify(o)
}

/** v3.2：规则卡 */
export function parseRulePayload(json?: string): RulePayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return { name: String(p.name ?? '').trim(), scope: p.scope?.trim() || undefined, clauses: p.clauses?.trim() || undefined, consequence: p.consequence?.trim() || undefined }
    }
  } catch { /* ignore */ }
  return { name: '' }
}
export function rulePayloadJson(p: RulePayload): string {
  const o: Record<string, any> = {}
  if (p.name) o.name = p.name
  if (p.scope) o.scope = p.scope
  if (p.clauses) o.clauses = p.clauses
  if (p.consequence) o.consequence = p.consequence
  return JSON.stringify(o)
}

/** v3.2：势力卡 */
export function parseFactionPayload(json?: string): FactionPayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return { name: String(p.name ?? '').trim(), members: p.members?.trim() || undefined, goal: p.goal?.trim() || undefined, territory: p.territory?.trim() || undefined, relations: p.relations?.trim() || undefined }
    }
  } catch { /* ignore */ }
  return { name: '' }
}
export function factionPayloadJson(p: FactionPayload): string {
  const o: Record<string, any> = {}
  if (p.name) o.name = p.name
  if (p.members) o.members = p.members
  if (p.goal) o.goal = p.goal
  if (p.territory) o.territory = p.territory
  if (p.relations) o.relations = p.relations
  return JSON.stringify(o)
}

/** v3.2：时期卡 */
export function parseTimelinePayload(json?: string): TimelinePayload {
  if (!json) return { name: '' }
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return { name: String(p.name ?? '').trim(), range: p.range?.trim() || undefined, overview: p.overview?.trim() || undefined }
    }
  } catch { /* ignore */ }
  return { name: '' }
}
export function timelinePayloadJson(p: TimelinePayload): string {
  const o: Record<string, any> = {}
  if (p.name) o.name = p.name
  if (p.range) o.range = p.range
  if (p.overview) o.overview = p.overview
  return JSON.stringify(o)
}

/** v3.2：卡显示名（人物/地理卡取 name；一般条目回退 key） */
export function cardDisplayName(kind: string, payload: any, key: string): string {
  if (payload?.name) return payload.name
  return key || '未命名'
}

/** v3.2：kind 中文标签（UI 徽标用） */
export function kindLabel(kind?: string): string {
  const map: Record<string, string> = {
    character: '人物卡', location: '地理卡', item: '物品卡', event: '事件卡',
    rule: '规则卡', faction: '势力卡', timeline: '时期卡', note: '备注',
  }
  return map[kind ?? 'note'] ?? '备注'
}

/** v3.2：条目展示文本（人物/地理/物品/…按 kind 显示结构化字段，其余显示 content） */
export function entryDisplayText(e: Entry): string {
  if (e.kind === 'character') {
    const p = parseCharacterPayload(e.payloadJson)
    return [p.identity, p.realm, e.hook, e.content].filter(Boolean).join(' · ')
  }
  if (e.kind === 'location') {
    const p = parseLocationPayload(e.payloadJson)
    return [p.region ? `区域：${p.region}` : '', p.danger != null ? `危险度：${p.danger}` : '', p.features, p.residents ? `居民：${p.residents}` : ''].filter(Boolean).join(' · ')
  }
  if (e.kind === 'item') {
    const p = parseItemPayload(e.payloadJson)
    return [p.category ? `类别：${p.category}` : '', p.effect, p.holder ? `持有：${p.holder}` : '', p.state ? `状态：${p.state}` : ''].filter(Boolean).join(' · ')
  }
  if (e.kind === 'event') {
    const p = parseEventPayload(e.payloadJson)
    return [p.time ? `时间：${p.time}` : '', p.place ? `地点：${p.place}` : '', p.detail].filter(Boolean).join(' · ')
  }
  if (e.kind === 'rule') {
    const p = parseRulePayload(e.payloadJson)
    return [p.scope ? `适用：${p.scope}` : '', p.clauses, p.consequence ? `后果：${p.consequence}` : ''].filter(Boolean).join(' · ')
  }
  if (e.kind === 'faction') {
    const p = parseFactionPayload(e.payloadJson)
    return [p.members ? `成员：${p.members}` : '', p.goal, p.territory ? `地盘：${p.territory}` : '', p.relations ? `关系：${p.relations}` : ''].filter(Boolean).join(' · ')
  }
  if (e.kind === 'timeline') {
    const p = parseTimelinePayload(e.payloadJson)
    return [p.range ? `起止：${p.range}` : '', p.overview].filter(Boolean).join(' · ')
  }
  return e.content
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
    // v3.2：人物/地理卡参与 hook 分层（P1 排队 + P2 触发）；其余 kind 走 v2 note 机制
    if (e.kind !== 'character' && e.kind !== 'location') continue

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
    const p = parseCardPayload(e.kind ?? 'note', e.payloadJson)
    const detail = e.content?.trim() || p?.behavior?.trim() || p?.features?.trim() || ''
    if (!detail) return ''
    const head = p?.name || e.key
    return `${head}：${detail}`
  }).filter(Boolean)
  return { constant, keyed }
}
