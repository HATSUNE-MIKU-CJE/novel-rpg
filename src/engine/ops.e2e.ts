/**
 * v1.5 AI 操作协议解析测试。
 *   npx tsx src/engine/ops.e2e.ts
 */
import { parseOps, opGroup, opGroupLabel, opTitle, resolveRefs, parseBars } from './ops'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('【parseOps 解析】')
const r1 = parseOps('已记下。\n[[WB]]{"op":"entry.upsert","key":"铁炉堡","content":"东境狼群","category":"地理环境"}[[/WB]]')
check('净化正文（块剥除）', r1.clean === '已记下。', JSON.stringify(r1.clean))
check('单块解析', r1.ops.length === 1 && r1.ops[0].op === 'entry.upsert' && r1.ops[0].content === '东境狼群')

const r2 = parseOps('好，两条都记。\n[[WB]]{"op":"char.rename","from":"爱丽丝","to":"艾莉丝"}[[/WB]]\n[[WB]]{"op":"rel.upsert","from":"艾莉丝","to":"铁锤","relType":"同伴"}[[/WB]]')
check('多块解析', r2.ops.length === 2 && r2.ops[1].op === 'rel.upsert')
check('多块净化（连续空行压缩）', !r2.clean.includes('[[/WB]]') && !r2.clean.includes('\n\n\n'))

const r3 = parseOps('[[WB]]{"op":"evil.hack","x":1}[[/WB]] 保重')
check('未知 op 忽略', r3.ops.length === 0 && r3.clean === '保重')

const r4 = parseOps('a[[WB]]{{bad json[[/WB]]b')
check('坏块忽略（干净文本保留）', r4.ops.length === 0)

const big = Array.from({ length: 8 }, (_, i) => `[[WB]]{"op":"entry.upsert","content":"c${i}"}[[/WB]]`).join('\n')
check('超 5 条截断', parseOps(big).ops.length === 5)

const r5 = parseOps('全文不写块')
check('无块 → ops 空', r5.ops.length === 0 && r5.clean === '全文不写块')

console.log('【操作展示映射】')
check('分组：删除类', opGroup('entry.delete') === 'del' && opGroup('rel.delete') === 'del')
check('分组：新增类', opGroup('char.upsert') === 'new' && opGroup('entry.upsert') === 'new')
check('分组：改名/属性', opGroup('char.rename') === 'rename' && opGroup('schema.propose') === 'attr')
check('标签中文', opGroupLabel('char.rename') === '改名' && opGroupLabel('entry.delete') === '删除')
check('标题', opTitle({ op: 'char.rename', from: '爱丽丝', to: '艾莉丝' }) === '角色改名「爱丽丝」→「艾莉丝」')
check('标题（条目）', opTitle({ op: 'entry.upsert', key: '修炼体系' }) === '世界书条目「修炼体系」')

console.log('【ref 编号解析】')
const refs = [{ seq: 1, entryId: 101 }, { seq: 2, entryId: 102 }]
const rr = resolveRefs([
  { op: 'entry.delete', ref: 1 },
  { op: 'entry.upsert', ref: 2, content: '新内容' },
  { op: 'entry.delete', ref: 99 },
  { op: 'entry.upsert', content: '无 ref' },
], refs)
check('ref 解析成 entryId', rr[0].entryId === 101 && rr[0].ref === undefined)
check('多字段保留', rr[1].entryId === 102 && rr[1].content === '新内容')
check('越界 ref 原样保留', rr[2].ref === 99 && rr[2].entryId === undefined)
check('无 ref 不动', rr[3].entryId === undefined)

console.log('【parseBars 直通块】')
const pb = parseBars('战斗结束。\n[[BAR]]{"name":"艾莉丝","values":{"血条":72,"蓝条":30}}[[/BAR]]')
check('BAR 块剥除', pb.clean === '战斗结束。')
check('数值解析', pb.updates.length === 1 && pb.updates[0].values['血条'] === 72)
const pb2 = parseBars('[[BAR]]{"values":{"血条":"bad"}}[[/BAR]]x')
check('坏值忽略', pb2.updates.length === 0)
const pb3 = parseBars('无块')
check('无块 → 原样', pb3.clean === '无块' && pb3.updates.length === 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
