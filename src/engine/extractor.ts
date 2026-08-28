/**
 * 事实提取引擎：把最近对话变成结构化「世界书事实」。
 *
 * 输入：最近 N 轮对话 + 已有实体清单（增量合并防重复创建）
 * 输出：{ characters, relations, facts }
 *   - characters → 角色面板数据（按名字增量更新）
 *   - relations  → 关系图数据（按 from+to+relType 增量更新）
 *   - facts      → 自动笔记簿条目（key 触发词 + content）
 */

import type { ApiConfig, Character, Relation } from '../types'
import { chatCompletion } from './pipeline'

export interface ExtractedCharacter {
  name: string
  identity?: string
  /** 境界/段位等（自由文本） */
  realm?: string
  description?: string
  /** 角色面板属性（按存档维度打分，0-10），用于雷达图 */
  attributes?: Array<{ label: string; value: number }>
}

export interface ExtractedRelation {
  from: string
  to: string
  relType: string
  label?: string
}

export interface ExtractedFact {
  key: string      // 触发词，逗号分隔；空 = 常驻
  content: string
  /** 世界类别（板块分组） */
  category?: string
}

/** v1.6：角色改名/合并（用户纠正名字时，不改旧卡而是合并） */
export interface ExtractedRename {
  from: string   // 旧名
  to: string     // 新名
}

export interface ExtractResult {
  characters: ExtractedCharacter[]
  relations: ExtractedRelation[]
  facts: ExtractedFact[]
  renames: ExtractedRename[]
  raw: string
}

/**
 * 应用改名：同档角色卡改名/合并、关系两端同步迁移。
 * 纯函数（就地修改传入数组），返回需要写库的变更清单。
 */
export function applyRenames(
  chars: Character[],
  rels: Relation[],
  renames: ExtractedRename[] | undefined,
): { changedChars: Character[]; changedRels: Relation[]; deletedChars: Character[] } {
  const changedChars: Character[] = []
  const changedRels: Relation[] = []
  const deletedChars: Character[] = []
  for (const rn of renames ?? []) {
    const from = rn?.from?.trim(), to = rn?.to?.trim()
    if (!from || !to || from === to) continue
    const old = chars.find((c) => c.name === from)
    if (!old) continue
    const existing = chars.find((c) => c.name === to)
    if (existing && existing !== old) {
      // 目标已存在 → 合并（新卡补缺失字段，删旧卡）
      let merged = false
      if (!existing.identity && old.identity) { existing.identity = old.identity; merged = true }
      if (!existing.description && old.description) { existing.description = old.description; merged = true }
      if (!existing.attributesJson && old.attributesJson) { existing.attributesJson = old.attributesJson; merged = true }
      if (!existing.realm && old.realm) { existing.realm = old.realm; merged = true }
      if (merged) { existing.updatedAt = Date.now(); changedChars.push(existing) }
      chars.splice(chars.indexOf(old), 1)
      deletedChars.push(old)
    } else if (existing === old) {
      continue // 同名项，无需处理
    } else {
      old.name = to
      old.updatedAt = Date.now()
      changedChars.push(old)
    }
    // 关系两端迁移
    for (const r of rels) {
      let touched = false
      if (r.fromChar === from) { r.fromChar = to; touched = true }
      if (r.toChar === from) { r.toChar = to; touched = true }
      if (touched && !changedRels.includes(r)) changedRels.push(r)
    }
  }
  return { changedChars, changedRels, deletedChars }
}

/** v1.3 存档级属性体系（默认通用六维 + 境界标签）；v1.8 支持自定义上限/维数 */
export interface AttrSchema {
  dims: Array<{ label: string }>
  realmLabel?: string   // 空/缺省 = 不显示境界
  /** v1.8 属性值上限（默认 10，1-100） */
  maxValue?: number
}

export const DEFAULT_ATTR_SCHEMA: AttrSchema = {
  dims: [
    { label: '力量' }, { label: '敏捷' }, { label: '智力' },
    { label: '意志' }, { label: '感知' }, { label: '魅力' },
  ],
  realmLabel: '境界',
  maxValue: 10,
}

/** 世界类别（板块分组）候选 */
export const CATEGORIES = ['修炼体系', '经济系统', '地理环境', '种族文化', '组织势力', '物品神器', '其他'] as const

/**
 * v2.2.1：候选类别 = 内建 CATEGORIES + 存档已用类别（用户自定义/手动建的类别）。
 * 默认类别是内核向白名单；题材不匹配时 AI 只能全给「其他」，自定义类别也被洗掉。
 */
export function collectCategoryCandidates(used: string[] | undefined): string[] {
  const set = new Set<string>(CATEGORIES as readonly string[])
  for (const c of used ?? []) {
    const t = typeof c === 'string' ? c.trim() : ''
    if (t && t !== '其他') set.add(t)
  }
  return [...set]
}

/**
 * 事实类别归一化。
 * v2.2.1 宽放：候选内的保留；候选外但有意义（2-8 字、无尖括号/引号）的新类别也保留
 * （AI 按题材新建类别的场景，如「梦境规则」「都市异闻」）；
 * 只有空/无意义/超长/含非法字符才归「其他」——根治「全堆其他」。
 */
export function normCategory(cat: unknown, candidates?: readonly string[]): string {
  const c = typeof cat === 'string' ? cat.trim() : ''
  if (!c) return '其他'
  if ((candidates ?? CATEGORIES as readonly string[]).includes(c)) return c
  if (c.length >= 2 && c.length <= 8 && !/[<>{}[\]"'`\\]/.test(c)) return c
  return '其他'
}

export function parseAttrSchema(json?: string): AttrSchema {
  if (!json) return DEFAULT_ATTR_SCHEMA
  try {
    const p = JSON.parse(json) as AttrSchema
    const dims = Array.isArray(p.dims)
      ? p.dims.filter((d) => d?.label?.trim()).slice(0, 12).map((d) => ({ label: String(d.label).trim() }))
      : []
    if (!dims.length) return DEFAULT_ATTR_SCHEMA
    const maxValue = Math.max(1, Math.min(100, Number(p.maxValue) || 10))
    return {
      dims,
      realmLabel: typeof p.realmLabel === 'string' ? p.realmLabel : DEFAULT_ATTR_SCHEMA.realmLabel,
      maxValue,
    }
  } catch { return DEFAULT_ATTR_SCHEMA }
}

export function attrSchemaJson(s: AttrSchema): string {
  return JSON.stringify({ dims: s.dims, realmLabel: s.realmLabel ?? '', maxValue: s.maxValue ?? 10 })
}

/** 已有实体清单（防重复） */
export interface ExistingEntities {
  characters: string[]   // 名字
  relations: string[]    // "from|to|relType"
  facts: string[]        // 触发词
  /** 尚未整理的对话范围（限最近若干条文本用） */
  recentText: string
  /** v1.3：存档属性维度（label 列表），提取时强制按维度打分 */
  attrDims?: string[]
  /** v1.3：境界标签名（空则不提境界） */
  realmLabel?: string
  /** v2.2.1：存档已用类别（策略书/笔记本/手动条目中出现的），供提取时优先沿用 */
  categoryCandidates?: string[]
}

/** 合并提取属性到已有 attributesJson：新 label 覆盖/追加，保留前 6 条 */
export function mergeAttrs(
  existing: string | undefined,
  add: Array<{ label: string; value: number }> | undefined,
): string | undefined {
  if (!add?.length) return existing
  const map = new Map<string, number>()
  try {
    const arr = JSON.parse(existing || '[]') as Array<{ label?: string; value?: number }>
    if (Array.isArray(arr)) for (const a of arr) if (a?.label) map.set(String(a.label), Number(a.value) || 0)
  } catch { /* 忽略坏数据 */ }
  for (const a of add) map.set(a.label, a.value)
  return JSON.stringify([...map.entries()].slice(0, 6).map(([label, value]) => ({ label, value })))
}

/** 按存档维度/境界生成书记官系统提示词 */
export function makeSystemPrompt(attrDims: string[], realmLabel: string, categoryCandidates?: string[]): string {
  const dimsLine = attrDims.length
    ? `「${attrDims.join('、')}」`
    : '（存档未设置维度，可自由命名，每角色最多 6 条）'
  const realmField = realmLabel
    ? `, "realm": "${realmLabel}（如：金丹期/见习法师；无法确认就留空）"`
    : ''
  const catLine = (categoryCandidates?.length ? categoryCandidates : CATEGORIES as readonly string[]).join('、')
  return `你是梦境世界书的「书记官」。阅读一段 AI 跑团对话，提取其中值得沉淀到世界书的新信息。

输出严格 JSON（不要输出任何其他文字、不要代码块），格式：
{
  "characters": [{"name": "角色名", "identity": "身份/地位"${realmField}, "description": "一两句关键特征", "attributes": [{"label": "维度名", "value": 7}]}],
  "relations": [{"from": "甲", "to": "乙", "relType": "关系类型", "label": "简要描述"}],
  "facts": [{"key": "触发词，多个用逗号分隔，可以为空表示常驻", "content": "一条事实，一句到两句", "category": "类别"}],
  "renames": [{"from": "已登记的旧名", "to": "对话中更正后的新名"}]
}

规则：
1. 只提取「新的」或「发生了变化的」信息。已有的不要重复提取。
2. characters：新的重要角色；或已知角色的重要变化（身份、状态转折）。
3. attributes 只能使用存档维度 ${dimsLine}；从对话线索推断 0-10 整数打分；没有可靠线索的维度不填；每个角色最多填 6 条。
4. 已有角色的数值只在明显变化时更新。
5. relations：新出现或变化的关系（亲缘/敌友/恋人/师徒等）。
6. facts：世界观设定、地点、物品、重要事件、剧情转折。一条事实一记，不要大段复制原文。category 从下列候选中选一个，**优先沿用已有类别**（同一主题归同一类别，这很重要）：「${catLine}」。若确有候选中不存在的全新主题，可新建一个 2-4 字的类别；**不确定时选「其他」，不要乱造类别**。
7. 名字用对话中的原称。无法确定名字的次要角色不提取。
8. **renames（重要）**：对话中明确纠正或改称某个已登记角色（如「她其实叫艾莉丝，不是爱丽丝」「我们叫她小艾」）时，输出 renames 把旧名映射到新名；该角色的新信息一律用新名输出、不要再输出旧名条目。没有改名则输出空数组。
9. 如果某类没有新内容，输出空数组。
10. 全部用中文。`
}

/** 从模型输出中提取 JSON（容错：剥离代码块、找首尾大括号） */
export function extractJson<T>(raw: string): T | null {
  let text = raw.trim()
  // 剥离 ```json ... ``` 或 ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  // 找第一个 { 到最后一个 }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  text = text.slice(start, end + 1)
  try {
    return JSON.parse(text) as T
  } catch {
    // 常见小修：尾逗号
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')) as T
    } catch {
      return null
    }
  }
}

/** 清洗提取结果（空字段过滤等），纯函数便于测试 */
export function sanitizeResult(parsed: Partial<ExtractResult>, categoryCandidates?: string[]): ExtractResult {
  return {
    characters: Array.isArray(parsed.characters)
      ? parsed.characters
          .filter(c => c?.name && String(c.name).trim())
          .map(c => ({
            name: String(c.name).trim(),
            identity: c.identity?.trim() || undefined,
            realm: c.realm?.trim() || undefined,
            description: c.description?.trim() || undefined,
            attributes: Array.isArray(c.attributes)
              ? c.attributes
                  .filter(a => a?.label?.trim() && typeof a.value === 'number' && isFinite(a.value))
                  .slice(0, 6)
                  .map(a => ({ label: String(a.label).trim(), value: Math.max(0, Math.min(10, Math.round(a.value))) }))
              : undefined,
          }))
      : [],
    relations: Array.isArray(parsed.relations)
      ? parsed.relations.filter(r => r?.from?.trim() && r?.to?.trim())
      : [],
    facts: Array.isArray(parsed.facts)
      ? parsed.facts
          .filter(f => f?.content?.trim())
          .map(f => ({
            key: f.key ?? '',
            content: f.content,
            category: normCategory(f.category, categoryCandidates),
          }))
      : [],
    renames: Array.isArray(parsed.renames)
      ? parsed.renames
          .filter(r => r?.from?.trim() && r?.to?.trim() && r.from !== r.to)
          .map(r => ({ from: String(r.from).trim(), to: String(r.to).trim() }))
      : [],
    raw: '',
  }
}

export async function extractFacts(
  api: ApiConfig,
  existing: ExistingEntities,
): Promise<ExtractResult> {
  const existingInfo = [
    existing.characters.length ? `已登记角色：${existing.characters.join('、')}` : '',
    existing.relations.length ? `已有关系：${existing.relations.join('；')}` : '',
    existing.facts.length ? `已有事实触发词：${existing.facts.join('、')}` : '',
  ].filter(Boolean).join('\n') || '（暂无已登记信息）'

  const categoryCandidates = collectCategoryCandidates(existing.categoryCandidates)
  const reply = await chatCompletion(api, [
    { role: 'system', content: makeSystemPrompt(existing.attrDims ?? [], existing.realmLabel ?? '', categoryCandidates) },
    { role: 'user', content: `${existingInfo}\n\n=== 请阅读以下对话，提取新事实 ===\n\n${existing.recentText.slice(0, 24000)}` },
  ])

  const parsed = extractJson<ExtractResult>(reply)
  if (!parsed) {
    return { characters: [], relations: [], facts: [], renames: [], raw: reply }
  }
  return { ...sanitizeResult(parsed, categoryCandidates), raw: reply }
}
