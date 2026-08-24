/**
 * v2 新模块自测：定价折算 + 峰谷判定 + 内置预设渲染。
 *   npx tsx src/engine/selftest2.ts
 */

import { isPeakHour, estimateCostYuan, parseUsage, DEEPSEEK_PRICES } from './pricing'
import { buildDreamPromptBlocks, buildVarInitText, defaultDreamConfig, DREAM_GROUPS } from './dreamPreset'
import { expandMacros } from './macros'
import type { DreamConfig } from './dreamPreset'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- 峰谷判定 ----
console.log('【峰谷判定（北京时间）】')
// 2026-08-17 是周一。9:00 高峰、12:00 整点后空闲、14:00 高峰、18:00 空闲、周末空闲
check('工作日 9:30 高峰', isPeakHour(new Date('2026-08-17T01:30:00Z')))      // 北京 09:30
check('工作日 11:59 高峰', isPeakHour(new Date('2026-08-17T03:59:00Z')))      // 北京 11:59
check('工作日 12:01 空闲', !isPeakHour(new Date('2026-08-17T04:01:00Z')))     // 北京 12:01
check('工作日 15:00 高峰', isPeakHour(new Date('2026-08-17T07:00:00Z')))      // 北京 15:00
check('工作日 18:01 空闲', !isPeakHour(new Date('2026-08-17T10:01:00Z')))     // 北京 18:01
check('周六 10:00 空闲', !isPeakHour(new Date('2026-08-22T02:00:00Z')))       // 北京 10:00 周六
check('周日 14:00 空闲', !isPeakHour(new Date('2026-08-23T06:00:00Z')))       // 北京 14:00 周日
check('深夜 3:00 空闲', !isPeakHour(new Date('2026-08-18T19:00:00Z')))        // 北京 03:00

// ---- 价格折算 ----
console.log('【价格折算】')
// flash：命中 0.05/0.10，未命中 1.5/3.0，输出 4.5/9.0（元/百万）
const usage = { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000, cacheHitTokens: 400_000, cacheMissTokens: 600_000 }
const idle = estimateCostYuan('deepseek-v4-flash', usage, new Date('2026-08-17T04:01:00Z'))  // 空闲
check('flash 空闲估算', idle !== null && Math.abs(idle.costYuan - (0.4 * 0.05 + 0.6 * 1.5 + 0.5 * 4.5)) < 1e-9, `got ${idle?.costYuan}`)
const peak = estimateCostYuan('deepseek-v4-flash', usage, new Date('2026-08-17T01:30:00Z'))  // 高峰
check('flash 高峰估算', peak !== null && Math.abs(peak.costYuan - (0.4 * 0.1 + 0.6 * 3.0 + 0.5 * 9.0)) < 1e-9, `got ${peak?.costYuan}`)
check('pro 价格表存在', DEEPSEEK_PRICES['deepseek-v4-pro']?.outPeak === 27)
check('未知模型返回 null', estimateCostYuan('gpt-4o', usage, new Date()) === null)

// ---- usage 解析 ----
console.log('【usage 解析】')
const u1 = parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
check('标准 usage', u1?.totalTokens === 30)
const u2 = parseUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })
check('DeepSeek 缓存字段', u2?.cacheHitTokens === 80 && u2?.cacheMissTokens === 20)
check('无 usage 返回 null', parseUsage({}) === null)

// ---- 内置预设 ----
console.log('【内置预设】')
const groups: DreamConfig = defaultDreamConfig()
check('12 组配置默认值（+custom 容器）', Object.keys(groups).length === 13 && Object.keys(groups.custom || {}).length === 0)
check('默认文风为梦白话', groups['main_style'] === 'baihua')
check('默认次要文风两项', (groups['minor_style'] as string[]).length === 2)
check('输出模式默认写作', groups['output_mode'] === 'writing')

const blocks = buildDreamPromptBlocks(groups)
check('生成提示词块', blocks.length >= 10, `got ${blocks.length}`)
check('含核心 system', blocks[0].name === '梦境思客' && blocks[0].role === 'system')
check('含变量初始化块', blocks.some((b) => b.name === '变量初始化'))
check('含写作模式', blocks.some((b) => b.name === '写作模式'))
check('含场景协议', blocks.some((b) => b.name === '梦境场景信息'))

const varInit = buildVarInitText(groups)
check('变量初始化含 schema', varInit.includes('sleep_var_schema'))
check('变量初始化含默认协议', varInit.includes('DREAM_PLOT_OUTPUT'))
check('变量初始化含文风设定', varInit.includes('sleep_var_wenfeng'))
check('变量初始化含 thinking flag（自动渠道不含手动标记）', !varInit.includes('THINK_FLAG_X'))

// 自动渠道：模型名为 kimi → kimi 标记；deepseek → 官方标记；其他 → <think>
const varInitKimi = buildVarInitText(groups, 'kimi-k3')
check('自动渠道 kimi 标记', varInitKimi.includes('<|open|>think<|sep|>'))
const varInitDs = buildVarInitText(groups, 'deepseek-v4-pro')
check('自动渠道 deepseek 官方标记', varInitDs.includes('thinking'))
const varInitOther = buildVarInitText(groups, 'gpt-4o')
check('自动渠道其他 → <think>', varInitOther.includes('<think>'))

// 自定义参数内联：自定义字数
const customCfg: DreamConfig = { ...groups, length: 'custom', custom: { customLength: '1500' } }
const varInitCustom = buildVarInitText(customCfg)
check('自定义字数内联 1500', varInitCustom.includes('1500'))
// 自定义文风
const customCfg2: DreamConfig = { ...groups, main_style: 'custom', custom: { customStyle: '古风文言，冷硬克制' } }
const varInitCustom2 = buildVarInitText(customCfg2)
check('自定义文风内联', varInitCustom2.includes('古风文言，冷硬克制'))
// 宏注入转义
const customCfg3: DreamConfig = { ...groups, main_style: 'custom', custom: { customStyle: '{{evil}}' } }
const varInitCustom3 = buildVarInitText(customCfg3)
check('宏注入转义', !varInitCustom3.includes('{{evil}}') && varInitCustom3.includes('‹‹evil››'))

// 渲染链验证：用宏引擎展开变量初始化
const vars = new Map<string, string>()
expandMacros(varInit, {
  getVar: (n) => vars.get(n),
  setVar: (n, v) => { vars.set(n, v) },
  addVar: (n, v) => { vars.set(n, (vars.get(n) ?? '') + v) },
  getGlobalVar: () => undefined,
  setGlobalVar: () => {},
  lastUserMessage: '', charName: '', userName: '',
  worldbookConstant: '', worldbookKeyed: '',
})
check('展开后 wenfeng 非空', (vars.get('sleep_var_wenfeng') ?? '').length > 50)
check('展开后 zishu 动态长', (vars.get('sleep_var_zishu') ?? '').includes('1000 到 2000'))
check('展开后协议含 SCENE_INFO', (vars.get('sleep_dream_protocol') ?? '').includes('DREAM_SCENE_INFO'))
check('展开后 ban_word 含破折号禁词', (vars.get('sleep_var_ban_word') ?? '').includes('破折号'))
check('展开后 thinking_level 为标准思考', (vars.get('sleep_var_thinking_level') ?? '').includes('2000 token'))

// 宝宝化档位：叙事者色号人格标签
const narratorGroup = DREAM_GROUPS.find((g) => g.id === 'narrator')!
check('叙事者含色号人格', narratorGroup.options.some((o) => o.id === 'balanced' && o.label === '中庸之白' && o.color === '⚪'))
check('叙事者含狂澜之青', narratorGroup.options.some((o) => o.id === 'surprise' && o.label === '狂澜之青'))
// 思考强度宝宝化命名
const thinkGroup = DREAM_GROUPS.find((g) => g.id === 'thinking')!
check('思考强度宝宝化（轻快/标准/深度/极致）', thinkGroup.options.every((o) => ['轻快思考', '标准思考', '深度思考', '极致思考'].includes(o.label)))
// 渠道适配默认自动
const channelGroup = DREAM_GROUPS.find((g) => g.id === 'channel')!
check('渠道适配默认自动', channelGroup.defaultSingle === 'auto')
// 动态字数短 = 500-1200（原文修正）
const dynShort = DREAM_GROUPS.find((g) => g.id === 'length')!.options.find((o) => o.id === 'dyn_short')!
check('动态字数短修正 500-1200', dynShort.vars![0].value.includes('500 到 1200'))
// 所有选项都有 desc
check('所有选项含一句话描述', DREAM_GROUPS.every((g) => g.options.every((o) => o.desc?.length > 0)))

// 输出模式切换
const chatCfg = { ...groups, output_mode: 'chat' }
const chatBlocks = buildDreamPromptBlocks(chatCfg)
check('聊天模式块', chatBlocks.some((b) => b.name === '聊天模式') && !chatBlocks.some((b) => b.name === '写作模式'))

// 多选关闭
const noProto = { ...groups, protocols: [] }
const noProtoBlocks = buildDreamPromptBlocks(noProto)
check('协议全关时不含场景信息', !noProtoBlocks.some((b) => b.name === '梦境场景信息'))

// 禁词关闭
const noBan = { ...groups, banword: 'off' }
const noBanInit = buildVarInitText(noBan)
const vars2 = new Map<string, string>()
expandMacros(noBanInit, {
  getVar: (n) => vars2.get(n),
  setVar: (n, v) => { vars2.set(n, v) },
  addVar: (n, v) => { vars2.set(n, (vars2.get(n) ?? '') + v) },
  getGlobalVar: () => undefined, setGlobalVar: () => {},
  lastUserMessage: '', charName: '', userName: '',
  worldbookConstant: '', worldbookKeyed: '',
})
check('禁词关闭后 ban_word 为空', (vars2.get('sleep_var_ban_word') ?? '') === '')

// 分组完整性
check('文风组含 NSFW 选项', !!(DREAM_GROUPS.find(g => g.id === 'minor_style')?.options.some(o => o.id === 'nsfw_direct')))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
