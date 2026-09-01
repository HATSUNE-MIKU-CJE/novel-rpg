/**
 * v3.2 斗罗世界书导入验证：解析真实 ST JSON → 分类 kind → 检查分布。
 *   npx tsx src/engine/import-douluo.e2e.ts
 */
import { readFileSync } from 'node:fs'
import { guessKindFromComment, guessHookFromEntry } from '../stores/data'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const file = '/home/miku/dsh-work/斗罗大陆Reborn.json'
const text = readFileSync(file, 'utf8')
const data = JSON.parse(text)

check('文件可解析（entries 为对象）', data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries))
const entries: any[] = Array.isArray(data.entries) ? data.entries : Object.values(data.entries)
check('条目数 > 20', entries.length > 20, `got ${entries.length}`)

// 分类分布
const dist = new Map<string, number>()
for (const e of entries) {
  const k = guessKindFromComment(e.comment)
  dist.set(k, (dist.get(k) ?? 0) + 1)
}
console.log('分类分布:', Object.fromEntries(dist))
check('有人物卡', (dist.get('character') ?? 0) > 0)
check('有地点卡', (dist.get('location') ?? 0) > 0)
check('有规则卡', (dist.get('rule') ?? 0) > 0)

// hook 提取抽样
const sample = entries.slice(0, 5).map((e) => ({ comment: String(e.comment ?? '').slice(0, 20), hook: guessHookFromEntry(e, 'character') }))
console.log('hook 抽样:', JSON.stringify(sample))
check('唐舞桐 hook 提取 = 唐舞桐', sample.some((s) => s.hook === '唐舞桐'))

// 关键锚点内容检查（第一条唐舞桐带 character_anchor）
const tang = entries.find((e) => JSON.stringify(e.comment ?? '').includes('唐舞桐'))
check('唐舞桐条目存在', !!tang)
check('唐舞桐是 character 卡', tang ? guessKindFromComment(tang.comment) === 'character' : false)

// ── 拆分文件验证（scripts/split-douluo.mjs 产物）─────────────────
const vols = ['斗一', '斗二', '斗三', '斗四', '通用']
for (const vol of vols) {
  const f = `/home/miku/dsh-work/斗罗大陆Reborn-${vol}.json`
  const d = JSON.parse(readFileSync(f, 'utf8'))
  const es2: any[] = Object.values(d.entries)
  const dist2 = new Map<string, number>()
  let mismatch = 0
  for (const e of es2) {
    const k = guessKindFromComment(e.comment)
    dist2.set(k, (dist2.get(k) ?? 0) + 1)
    const hit = String(e.comment ?? '').match(/斗[一二三四五]/)
    if (vol === '通用' ? hit : !(hit && hit[0] === vol)) mismatch++
  }
  check(`拆分文件 ${vol} 可解析且 >10 条`, es2.length > 10, `got ${es2.length}`)
  check(`拆分文件 ${vol} 卷标纯净`, mismatch === 0, `错卷 ${mismatch}`)
  console.log(`  [${vol}] 分布:`, Object.fromEntries(dist2))
}
check('斗一含人物/地点/规则卡', (() => {
  const d = JSON.parse(readFileSync('/home/miku/dsh-work/斗罗大陆Reborn-斗一.json', 'utf8'))
  const m = new Map<string, number>()
  for (const e of Object.values(d.entries as any[])) m.set(guessKindFromComment(e.comment), (m.get(guessKindFromComment(e.comment)) ?? 0) + 1)
  return (m.get('character') ?? 0) > 0 && (m.get('location') ?? 0) > 0 && (m.get('rule') ?? 0) > 0
})())
check('通用文件含规则卡', JSON.parse(readFileSync('/home/miku/dsh-work/斗罗大陆Reborn-通用.json', 'utf8')).entries && Object.values(JSON.parse(readFileSync('/home/miku/dsh-work/斗罗大陆Reborn-通用.json', 'utf8')).entries).some((e: any) => guessKindFromComment(e.comment) === 'rule'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
