/**
 * v1.8 状态条系统（血条模板 + 存档级配置 + 角色数值）。
 *
 * 内置三模板：血条（红）/ 蓝条（蓝）/ 经验（黄）；可改名、开关、自定上限、自定义新条（任意颜色）。
 * 与属性体系同级：存档级 barSchema；角色各自 barValues（按条名存取，clamp 0..max）。
 */

export interface BarDef {
  id: string
  name: string
  color: string
  max: number
  enabled: boolean
}

export interface BarSchema {
  bars: BarDef[]
}

/** 内置模板（经典三件套；用户可增删改） */
export const BAR_TEMPLATES: BarDef[] = [
  { id: 'hp', name: '血条', color: '#e06c75', max: 100, enabled: true },
  { id: 'mp', name: '蓝条', color: '#61afef', max: 100, enabled: false },
  { id: 'exp', name: '经验', color: '#e5c07b', max: 100, enabled: false },
]

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

export function parseBarSchema(json?: string): BarSchema {
  if (!json) return { bars: BAR_TEMPLATES.map((b) => ({ ...b })) }
  try {
    const p = JSON.parse(json) as BarSchema
    const bars = (Array.isArray(p.bars) ? p.bars : [])
      .filter((b) => b?.name?.trim())
      .slice(0, 12)
      .map((b) => ({
        id: typeof b.id === 'string' && b.id ? b.id : `b${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: String(b.name).trim(),
        color: COLOR_RE.test(b.color) ? b.color : '#e06c75',
        max: Math.max(1, Math.min(9999, Number(b.max) || 100)),
        enabled: !!b.enabled,
      }))
    return bars.length ? { bars } : { bars: BAR_TEMPLATES.map((b) => ({ ...b })) }
  } catch {
    return { bars: BAR_TEMPLATES.map((b) => ({ ...b })) }
  }
}

export function barSchemaJson(s: BarSchema): string {
  return JSON.stringify({ bars: s.bars })
}

/** 角色条数值（JSON Record<条名, 数值>），按条定义 clamp */
export function readBarValues(json?: string): Record<string, number> {
  if (!json) return {}
  try {
    const o = JSON.parse(json)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch { return {} }
}

export function writeBarValues(vals: Record<string, number>, bars: BarDef[]): string {
  const out: Record<string, number> = {}
  for (const [name, v] of Object.entries(vals)) {
    const def = bars.find((b) => b.name === name)
    out[name] = Math.max(0, Math.min(def?.max ?? 100, Math.round(v)))
  }
  return JSON.stringify(out)
}
