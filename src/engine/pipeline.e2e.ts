/**
 * pipeline 端到端自测：mock OpenAI 兼容服务器 + 真实梦鲸思客预设。
 *   npx tsx src/engine/pipeline.e2e.ts
 */
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { parseStPresetJson } from './presetImport'
import { renderPromptChain, chatCompletion } from './pipeline'
import { parseDreamPlot } from './dreamParser'
import type { Message, ApiConfig, Entry } from '../types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- mock OpenAI 服务器 ----
const mockReply = `<dream_plot>
<dream_body>
你站在铁炉堡的青铜大门前，敲了敲厚重的门板。
门内传来浑厚的回音：「什么人？」
</dream_body>
<dream_after_format>
<dream_scene><date>2024 年 7 月 1 日 周一</date><time>上午 9:00</time><location>矮人王国 - 铁炉堡 - 正门</location></dream_scene>
<dream_option>亮明身份：我是从东境来的旅人</dream_option>
<dream_option>后退一步，观察周围环境</dream_option>
<dream_done/>
</dream_after_format>
</dream_plot>`

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    console.log(`  [mock] 收到请求: ${parsed.model}, messages=${parsed.messages.length}, user内容长度=${parsed.messages.find((m: any) => m.role === 'user')?.content.length ?? 0}`)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: mockReply } }] }))
  })
})

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as any).port
console.log(`[mock OpenAI] http://127.0.0.1:${port}/v1`)

// ---- 准备输入 ----
const imp = parseStPresetJson(
  readFileSync('/home/miku/dsh-work/梦鲸思客V4-0731.json', 'utf-8'),
  '梦鲸思客V4-0731.json',
)
const prompts = imp.prompts
const api: ApiConfig = {
  name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key',
  model: 'mock-model', temperature: 1, maxTokens: 4000, topP: 0.95, isDefault: 1, createdAt: 0,
}

const history: Message[] = [
  { campaignId: 1, role: 'user', content: '我来到了铁炉堡门口，敲了敲门。', seq: 1, createdAt: 0 },
  { campaignId: 1, role: 'assistant', content: '你好旅人。', parsedJson: '{}', seq: 2, createdAt: 0 },
]

const constantEntries: Entry[] = [
  { worldbookId: 1, key: '', content: '铁炉堡是矮人王国的都城，建在活火山内部。', enabled: 1, source: 'manual', createdAt: 0, updatedAt: 0 },
]
const keyedEntries: Entry[] = [
  { worldbookId: 1, key: '铁炉堡,矮人', content: '铜须家族是铁炉堡的王族，门上是他们的徽记。', enabled: 1, source: 'manual', createdAt: 0, updatedAt: 0 },
]

// ---- 渲染 ----
console.log('【渲染提示词链】')
let varsChanged = false
const vars = new Map<string, string>()
const rendered = renderPromptChain(
  {
    campaign: { id: 1, name: '测试', autoInterval: 5, createdAt: 0, updatedAt: 0, lastActive: 0 },
    prompts,
    history,
    userName: '梦客',
    charName: '思客',
    constantEntries,
    keyedEntries,
    apiConfig: api,
  },
  {
    get: (n) => vars.get(n),
    set: (n, v) => { vars.set(n, v) },
    add: (n, v) => { vars.set(n, (vars.get(n) ?? '') + v) },
  },
)

check('生成 messages 非空', rendered.messages.length > 0)
check('首条为 system', rendered.messages[0].role === 'system')
const sysText = rendered.messages[0].content
check('system 含核心设定「梦境之神」', sysText.includes('梦鲸思客'))
check('system 含「梦境之神」meta 段', sysText.includes('<meta>') || sysText.includes('核心定义'))
const userText = rendered.messages.filter(m => m.role === 'user').map(m => m.content).join('\n')
check('user 含世界书常驻注入', userText.includes('活火山内部'))
check('user 含世界书触发注入', userText.includes('铜须家族'))
check('user 含对话历史', userText.includes('我来到了铁炉堡门口'))
check('user 含场景协议', userText.includes('DREAM_SCENE_INFO'))
check('user 含写作模式', userText.includes('<dreamer_input>'))
check('user 含思考模板', userText.includes('吾有一梦，今方始筑'))
check('变量已初始化(文风)', (vars.get('sleep_var_wenfeng') ?? '').length > 100)
check('变量已初始化(think flag)', (vars.get('sleep_var_thinking_flag') ?? '').includes('begin'))
check('变量已初始化(字数)', (vars.get('sleep_var_zishu') ?? '').includes('字'))
check('无残留未展开宏', !/（[^）]*?{{[^}]*?}}[^）]*?）/.test(sysText + userText) && !/\{\{[a-zA-Z\u4e00-\u9fff_]+::/.test(sysText + userText))

// ---- 调用 mock + 解析 ----
console.log('【调 API + 解析】')
const reply = await chatCompletion(api, rendered.messages)
check('收到回复', reply.includes('<dream_plot>'))
const parsed = parseDreamPlot(reply)
check('正文提取', parsed.body.includes('青铜大门'))
check('场景卡', !!(parsed.scene && parsed.scene.location?.includes('铁炉堡')))
check('选项 ×2', parsed.options.length === 2)
check('afterFormat 空', parsed.afterFormat === '')
check('isDreamPlot', !!parsed.isDreamPlot)

server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
