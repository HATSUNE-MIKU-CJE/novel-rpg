/**
 * v3.2 斗罗端到端：导入真实斗罗世界书 → 分类 → 世界tab多卡样式显示。
 *   node scripts/run-e2e.mjs v32-douluo.e2e.ts
 * 注意：需要 dev server + mock API（导入不需要 API，但建档/整理需要）
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const douluo = readFileSync('/home/miku/dsh-work/斗罗大陆Reborn.json', 'utf8')

const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const sys = JSON.parse(body).messages?.[0]?.content ?? ''
    let content = '好。'
    if (sys.includes('书记官')) content = '```json\n{"characters":[],"relations":[],"facts":[]}\n```'
    else if (sys.includes('开局设计师')) content = '{"worldview":"斗罗大陆。","opening":"苏醒于斗罗大陆的清晨。"}'
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

// 面板 → 配置 tab → 展开世界书 → 导入
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(500)
await page.locator('.panel-tabs').getByRole('button', { name: /配置/ }).click()
await page.waitForTimeout(400)
// 展开「世界书」折叠区
await page.getByText('世界书（', { exact: false }).first().click().catch(async () => {
  await page.locator('.collapse-head', { hasText: '世界书' }).first().click()
})
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^导入$/ }).first().click()
await page.waitForTimeout(500)
// 粘贴 JSON（取前 50 条足够验证分类；大文件用 evaluate 直灌）
const sample = JSON.stringify({ ...JSON.parse(douluo), entries: Object.fromEntries(Object.entries(JSON.parse(douluo).entries).slice(0, 50)) })
await page.evaluate((text: string) => {
  const ta = Array.from(document.querySelectorAll('textarea')).pop() as HTMLTextAreaElement
  if (ta) { (ta as any).value = text; ta.dispatchEvent(new Event('input', { bubbles: true })) }
}, sample)
await page.waitForTimeout(500)
await page.getByRole('button', { name: /导入$/ }).last().click()
await page.waitForTimeout(3000)

// 校验分类分布（db 里 character 数量）
const dist = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const m = {}
  for (const e of all) { const k = e.kind || 'note'; m[k] = (m[k] || 0) + 1 }
  return m
})()`)
console.log('[dbg] dist:', JSON.stringify(dist))
const distObj = dist as Record<string, number>
check('导入条目 > 20', Object.values(distObj).reduce((a: number, b: number) => a + b, 0) > 20)
check('有人物卡', (distObj?.character ?? 0) > 0)
check('有地点卡', (distObj?.location ?? 0) > 0)
check('有事件卡', (distObj?.event ?? 0) > 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
