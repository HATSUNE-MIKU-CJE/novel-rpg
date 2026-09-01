/**
 * v3.1 卡片引擎纯函数测试：人物卡迁移转换 / 注入分层（P0/P1/P2/时期封存）。
 *   npx tsx src/engine/cards-v3.e2e.ts
 */
import {
  parseCharacterPayload, characterPayloadJson, characterRowToEntry,
  entryToCharacterShape, computeInjectionLayers, renderInjectionText,
  parseLocationPayload, locationPayloadJson,
} from './cards-v3'
import type { Character, Entry } from '../types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('【payload 读写】')
const p = parseCharacterPayload('坏数据{{')
check('坏 JSON → 空 payload', p.name === '')
const p2 = parseCharacterPayload(characterPayloadJson({
  name: '唐舞桐', identity: '蝶神', realm: '二级神祇',
  attributes: [{ label: '智力', value: 8 }, { label: '力量', value: 15 }],
  behavior: '面对戴雨浩绝对信任',
  barValues: { 血条: 80 },
}))
check('payload 往返', p2.name === '唐舞桐' && p2.identity === '蝶神' && p2.attributes?.length === 2)
check('属性钳制 15→100 内', (p2.attributes?.find((a) => a.label === '力量')?.value ?? -1) <= 100)
check('行为逻辑保留', p2.behavior === '面对戴雨浩绝对信任')
check('状态条保留', p2.barValues?.['血条'] === 80)

console.log('【老表 → 人物卡条目】')
const row: Character = {
  id: 7, campaignId: 1, name: '艾莉丝', identity: '见习法师', realm: '炼气三层',
  description: '银发少女，带着旧魔法书',
  attributesJson: '[{"label":"智力","value":8},{"label":"力量","value":4}]',
  barValuesJson: '{"血条":72}',
  source: 'ai', createdAt: 0, updatedAt: 0,
}
const e1 = characterRowToEntry(row, 9)
check('kind=character', e1.kind === 'character' && e1.worldbookId === 9)
check('hook 自动 = 名+身份', e1.hook === '艾莉丝：见习法师', e1.hook)
check('key = 角色名', e1.key === '艾莉丝')
check('content = description', e1.content === '银发少女，带着旧魔法书')
const pe1 = parseCharacterPayload(e1.payloadJson)
check('属性迁入 payload', pe1.attributes?.length === 2 && pe1.attributes![0].value === 8)
check('状态条迁入 payload', pe1.barValues?.['血条'] === 72)

console.log('【人物卡 → 渲染形状】')
const shape = entryToCharacterShape(e1)
check('渲染 shape 兼容老字段', shape.name === '艾莉丝' && shape.identity === '见习法师' && shape.realm === '炼气三层')
check('渲染 shape 带 entryId（无 id 时 0）', typeof shape.entryId === 'number')
check('渲染 shape attributesJson 可解析', JSON.parse(shape.attributesJson ?? '[]').length === 2)

console.log('【注入分层】')
function mkEntry(partial: Partial<Entry>): Entry {
  return {
    id: Math.floor(Math.random() * 1e6),
    worldbookId: 9, kind: 'character', key: '', content: '', enabled: 1,
    source: 'ai', status: 'accepted', createdAt: 0, updatedAt: 0,
    ...partial,
  }
}
const main = mkEntry({ id: 101, key: '阳了', isMain: 1, hook: '阳了：力量7的冒险者', content: '完整人设：性格急躁，讲义气。' })
const ally = mkEntry({ id: 102, key: '小鹿', hook: '小鹿：医者', content: '医者详情：用草药救人。' })
const inactive = mkEntry({ id: 103, key: '老龟', hook: '老龟：智者', content: '智者详情。', timeline: '斗三' })
const noteWorld = mkEntry({ id: 104, kind: 'note', key: '', hook: '世界观基调：灵气复苏', content: '灵气复苏。' })

{
  const layers = computeInjectionLayers([main, ally, inactive, noteWorld], 101, '神界传说', '')
  check('P0 含主角 hook', layers.p0.includes('阳了：力量7的冒险者'))
  check('P0 不含 note（v2 机制处理）', !layers.p0.includes('世界观基调：灵气复苏'))
  check('P1 含配角 hook', layers.p1.includes('小鹿：医者'))
  check('时期封存（斗三 ≠ 神界传说）', !layers.p1.includes('老龟：智者') && layers.p2.length === 0)
  const inj = renderInjectionText(layers)
  check('常驻段含主角', inj.constant.includes('阳了：力量7的冒险者'))
  check('P2 无（未提及）', inj.keyed.length === 0)
}

{
  const layers = computeInjectionLayers([main, ally], 101, '', '小鹿在山路上救人')
  check('提及配角 → P2 触发', layers.p2.some((e) => e.key === '小鹿'))
  const inj = renderInjectionText(layers)
  check('P2 详情展开', inj.keyed.some((k) => k.includes('小鹿：医者详情')))
}

{
  const layers = computeInjectionLayers([main, inactive], 101, '斗三', '')
  check('时期=斗三 → 老龟解封入 P1', layers.p1.includes('老龟：智者'))
}

console.log('【地理卡（v3.2）】')
const loc = parseLocationPayload(locationPayloadJson({ name: '铁炉堡', region: '东部山口', danger: 30, features: '山间要塞，常年冒烟', residents: '矮人铁匠公会' }))
check('地理卡 payload 往返', loc.name === '铁炉堡' && loc.region === '东部山口' && loc.danger === 30)
check('地理卡危险度钳制', parseLocationPayload(locationPayloadJson({ name: 'x', danger: 200 })).danger === 100)
const locEntry = mkEntry({ id: 201, kind: 'location', key: '铁炉堡', hook: '铁炉堡：矮人要塞', content: '山间要塞，常年冒烟。' })
{
  const layers = computeInjectionLayers([main, locEntry], 101, '神界传说', '')
  check('地理卡未提及 → P1 hook', layers.p1.includes('铁炉堡：矮人要塞'))
  const inj = renderInjectionText(layers)
  check('地理卡常驻段含 hook', inj.constant.includes('铁炉堡：矮人要塞'))
}
{
  const layers = computeInjectionLayers([main, locEntry], 101, '神界传说', '穿过铁炉堡的城门')
  check('提及地理卡 → P2 触发', layers.p2.some((e) => e.key === '铁炉堡'))
  const inj = renderInjectionText(layers)
  check('地理卡详情展开', inj.keyed.some((k) => k.includes('铁炉堡：山间要塞')))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
