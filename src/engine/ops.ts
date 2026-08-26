/**
 * v1.5 AI 操作协议：交流栏主持可在回复末尾输出 [[WB]]{json}[[/WB]] 块，
 * App 解析后写入「操作审计」（临时区），确认后执行。
 */

import { extractJson } from './extractor'

/** 协议块载荷（宽松结构，按 op 取字段） */
export interface OpBlock {
  op: string
  /** 条目编号引用（参考清单【n】）；App 提交时解析为 entryId */
  ref?: number
  /** 已解析的条目 id（提交时写入，执行用） */
  entryId?: number
  key?: string          // entry.* 触发词
  content?: string      // entry 内容 / char 描述
  category?: string     // 世界类别
  name?: string         // char 名
  identity?: string
  realm?: string
  description?: string
  attrs?: Array<{ label: string; value: number }>
  from?: string         // rename 旧名
  to?: string           // rename 新名
  relType?: string
  label?: string
  dims?: Array<{ label: string }>   // schema.propose
  realmLabel?: string
}

export const OP_KINDS = new Set([
  'entry.upsert', 'entry.delete', 'entry.disable',
  'char.upsert', 'char.rename',
  'rel.upsert', 'rel.delete',
  'schema.propose',
])

/** 从 AI 回复提取协议块，返回净化后的正文 + 操作列表（最多 5 条） */
export function parseOps(text: string): { clean: string; ops: OpBlock[] } {
  const ops: OpBlock[] = []
  const clean = text
    .replace(/\[\[WB\]\]([\s\S]*?)\[\[\/WB\]\]/gi, (_m, inner: string) => {
      try {
        const p = extractJson<OpBlock>(inner)
        if (p?.op && OP_KINDS.has(p.op)) ops.push(p)
      } catch { /* 坏块忽略 */ }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, ops: ops.slice(0, 5) }
}

/** 操作大类 → 展示色标 */
export function opGroup(kind: string): 'new' | 'mod' | 'rename' | 'del' | 'attr' | 'other' {
  switch (kind) {
    case 'entry.upsert': case 'char.upsert': case 'rel.upsert': return 'new'
    case 'entry.disable': return 'mod'
    case 'char.rename': return 'rename'
    case 'entry.delete': case 'rel.delete': return 'del'
    case 'schema.propose': return 'attr'
    default: return 'other'
  }
}

/** 操作大类 → 中文标签 */
export function opGroupLabel(kind: string): string {
  switch (opGroup(kind)) {
    case 'new': return '新增'
    case 'mod': return '修改'
    case 'rename': return '改名'
    case 'del': return '删除'
    case 'attr': return '属性'
    default: return '操作'
  }
}

/**
 * 把 AI 块里的 ref（参考清单编号）就地解析成 entryId。
 * refs：AI 提交时点构建的参考清单 [{seq, entryId}]（与 buildTalkSystem 编号一致）。
 * 解析失败的块（ref 越界等）保留原样（执行时回退 key 匹配，失败则提示）。
 */
export function resolveRefs(ops: OpBlock[], refs: Array<{ seq: number; entryId: number }>): OpBlock[] {
  const map = new Map<number, number>()
  for (const r of refs) map.set(r.seq, r.entryId)
  return ops.map((o) => {
    if (typeof o.ref === 'number' && map.has(o.ref)) {
      return { ...o, entryId: map.get(o.ref), ref: undefined }
    }
    return o
  })
}

/** 操作标题（一行动态描述） */
export function opTitle(p: OpBlock): string {
  switch (p.op) {
    case 'entry.upsert': return p.key ? `世界书条目「${p.key}」` : '世界书条目（常驻）'
    case 'entry.delete': return `删除世界书条目「${p.key ?? '常驻'}」`
    case 'entry.disable': return `停用世界书条目「${p.key ?? '常驻'}」`
    case 'char.upsert': return `角色「${p.name}」`
    case 'char.rename': return `角色改名「${p.from}」→「${p.to}」`
    case 'rel.upsert': return `关系「${p.from} ↔ ${p.to}」（${p.relType}）`
    case 'rel.delete': return `删除关系「${p.from} ↔ ${p.to}」（${p.relType}）`
    case 'schema.propose': return '属性体系建议'
    default: return '未知操作'
  }
}
