/**
 * v2.1 解析容错回归：坏结构 dream_plot（未闭合 body / 杂质前缀 / 无 plot 标签）应提取正文而非原文。
 *   npx tsx src/e2e/parse-e2e.ts
 */
import { parseDreamPlot } from '../engine/dreamParser'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const GOOD = `<dream_plot><dream_body>正常正文内容。</dream_body></dream_plot>`
const NO_CLOSE = `<dream_plot><dream_body>这是正文，但没闭合标签后面还有一段。</dream_plot>`
const PREFIX_LEAK = `在正文前需输出<dream_scene>信息栏\n二、辨视角：参与角色林一\n<dream_plot><dream_body>好正文开始了。他说你好。</dream_body><dream_after_format><dream_done/></dream_after_format></dream_plot>`
const SCENE_IN_BODY = `<dream_plot><dream_body><dream_scene><date>2018年</date></dream_scene>正文在场景后。</dream_body></dream_plot>`
const RAW = `完全没有标签的普通文本`

// 1. 正常结构
let r = parseDreamPlot(GOOD)
check('正常结构 body', r.body === '正常正文内容。', r.body)
check('正常结构 isDreamPlot', r.isDreamPlot === true)

// 2. dream_body 未闭合
r = parseDreamPlot(NO_CLOSE)
check('未闭合 body 提取正文', r.body.includes('这是正文，但没闭合标签') && !r.body.includes('<dream'), r.body)

// 3. 杂质前缀（AI 复述提示词）
r = parseDreamPlot(PREFIX_LEAK)
check('杂质前缀被剥离', r.body === '好正文开始了。他说你好。', r.body)
check('杂质前缀 isDreamPlot 仍识别', r.isDreamPlot === true)
check('杂质不落入 afterFormat', !r.afterFormat.includes('辨视角'), r.afterFormat)

// 4. scene 在 body 内（未闭合标签时）
r = parseDreamPlot(SCENE_IN_BODY)
check('body 内 scene 标签剥除', r.body === '正文在场景后。', r.body)
check('scene 单独提取', r.scene?.date === '2018年')

// 5. 完全无标签
r = parseDreamPlot(RAW)
check('无标签回退原文', r.body === RAW && r.isDreamPlot === false)

// 6. 流式中间态（XML 未闭合、只有前半）
r = parseDreamPlot('<dream_plot>\n<dream_body>\n<dream_scene>\n<date>2018年6月3日')
check('流式中间态显示正文前缀', r.body.includes('2018年6月3日') || r.body.length > 0)

// 7. v2.1.1：after_format 塞入写作规范 + 正文副本 + [[BAR]]（用户复现）
const LEAK = `<dream_plot><dream_body>这是纯净正文。</dream_body>
<dream_after_format>
，其中可包含状态栏。
二、辨视角：
- 主要角色：林一。只有自然环境和动物（苍鹭）。
三、遵写规：
- 文风：直接白话
[[BAR]]{"name":"林一","values":{"血条":72}}[[/BAR]]
</dream_after_format></dream_plot>`
r = parseDreamPlot(LEAK)
check('after_format 复述置空', r.afterFormat === '', JSON.stringify(r.afterFormat))
check('正文不受影响', r.body === '这是纯净正文。', r.body)
check('BAR 不入 afterFormat', !r.afterFormat.includes('BAR'))
check('BAR 不入 body', !r.body.includes('BAR'))

// 8. after_format 超长（正文镜像）→ 置空
const MIRROR = `<dream_plot><dream_body>短正文。</dream_body><dream_after_format>${'复'.repeat(400)}</dream_after_format></dream_plot>`
r = parseDreamPlot(MIRROR)
check('after_format 超长镜像置空', r.afterFormat === '', String(r.afterFormat.length))

// 9. after_format 合法短内容保留
const OKAF = `<dream_plot><dream_body>正文。</dream_body><dream_after_format>碎石路，风停了。</dream_after_format></dream_plot>`
r = parseDreamPlot(OKAF)
check('after_format 合法短内容保留', r.afterFormat === '碎石路，风停了。', r.afterFormat)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
