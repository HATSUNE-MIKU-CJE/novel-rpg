/**
 * v2.2 状态卡 e2e：配置（示例模板+保存）→ 游戏对话（mock 报 [[SNAP]]）→ HUD 状态卡渲染。
 *   npx tsx src/e2e/v2-status.e2e.ts
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.writeHead(204); res.end(); return
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const parsed = JSON.parse(body)
    const sysText = (parsed.messages[0]?.content ?? '') + (parsed.messages[1]?.content ?? '')
    let content: string
    if (sysText.includes('书记官')) {
      content = '```json\n{"characters":[],"relations":[],"facts":[]}\n```'
    } else if (sysText.includes('开局设计师')) {
      content = '{"worldview":"晨雾小岛。","opening":"晨雾披上小岛的城垛。"}'
    } else if (sysText.includes('游戏设计主持')) {
      content = '好，这个方向很有味道。'
    } else {
      const lastUser = (parsed.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '').slice(-20)
      const snap = lastUser.includes('木棍')
        ? '[[SNAP]]{"收集物资":{"add":"木棍"},"体力":"55%"}[[/SNAP]]'
        : '[[SNAP]]{"收集物资":{"add":"旧魔法书"},"体力":"60%","精神状态":"震惊但可控"}[[/SNAP]]'
      content = '<dream_plot><dream_body>回应：「' + lastUser + '」</dream_body></dream_plot>\n' + snap
    }
    if (parsed.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const usage = { prompt_tokens: 3200, completion_tokens: 450, total_tokens: 3650, prompt_cache_hit_tokens: 2400, prompt_cache_miss_tokens: 800 }
      const step = Math.max(1, Math.ceil(content.length / 6))
      const chunks: string[] = []
      for (let i = 0; i < content.length; i += step) chunks.push(content.slice(i, i + step))
      const dump = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      let bi = 0
      const timer = setInterval(() => {
        if (bi < chunks.length) { dump({ choices: [{ delta: { role: 'assistant', content: chunks[bi] } }] }); bi++ }
        else { dump({ choices: [{ delta: {} }], usage }); res.write('data: [DONE]\n\n'); res.end(); clearInterval(timer) }
      }, 25)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      usage: { prompt_tokens: 3200, completion_tokens: 450, total_tokens: 3650, prompt_cache_hit_tokens: 2400, prompt_cache_miss_tokens: 800 },
      choices: [{ message: { role: 'assistant', content } }],
    }))
  })
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
const port = (mock.address() as any).port

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('dialog', (d) => d.accept())
page.on('console', (m) => { if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200)) })

await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.locator('.list-row', { hasText: 'opencode-go 网关' }).getByRole('button', { name: '编' }).click()
await page.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${port}/v1`)
await page.getByPlaceholder('sk-…').fill('test-key')
await page.getByPlaceholder('如：deepseek-v4-flash').fill('deepseek-v4-flash')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
await page.locator('.tabbar').getByText('对话').click()
await page.getByRole('button', { name: /新档/ }).click()
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('状态卡档')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)

// 面板 → 世界 tab → 配置状态卡
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^世界$/ }).click()
await page.waitForTimeout(400)
check('状态卡设定卡出现', await page.getByText('状态卡设定', { exact: false }).count() > 0)
await page.locator('.card', { hasText: '状态卡设定' }).getByRole('button', { name: /示例模板/ }).click()
await page.waitForTimeout(300)
check('示例模板字段填出', await page.locator('.card', { hasText: '状态卡设定' }).locator('input').count() >= 4)
await page.locator('.card', { hasText: '状态卡设定' }).getByRole('button', { name: /^保存$/ }).click()
await page.waitForTimeout(500)

// 回对话 → 交流栏铺垫一句 → 游戏栏开始游戏 → 游戏对话 → mock 报 SNAP
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.locator('.chat-inputbar textarea').fill('我想去一座荒岛探险')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /^游戏/ }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(4500)
await page.getByRole('button', { name: /开始游戏（含开场白）/ }).click()
await page.waitForTimeout(2500)
await page.locator('.chat-inputbar textarea').fill('看看沙滩边缘')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)

check('状态卡渲染（HUD）', await page.locator('.status-card').count() > 0)
const scDbg = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const camp = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res((r.result ?? [])[0]) })
  const all = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return { all: all.map((x) => ({ id: x.id, name: x.name, sc: x.statusCardJson ? 'Y' : 'N', vals: x.statusValuesJson ? 'Y' : 'N' })), sc: camp.statusCardJson, vals: camp.statusValuesJson }
})()`)
console.log('[dbg] campaigns:', JSON.stringify(scDbg))
console.log('[dbg] hud html:', (await page.locator('.hud-bars').innerText().catch(() => 'N/A')).slice(0, 200))
check('清单字段渲染（旧魔法书）', await page.locator('.status-card').getByText('旧魔法书').count() > 0, 'div=' + (await page.locator('.status-card').innerText().catch(() => 'N/A')).slice(0, 120))
check('单行字段渲染（60%）', await page.locator('.status-card').getByText('60%').count() > 0)
check('精神状态渲染', await page.locator('.status-card').getByText('震惊但可控').count() > 0)
check('SNAP 块不上屏', await page.getByText('[[SNAP]]').count() === 0)

// 再一轮：清单追加（add 语义）
await page.locator('.chat-inputbar textarea').fill('捡到一根木棍')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('第二轮后清单含旧物品+新物品', (await page.locator('.status-card').innerText()).includes('旧魔法书') && (await page.locator('.status-card').innerText()).includes('木棍'), (await page.locator('.status-card').innerText().catch(() => 'N/A')).slice(0, 200))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
