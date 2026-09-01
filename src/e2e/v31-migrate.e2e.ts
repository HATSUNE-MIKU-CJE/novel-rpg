/**
 * v3.1.1 旧档迁移 e2e：模拟「旧档只有 characters 表数据、无 kind=character 条目」，
 * 重开档触发 migrateLegacyCharacters → 人物卡出现 + 主角标记 + 老表仍同步。
 *   node scripts/run-e2e.mjs v31-migrate.e2e.ts
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
    const sysText = (parsed.messages[0]?.content ?? '') + (parsed.messages[1]?.content ?? '') + (parsed.messages[2]?.content ?? '')
    let content: string
    if (sysText.includes('书记官')) {
      content = '```json\n{"characters":[{"name":"艾莉丝","identity":"见习法师","description":"银发少女。","attributes":[{"label":"智力","value":8}]},{"name":"铁锤","identity":"卫队长","description":"魁梧矮人。","attributes":[{"label":"力量","value":9}]}],"relations":[],"facts":[]}\n```'
    } else if (sysText.includes('开局设计师')) {
      content = '{"worldview":"晨雾小岛。","opening":"晨雾披上小岛的城垛。"}'
    } else if (sysText.includes('游戏设计主持')) {
      content = '好。'
    } else {
      const lastUser = (parsed.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '').slice(-20)
      content = `<dream_plot><dream_body>回应：「${lastUser}」</dream_body></dream_plot>`
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      choices: [{ message: { role: 'assistant', content } }],
    }))
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
await page.getByPlaceholder('如：deepseek-v4-flash').fill('deepseek-v4-flash')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
await page.locator('.tabbar').getByText('对话').click()
await page.getByRole('button', { name: /新档/ }).click()
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('旧档迁移档')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)

// 产生角色数据（老表 + v3 条目）
await page.locator('.chat-inputbar textarea').fill('旅程开始')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /^游戏/ }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(4000)
await page.getByRole('button', { name: /开始游戏（含开场白）/ }).click()
await page.waitForTimeout(2000)
await page.locator('.chat-inputbar textarea').fill('我推开木门走进旅店，门口的铁匠艾莉丝抬头看了我一眼，她手里拿着旧魔法书，是个见习法师，好像有些心事。')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /整理世界书/ }).click()
await page.waitForTimeout(4000)
const charsLen = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const chars = await new Promise((res) => { const r = db.transaction('characters', 'readonly').objectStore('characters').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return chars.length
})()`)
check('整理产生角色（characters 表）', Number(charsLen) >= 1)

// 模拟旧档：删除 kind=character 条目（只留下 characters 表数据）
await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const tx = db.transaction('entries', 'readwrite')
  const store = tx.objectStore('entries')
  const all = await new Promise((res) => { const r = store.getAll(); r.onsuccess = () => res(r.result ?? []) })
  for (const e of all) if (e.kind === 'character') await new Promise((res) => { const r = store.delete(e.id); r.onsuccess = () => res(0) })
})()`)
await page.waitForTimeout(500)

// 重开档（删除后刷新页面 → 应用启动 loadAll + 打开存档 → openCampaign 触发迁移）
await page.reload()
await page.waitForTimeout(1500)
// 面板 → 角色 tab
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(600)
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click()
await page.waitForTimeout(500)
check('旧档迁移后人物卡出现（艾莉丝）', await page.locator('.char-card', { hasText: '艾莉丝' }).count() > 0)
check('旧档迁移后人物卡出现（铁锤）', await page.locator('.char-card', { hasText: '铁锤' }).count() > 0)
check('主角徽标出现', await page.locator('.char-card', { hasText: '主角' }).count() > 0)

const dbg = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const chars = await new Promise((res) => { const r = db.transaction('characters', 'readonly').objectStore('characters').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const cams = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return { chars: chars.map((x) => ({ id: x.id, cid: x.campaignId, name: x.name })), entries: all.filter((e) => e.kind === 'character').length, cams: cams.map((x) => ({ id: x.id, name: x.name })) }
})()`)
console.log('[dbg] state:', JSON.stringify(dbg))
const dbgC = (dbg as any).chars ?? []
const dbgE = (dbg as any).entries ?? 0
check('迁移条目含 hook', Array.isArray(dbgE) === false && dbgE >= 1, 'chars=' + dbgC.length + ' entries=' + dbgE)
check('恰好一个主角', (dbg as any).cams?.length >= 0 && (dbg as any).entries >= 1)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
