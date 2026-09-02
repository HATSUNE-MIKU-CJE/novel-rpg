/**
 * v3.5 视觉验证：真实斗罗（斗一）导入 → 角色 tab + 人物卡详情截图。
 *   node scripts/run-e2e.mjs v35-shot.ts
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
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ message: { role: 'assistant', content: '好。' } }] }))
  })
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const port = (mock.address() as any).port

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('dialog', (d) => d.accept())

// 配置 mock API
await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.locator('.list-row', { hasText: 'opencode-go 网关' }).getByRole('button', { name: '编' }).click()
await page.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${port}/v1`)
await page.getByPlaceholder('sk-…').fill('test-key')
await page.getByPlaceholder('如：deepseek-v4-flash').fill('mock')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)

// 建存档
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /新档/ }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('斗罗篇')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(800)

// 面板 → 配置 → 导入真实斗一（默认勾选入笔记簿）
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.locator('.panel-tabs').getByRole('button', { name: /配置/ }).click()
await page.waitForTimeout(400)
await page.getByText('世界书（', { exact: false }).first().click().catch(async () => {
  await page.locator('.collapse-head', { hasText: '世界书' }).first().click()
})
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^导入$/ }).first().click()
await page.waitForTimeout(500)
await page.setInputFiles('input[type="file"]', '/home/miku/dsh-work/斗罗大陆Reborn-斗一.json')
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^导入$/ }).last().click()
await page.waitForFunction(() => {
  const ta = Array.from(document.querySelectorAll('textarea')).pop() as HTMLTextAreaElement
  return !ta || !ta.value?.trim()
}, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(1500)

// 角色 tab 截图
await page.locator('.panel-tabs').getByRole('button', { name: /^角色/ }).click()
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/v35-chars.png' })
console.log('角色 tab 截图已存 /tmp/v35-chars.png，卡数 =', await page.locator('.char-card').count())

// 打开第一张人物卡详情（武魂殿）截图
await page.locator('.char-card').first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: '/tmp/v35-card-detail.png' })
console.log('人物卡详情截图已存 /tmp/v35-card-detail.png')

// 滚动到详情页正文（content 区）截图
await page.evaluate(() => {
  const m = document.querySelector('.modal-full')
  if (m) { m.scrollTop = m.scrollHeight }
})
await page.waitForTimeout(800)
await page.screenshot({ path: '/tmp/v35-card-content.png' })
console.log('人物卡正文截图已存 /tmp/v35-card-content.png')

// 读取编辑区里的真实 content，验证无 ST 标签残留
const bodyText = await page.evaluate(() => {
  const ta = Array.from(document.querySelectorAll('.modal-full textarea')).pop() as HTMLTextAreaElement | undefined
  return ta?.value ?? ''
})
console.log('人物卡正文(textarea) 前 90 字:', JSON.stringify(bodyText.slice(0, 90)))
console.log('正文含 < 标签:', /<[a-zA-Z][^>]{0,80}>/.test(bodyText), '| 含 {{:', bodyText.includes('{{'))

await browser.close()
mock.close()
