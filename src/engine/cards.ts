/**
 * v2.2 状态卡：配置层「字段注册表」+ AI 每轮直通块（[[SNAP]]）。
 * 与血条 [[BAR]] 同构：AI 在回复末尾夹带 SNAP 块，UI 直接更新，无需用户确认。
 *
 * [[SNAP]]{"收集物资":{"add":"新物品","items":["全量清单"]},"体力":"60%"}[[/SNAP]]
 *   - 清单字段：add=追加一件；items=整组覆盖（优先 add 后 items？规则：先按 items 覆盖，再 add 追加）
 *   - 单行字段：直接字符串覆盖
 */

import type { StatusCardDef, StatusCardField } from '../types'

export const DEFAULT_STATUS_CARD: StatusCardDef = { enabled: false, fields: [] }

/** 一键示例：沉浸跑团常见字段 */
export const STATUS_CARD_TEMPLATE: StatusCardField[] = [
  { id: 'inv', label: '收集物资', type: 'list' },
  { id: 'stamina', label: '体力', type: 'text' },
  { id: 'mind', label: '精神状态', type: 'text' },
  { id: 'place', label: '当前地点', type: 'text' },
]

export function parseStatusCard(json?: string): StatusCardDef {
  if (!json) return JSON.parse(JSON.stringify(DEFAULT_STATUS_CARD))
  try {
    const p = JSON.parse(json) as StatusCardDef
    const fields = Array.isArray(p.fields)
      ? p.fields
          .filter((f) => f?.label?.trim())
          .slice(0, 12)
          .map((f) => ({
            id: f.id || `f${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            label: f.label.trim(),
            type: f.type === 'list' ? 'list' as const : 'text' as const,
            disabled: !!f.disabled,
          }))
      : []
    return { enabled: !!p.enabled, fields }
  } catch { return JSON.parse(JSON.stringify(DEFAULT_STATUS_CARD)) }
}

export function statusCardJson(s: StatusCardDef): string {
  return JSON.stringify({ enabled: s.enabled, fields: s.fields })
}

/** 状态卡当前值 */
export function readStatusValues(json?: string): Record<string, string | string[]> {
  if (!json) return {}
  try {
    const p = JSON.parse(json)
    if (p && typeof p === 'object') return p as Record<string, string | string[]>
  } catch { /* ignore */ }
  return {}
}

export function writeStatusValues(vals: Record<string, string | string[]>): string {
  return JSON.stringify(vals)
}

/** 解析 [[SNAP]] 块（与 parseBars 同构；最多 3 个） */
export function parseSnap(text: string): { clean: string; updates: Array<Record<string, any>> } {
  const updates: Array<Record<string, any>> = []
  const clean = text
    .replace(/\[\[SNAP\]\]([\s\S]*?)\[\[\/SNAP\]\]/gi, (_m, inner: string) => {
      try {
        const p = JSON.parse(inner.trim())
        if (p && typeof p === 'object' && !Array.isArray(p)) updates.push(p)
      } catch { /* 坏块忽略 */ }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, updates: updates.slice(0, 3) }
}

/** 游戏流注入用：状态卡协议提示词 */
export function statusCardProtocol(def: StatusCardDef): string {
  const active = def.fields.filter((f) => !f.disabled)
  const desc = active.map((f) => `${f.label}（${f.type === 'list' ? '清单' : '单行'}）`).join('、')
  return `【状态卡协议】本存档开启状态卡，字段：${desc}。每轮回复末尾，若其中字段发生变化，输出块 [[SNAP]]{"${active[0]?.label ?? '字段'}": <值>}[[/SNAP]]（可同时带多个字段）；无变化则省略。清单字段：值用 {"add":"新增一项","items":["当前全量清单"]}（先 items 覆盖再 add 追加）；单行字段：值直接给字符串。数值必须如实反映当前状态，不得编造。`
}
