/**
 * v1.2/1.3 双流与属性体系纯函数测试：属性合并 / 属性清洗 / schema 解析。
 *   npx tsx src/engine/stream.e2e.ts
 */
import { mergeAttrs, sanitizeResult, extractJson, makeSystemPrompt, parseAttrSchema, normCategory } from './extractor'
import type { ExtractResult } from './extractor'

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

console.log('【属性体系 schema】')
const dflt = parseAttrSchema(undefined)
check('缺省 = 通用六维', dflt.dims.length === 6 && dflt.dims[0].label === '力量' && dflt.realmLabel === '境界')
check('坏 JSON → 默认', parseAttrSchema('{{bad').dims.length === 6)
const custom = parseAttrSchema(JSON.stringify({ dims: [{ label: ' 体魄 ' }, { label: '' }, { label: '灵根' }], realmLabel: '段位' }))
check('自定义解析 + 清洗', custom.dims.length === 2 && custom.dims[0].label === '体魄' && custom.realmLabel === '段位')
check('维度上限 10', parseAttrSchema(JSON.stringify({ dims: Array.from({ length: 14 }, (_, i) => ({ label: 'd' + i })) })).dims.length === 10)

console.log('【类别归一 & 提示词】')
check('合法类别', normCategory('修炼体系') === '修炼体系')
check('非法类别 → 其他', normCategory('乱写') === '其他')
check('空类别 → 其他', normCategory(undefined) === '其他')
const sp = makeSystemPrompt(['力量', '敏捷'], '境界')
check('提示词含维度', sp.includes('「力量、敏捷」') && sp.includes('境界'))
const sp2 = makeSystemPrompt([], '')
check('无维度 → 自由命名提示', sp2.includes('自由命名') && !sp2.includes('realm'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
