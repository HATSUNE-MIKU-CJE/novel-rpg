/**
 * 浏览器端到端测试 v2：内置节点 → 新建存档（内置预设）→ mock API 对话 → token 显示。
 *   npx tsx src/e2e/uitest.ts
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

// ---- mock OpenAI（对话 dream_plot + 事实提取 JSON，按 system 提示词区分）----
const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    const lastUser = parsed.messages.filter((m: any) => m.role === 'user').at(-1)
    const lines = (lastUser?.content ?? '').split('\n').filter((l: string) => l.trim())
    const echoed = lines.at(-1) ?? ''
    const sysText = (parsed.messages[0]?.content ?? '').slice(0, 80)

    // 事实提取请求：system 是「书记官」
    let content: string
    if (sysText.includes('书记官')) {
      content = '```json\n{"characters":[{"name":"艾莉丝","identity":"见习法师","description":"银发少女，带着旧魔法书"},{"name":"铁锤","identity":"卫队长","description":"魁梧矮人"}],"relations":[{"from":"艾莉丝","to":"铁锤","relType":"同伴"}],"facts":[{"key":"铁炉堡","content":"铁炉堡东境出现狼群。"},{"key":"艾莉丝","content":"艾莉丝的旧魔法书疑似来自王室。"},{"key":"","content":"王族徽记是锤与铁砧交叉图案。"}]}\n```'
    } else {
      content = `<dream_plot>\n<dream_body>回应：「${echoed.slice(0, 40)}」</dream_body>\n<dream_after_format>\n<dream_done/>\n</dream_after_format>\n</dream_plot>`
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      // 模拟 DeepSeek 官方 usage（含缓存字段）
      usage: {
        prompt_tokens: 3200, completion_tokens: 450, total_tokens: 3650,
        prompt_cache_hit_tokens: 2400, prompt_cache_miss_tokens: 800,
      },
      choices: [{ message: { role: 'assistant', content } }],
    }))
  })
})

await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const port = (mock.address() as any).port
console.log(`[mock] http://127.0.0.1:${port}/v1`)

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)

// ---- 1. 内置节点已种入 ----
console.log('【内置节点】')
check('DeepSeek 官方节点存在', await page.getByText('DeepSeek 官方', { exact: false }).count() > 0)
check('opencode-go 节点存在', await page.getByText('opencode-go 网关', { exact: false }).count() > 0)
check('内置节点有「待填 Key」标记', await page.getByText('待填 Key').count() > 0)

// ---- 2. 给 opencode-go 填 key + 改 baseUrl 为 mock（设为默认）----
console.log('【配置 Key】')
await page.locator('.list-row', { hasText: 'opencode-go 网关' }).getByRole('button', { name: '编' }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${port}/v1`)
await page.getByPlaceholder('sk-…').fill('test-key')
await page.getByPlaceholder('如：deepseek-v4-flash').fill('deepseek-v4-flash')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(500)
// opencode-go 行的待填标记应消失（DeepSeek 官方节点仍待填，只查本行）
const ocRow = page.locator('.list-row', { hasText: 'opencode-go 网关' })
check('Key 已填（本行待填标记消失）', !(await ocRow.innerText()).includes('待填 Key'))

// ---- 3. 预设开关面板（无存档时应显示提示）----
console.log('【预设开关】')
await page.getByRole('button', { name: /🎛 预设/ }).click()
await page.waitForTimeout(400)
check('无存档提示', await page.getByText('先打开一个存档').count() > 0)
await page.getByRole('button', { name: /🔌 API/ }).click()

// ---- 4. 新建存档（内置预设）----
console.log('【存档+对话】')
await page.locator('.tabbar').getByText('对话').click()
await page.getByRole('button', { name: '＋ 新档' }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('铁炉堡篇')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)
check('存档已创建', await page.getByText('铁炉堡篇', { exact: true }).count() > 0)
check('快捷模式栏出现（写作）', await page.getByText('✍️ 写作').count() > 0)

// 发消息
await page.locator('.chat-input textarea').fill('我来到了铁炉堡门口，敲了敲门。')
await page.getByRole('button', { name: '➤' }).click()
await page.waitForTimeout(2500)
check('用户消息上屏', await page.getByText('我来到了铁炉堡门口，敲了敲门。').count() > 0)
check('AI 回复上屏', await page.getByText(/回应：/).count() > 0)
check('token 统计显示', await page.getByText(/共 3\.7k token/).count() > 0)
check('金额折算显示', await page.getByText(/¥0\./).count() > 0)

// ---- 5. 打开预设开关面板（现在有存档了）----
await page.locator('.tabbar').getByText('设置').click()
await page.getByRole('button', { name: /🎛 预设/ }).click()
await page.waitForTimeout(400)
check('预设面板标题', await page.getByText('梦鲸思客·精简 · 预设开关').count() > 0)
check('主要文风组存在', await page.getByText('📚 主要文风').count() > 0)

// ---- 6. M4：手动整理世界书 ----
console.log('【M4 整理世界书】')
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /整理世界书/ }).click()
await page.waitForTimeout(2000)
check('角色卡出现（艾莉丝）', await page.getByText('艾莉丝', { exact: false }).count() > 0)
check('角色身份显示', await page.getByText('见习法师', { exact: false }).count() > 0)
check('整理统计显示', await page.getByText(/上次整理/).count() > 0)

// 待审阅区
await page.getByRole('button', { name: /📚 世界书/ }).click()
await page.waitForTimeout(400)
check('待审阅区出现', await page.getByText(/待审阅（AI 新提取/).count() > 0)
check('待审条目内容', await page.getByText('铁炉堡东境出现狼群').count() > 0)
// 接受一条
await page.getByRole('button', { name: '✓' }).first().click()
await page.waitForTimeout(400)
check('接受后待审减为 2 条', await page.getByText(/待审阅（AI 新提取 2 条/).count() > 0)
// 拒绝一条
await page.getByRole('button', { name: '✗' }).first().click()
await page.waitForTimeout(400)
check('拒绝后待审减为 1 条', await page.getByText(/待审阅（AI 新提取 1 条/).count() > 0)

// ---- 7. 截图 ----
await page.screenshot({ path: join(root, 'docs', 'screenshot-v2.png'), fullPage: true })

await browser.close()
mock.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (errors.length) console.log('JS 错误：', errors.slice(0, 5))
process.exit(fail ? 1 : 0)
