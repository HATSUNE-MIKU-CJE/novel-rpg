/**
 * 引擎自测：node 直接跑（不依赖浏览器）。
 *   npx tsx src/engine/selftest.ts
 */

import { expandMacros } from './macros'
import { parseDreamPlot } from './dreamParser'
import { parseStPresetJson } from './presetImport'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- 宏引擎 ----
{
  console.log('【宏引擎】')
  const vars = new Map<string, string>()
  const globals = new Map<string, string>()
  const ctx = {
    getVar: (n: string) => vars.get(n),
    setVar: (n: string, v: string) => { vars.set(n, v) },
    addVar: (n: string, v: string) => { vars.set(n, (vars.get(n) ?? '') + v) },
    getGlobalVar: (n: string) => globals.get(n),
    setGlobalVar: (n: string, v: string) => { globals.set(n, v) },
    lastUserMessage: '我推开大门',
    charName: '思客',
    userName: '梦客',
    worldbookConstant: '【常驻】铁炉堡是矮人的首都。',
    worldbookKeyed: '【触发】铜须家族是铁炉堡的王室。',
  }

  // setvar 副作用：赋值后输出为空
  const r1 = expandMacros('{{setvar::sleep_var_wenfeng::文风：白话}}', ctx).text
  check('setvar 无输出且写入变量', r1 === '' && vars.get('sleep_var_wenfeng') === '文风：白话', `out=${r1}`)

  // getvar 读取
  const r2 = expandMacros('文风是：{{getvar::sleep_var_wenfeng}}', ctx).text
  check('getvar 读取', r2 === '文风是：文风：白话', r2)

  // addvar 追加
  const r3 = expandMacros('{{addvar::sleep_var_wenfeng::+追加}}', ctx).text
  check('addvar 追加', r3 === '' && vars.get('sleep_var_wenfeng') === '文风：白话+追加')

  // 注释剥离
  const r4 = expandMacros('A{{// 这是一段说明}}B', ctx).text
  check('注释剥离', r4 === 'AB', r4)

  // 嵌套：setvar 值内引用 getvar
  const r5 = expandMacros('{{setvar::x::[{{getvar::sleep_var_wenfeng}}]}}', ctx).text
  check('嵌套宏（值内 getvar）', r5 === '' && vars.get('x') === '[文风：白话+追加]', vars.get('x'))

  // 内置占位符
  const r6 = expandMacros('{{lastUserMessage}} / {{char}} / {{user}}', ctx).text
  check('内置占位符', r6 === '我推开大门 / 思客 / 梦客', r6)

  // 世界书注入点
  const r7 = expandMacros('{{压缩相邻消息::lora_constant}}\n---\n{{压缩相邻消息::lora_key}}', ctx).text
  check('世界书注入点', r7.includes('铁炉堡') && r7.includes('铜须家族'), r7)

  // 未定义变量原样保留（不炸）
  const r8 = expandMacros('{{getvar::不存在的变量}}', ctx).text
  check('未定义变量保留原文', r8 === '{{getvar::不存在的变量}}', r8)

  // 全局变量
  expandMacros('{{setglobalvar::g_test::hello}}', ctx)
  const r9 = expandMacros('{{getglobalvar::g_test}}', ctx).text
  check('全局变量', r9 === 'hello', r9)

  check('变量初始化块顺序执行', (() => {
    const mock = '{{setvar::a::1}}{{setvar::b::2}}{{setvar::c::{{getvar::a}}3}}'
    const v2 = new Map<string, string>()
    const c2 = { ...ctx, getVar: (n: string) => v2.get(n), setVar: (n: string, v: string) => v2.set(n, v), addVar: (n: string, v: string) => v2.set(n, (v2.get(n) ?? '') + v) }
    expandMacros(mock, c2)
    return v2.get('a') === '1' && v2.get('b') === '2' && v2.get('c') === '13'
  })())
}

// ---- dream_plot 解析 ----
{
  console.log('【dream_plot 解析】')
  const xml = `<dream_plot>
<dream_body>
你推开大门，走廊尽头站着一位银发少女。
她回过头，嘴角微扬：「终于等到你了。」
</dream_body>
<dream_after_format>
<dream_scene><date>2024 年 7 月 1 日 周一</date><time>上午 9:00</time><location>异国都城 - 旧王宫 - 东翼走廊</location></dream_scene>
<dream_done/>
</dream_after_format>
</dream_plot>`
  const p = parseDreamPlot(xml)
  check('识别 dream_plot', !!p.isDreamPlot)
  check('正文提取', p.body.includes('银发少女') && !p.body.includes('dream_body'))
  check('场景卡提取', !!(p.scene?.date?.includes('2024') && p.scene?.location?.includes('旧王宫')))
  check('afterFormat 去掉标签', p.afterFormat === '')

  const p2 = parseDreamPlot('普通没有 XML 的回复')
  check('非 XML 原样展示', !p2.isDreamPlot && p2.body === '普通没有 XML 的回复')
  const p3 = parseDreamPlot(`<dream_plot><dream_body>正文</dream_body><dream_after_format><dream_option>走近搭话</dream_option><dream_option>转身离开</dream_option></dream_after_format></dream_plot>`)
  check('选项提取', p3.options.length === 2 && p3.options[0] === '走近搭话')
}

// ---- 预设导入 ----
{
  console.log('【预设导入】')
  const sample = {
    temperature: '1', top_p: '0.95', openai_max_tokens: '30000',
    use_sysprompt: 'True', prompts: [
      { name: '核心', role: 'system', enabled: true, content: '你是思客。' },
      { name: '写作', role: 'user', enabled: true, content: '请写作。' },
      { name: '预填充', role: 'assistant', enabled: false, content: '我开始了。' },
    ],
  }
  const imp = parseStPresetJson(JSON.stringify(sample), 'test.json')
  check('预设名', imp.name === 'test')
  check('prompts 解析', imp.prompts.length === 3 && imp.prompts[0].role === 'system' && !imp.prompts[2].enabled)
  check('参数解析', imp.params.temperature === 1 && imp.params.topP === 0.95 && imp.params.useSysprompt === true)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
