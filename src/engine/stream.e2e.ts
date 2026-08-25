/**
 * v1.2 双流相关纯函数测试：属性合并 / 属性清洗。
 *   npx tsx src/engine/stream.e2e.ts
 */
import { mergeAttrs, sanitizeResult, type ExtractResult } from './extractor'
import { extractJson } from './extractor'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('【mergeAttrs 属性合并】')
const r1 = mergeAttrs(undefined, [{ label: '智力', value: 8 }])
check('无旧属性 → 生成', r1 === '[{"label":"智力","value":8}]', r1)
const r2 = mergeAttrs(r1, [{ label: '智力', value: 9 }, { label: '胆识', value: 6 }])
const r2p = JSON.parse(r2!)
check('新值覆盖旧值', r2p.find((a: any) => a.label === '智力')?.value === 9, r2)
check('新 label 追加', r2p.find((a: any) => a.label === '胆识')?.value === 6, r2)
const r3 = mergeAttrs(r2, [{ label: '力量', value: 7 }, { label: '魅力', value: 8 }, { label: '感知', value: 5 }, { label: '敏捷', value: 6 }, { label: '耐力', value: 4 }, { label: '灵性', value: 9 }, { label: '幸运', value: 3 }])
const r3p = JSON.parse(r3!)
check('超 6 条截断', r3p.length === 6 && !r3p.some((a: any) => a.label === '幸运'), JSON.stringify(r3p))
const r4 = mergeAttrs('坏数据{{', [{ label: '智力', value: 1 }])
check('旧数据坏 → 忽略并重写', JSON.parse(r4!)[0].value === 1)
check('无新属性 → 返回原样', mergeAttrs(r1, undefined) === r1)

console.log('【sanitizeResult 属性清洗】')
const parsed = extractJson<ExtractResult>('{"characters":[{"name":"甲","attributes":[{"label":"力量","value":11},{"label":"灵性","value":-2.5},{"label":"","value":3},{"label":"感知","value":"x"}]}]}')
const clean = sanitizeResult(parsed!)
check('11 钳到 10', clean.characters[0].attributes?.[0].value === 10)
check('负数钳到 0', clean.characters[0].attributes?.find((a) => a.label === '灵性')?.value === 0)
check('空 label 过滤', clean.characters[0].attributes?.length === 2, JSON.stringify(clean.characters[0].attributes))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
