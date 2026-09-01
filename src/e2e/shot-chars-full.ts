/**
 * 完整状态截图：建档 → 整理出角色 → 面板角色 tab 截图（有角色数据的实际 UI）。
 *   npx tsx src/e2e/shot-chars-full.ts
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    const sys = (parsed.messages[0]?.content ?? '') + (parsed.messages[1]?.content ?? '') + (parsed.messages[2]?.content ?? '')
    let content: string
    if (sys.includes('书记官')) {
      content = '```json\n{"characters":[{"name":"艾莉丝","identity":"见习法师","description":"银发少女。","attributes":[{"label":"智力","value":8}]},{"name":"铁锤","identity":"卫队长","description":"魁梧矮人。","attributes":[{"label":"力量","value":9}]}],"relations":[],"facts":[]}\n```'
    } else if (sys.includes('开局设计师')) {
      content = '{"worldview":"晨雾小岛。","opening":"晨雾披上小岛的城垛。"}'
    } else if (sys.includes('游戏设计主持')) { content = '好。' }
    else { const lu = (parsed.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '').slice(-20); content = `<dream_plot><dream_body>回应：「${lu}」</dream_body></dream_plot>` }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ message: { role: 'assistant', content } }] }))
  })
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const port = (mock.address() as any).port

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('dialog', (d) => d.accept())

await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.locator('.list-row', { hasText: 'opencode-go 网关' }).getByRole('button', { name: '编' }).click()
await page.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${port}/v1`)
await page.getByPlaceholder('sk-…').fill('test-key')
await page.getByPlaceholder('如：deepseek-v4-flash').fill('mock')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
await page.locator('.tabbar').getByText('对话').click()
await page.getByRole('button', { name: /新档/ }).click()
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('截图档')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)

await page.locator('.chat-inputbar textarea').fill('我走进旅店，铁匠艾莉丝抬头看我，她是个见习法师，手里拿着旧魔法书，好像有心事。')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /^游戏/ }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(4000)
await page.getByRole('button', { name: /开始游戏（含开场白）/ }).click()
await page.waitForTimeout(2000)
await page.locator('.chat-inputbar textarea').fill('我们去铁匠铺看看。')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)

await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /整理世界书/ }).click()
await page.waitForTimeout(4000)

await page.screenshot({ path: '/tmp/panel-chars-with-data.png', fullPage: true })
const btnCount = await page.getByText('迁移旧角色卡', { exact: false }).count()
console.log('迁移按钮 count（有角色数据后）:', btnCount)
await browser.close()
mock.close()
process.exit(0)
