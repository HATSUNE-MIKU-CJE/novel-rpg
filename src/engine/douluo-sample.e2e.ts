/**
 * v3.5 斗罗导入清洗诊断：打印人物卡条目的原文样本（comment/key/content 头部），
 * 用于确定「英文结构（ST 宏/标签/分隔线）」的清洗规则。
 *   npx tsx src/engine/douluo-sample.e2e.ts
 */
import { readFileSync } from 'node:fs'
import { guessKindFromComment, cleanImportedContent } from '../stores/data'

const FILE = process.argv[2] ?? '/home/miku/dsh-work/斗罗大陆Reborn-斗一.json'
const raw = JSON.parse(readFileSync(FILE, 'utf8'))
const entries: any[] = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries)

console.log(`\n===== ${FILE} 共 ${entries.length} 条 =====`)

// 全部 kind 分布
const dist = new Map<string, number>()
for (const e of entries) dist.set(guessKindFromComment(e.comment), (dist.get(guessKindFromComment(e.comment)) ?? 0) + 1)
console.log('kind 分布:', Object.fromEntries(dist))

// 人物卡样本（最多 5 条）：comment + key + content 头部 500 字符
console.log('\n----- 人物卡样本 -----')
let shown = 0
for (const e of entries) {
  if (guessKindFromComment(e.comment) !== 'character') continue
  const c = String(e.content ?? '')
  console.log(`\n[${shown + 1}] comment=${JSON.stringify(e.comment)}`)
  console.log(`    key=${JSON.stringify(e.key ?? e.entry_keys ?? '')} keysecondary=${JSON.stringify(e.keysecondary ?? '')}`)
  console.log(`    content(${c.length}): ${JSON.stringify(c.slice(0, 500))}`)
  if (++shown >= 5) break
}

// 英文结构统计：宏 {{...}}、方括号标签 [A...]、尖括号标签、--- 行
const macros: string[] = []
const tags: string[] = []
let dashLines = 0
let enLabelLines = 0
for (const e of entries) {
  const c = String(e.content ?? '')
  for (const m of c.matchAll(/\{\{[^}]{1,60}\}\}/g)) if (!macros.includes(m[0])) macros.push(m[0])
  for (const t of c.matchAll(/\[[A-Za-z][^\]]{1,40}\]/g)) if (!tags.includes(t[0])) tags.push(t[0])
  for (const t of c.matchAll(/<[A-Za-z][^>]{1,40}>/g)) if (!tags.includes(t[0])) tags.push(t[0])
  for (const line of c.split('\n')) {
    const t = line.trim()
    if (/^---{2,}$/.test(t)) dashLines++
    if (/^[A-Za-z][A-Za-z ]{2,30}:\s*\S/.test(t)) enLabelLines++
  }
}
console.log('\n----- 英文结构统计 -----')
console.log('{{宏}} 去重:', JSON.stringify(macros.slice(0, 30)))
console.log('[标签]/<标签> 去重:', JSON.stringify(tags.slice(0, 30)))
console.log('--- 行数:', dashLines, ' 英文标签行数:', enLabelLines)

// 非人物条目的宏/标签（确认是否全书本就带英文结构）
console.log('\n----- 非人物条目英文结构（抽样） -----')
let extra = 0
for (const e of entries) {
  if (guessKindFromComment(e.comment) === 'character') continue
  const c = String(e.content ?? '')
  const hits = [...c.matchAll(/\{\{[^}]{1,60}\}\}|\[[A-Za-z][^\]]{1,40}\]|<[A-Za-z][^>]{1,40}>/g)]
  if (hits.length && extra < 3) {
    console.log(`  comment=${JSON.stringify(e.comment)} hits=${JSON.stringify(hits.slice(0, 4).map((h) => h[0]))}`)
    extra++
  }
}
console.log('\n[诊断脚本结束]')

// ---- v3.5 清洗对真实数据的验证 ----
let dirtyBefore = 0, dirtyAfter = 0, cleaned = 0
const residues: string[] = []
for (const e of entries) {
  const c = String(e.content ?? '')
  if (!c) continue
  const before = /\{\{[^{}]{1,160}\}\}|<[a-zA-Z][^>]{0,80}>|<!--|^\s*-{3,}\s*$/m.test(c)
  if (before) dirtyBefore++
  const after = cleanImportedContent(c)
  if (/<[a-zA-Z][^>]{0,80}>|<!--|\{\{/.test(after)) residues.push(String(e.comment ?? '').slice(0, 20))
  if (before && !after.includes('{{') && !/<[a-zA-Z][^>]{0,80}>/.test(after)) cleaned++
  if (before) dirtyAfter++
}
console.log(`\n===== 清洗验证（${entries.length} 条） =====`)
console.log(`含 ST 结构条数: ${dirtyBefore} → 清洗后仍含标签/宏: ${residues.length}`)
if (residues.length) console.log('残留样本:', JSON.stringify(residues.slice(0, 5)))
// 人物卡清洗后头部样例
console.log('\n--- 人物卡清洗后 content 头部 ---')
let i = 0
for (const e of entries) {
  if (guessKindFromComment(e.comment) !== 'character') continue
  console.log(`[${i + 1}] ${JSON.stringify(e.comment)} →`, JSON.stringify(cleanImportedContent(String(e.content ?? '')).slice(0, 160)))
  if (++i >= 3) break
}
