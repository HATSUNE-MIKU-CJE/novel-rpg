/**
 * v3.4 拆分文件端到端：建存档 → 文件选择器导入斗一（全量 128 条）→
 * 验证「导入到自动笔记簿」：分类/hook/角色tab 48 卡/世界tab 徽标。
 *   node scripts/run-e2e.mjs v33-douluo-split.e2e.ts
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
const dialogs: string[] = []
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })

await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.locator('.list-row', { hasText: 'opencode-go 网关' }).getByRole('button', { name: '编' }).click()
await page.getByPlaceholder('https://api.example.com/v1').fill(`http://127.0.0.1:${port}/v1`)
await page.getByPlaceholder('sk-…').fill('test-key')
await page.getByPlaceholder('如：deepseek-v4-flash').fill('mock')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)

// 建一个存档（导入到笔记簿需要当前存档）
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /新档/ }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('斗罗篇')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(800)
check('存档已创建', await page.getByText('斗罗篇', { exact: true }).count() > 0)

// 面板 → 配置 tab → 展开世界书 → 导入
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(500)
await page.locator('.panel-tabs').getByRole('button', { name: /配置/ }).click()
await page.waitForTimeout(400)
await page.getByText('世界书（', { exact: false }).first().click().catch(async () => {
  await page.locator('.collapse-head', { hasText: '世界书' }).first().click()
})
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^导入$/ }).first().click()
await page.waitForTimeout(500)
check('默认勾选「导入到笔记簿」', await page.locator('.modal-sheet input[type="checkbox"]').isChecked())

// 真机链路：文件选择器 → FileReader（与用户手机上选文件一致）
await page.setInputFiles('input[type="file"]', '/home/miku/dsh-work/斗罗大陆Reborn-斗一.json')
await page.waitForTimeout(1500)

const shownLen = await page.locator('.modal-sheet .list-sub', { hasText: '已读取' }).first().textContent().catch(() => '')
console.log('[dbg] 已读取提示:', shownLen)
check('文件被读入（>100万字符）', (() => { const n = parseInt(String(shownLen ?? '').replace(/[^0-9]/g, ''), 10); return n > 1000000 })(), String(shownLen))

await page.getByRole('button', { name: /^导入$/ }).last().click()
const t0 = Date.now()
await page.waitForFunction(() => {
  const ta = Array.from(document.querySelectorAll('textarea')).pop() as HTMLTextAreaElement
  return !ta || !ta.value?.trim()
}, { timeout: 60000 }).catch(() => {})
const elapsed = Date.now() - t0
console.log(`[dbg] 导入等待 ${elapsed}ms，dialog=${JSON.stringify(dialogs)}`)
check('导入完成提示（条目 128 + 入笔记簿）', dialogs.some((m) => m.includes('导入成功') && m.includes('128') && m.includes('自动笔记簿')), String(dialogs))

// 校验 db：全部条目写入存档 notebook
const dist = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const cams = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const nbId = cams[0]?.notebookWorldbookId
  const m = {}
  let tangSan = false
  const hookSample = []
  let allInNb = true
  for (const e of all) {
    const k = e.kind || 'note'; m[k] = (m[k] || 0) + 1
    if (e.worldbookId !== nbId) allInNb = false
    if (k === 'character') {
      if (String(e.hook ?? '').startsWith('唐三')) tangSan = true
      if (hookSample.length < 8) hookSample.push({ hook: e.hook, key: String(e.key ?? '').slice(0, 6) })
    }
  }
  return { count: all.length, nbId, allInNb, dist: m, tangSan, hookSample }
})()`)
console.log('[dbg] db:', JSON.stringify(dist))
check('存档有 notebook', (dist as any).nbId > 0, `got ${(dist as any).nbId}`)
check('导入条目数 = 128', (dist as any).count === 128, `got ${(dist as any).count}`)
check('全部条目在笔记簿', (dist as any).allInNb === true)
const dd = (dist as any).dist as Record<string, number>
check('人物卡 48', (dd.character ?? 0) === 48, `got ${dd.character}`)
check('事件卡 37', (dd.event ?? 0) === 37, `got ${dd.event}`)
check('地点卡 10', (dd.location ?? 0) === 10, `got ${dd.location}`)
check('规则卡 1', (dd.rule ?? 0) === 1, `got ${dd.rule}`)
check('人物 hook 提取正确（唐三系列）', (dist as any).tangSan === true, JSON.stringify((dist as any).hookSample))

// 角色 tab：48 张人物卡直接可见
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(300)
await page.locator('.panel-tabs').getByRole('button', { name: /^角色/ }).click()
await page.waitForTimeout(800)
const charCards = await page.locator('.char-card').count()
check('角色 tab 显示 48 张人物卡', charCards === 48, `got ${charCards}`)
check('唐三Q 出现在角色 tab', await page.getByText('唐三Q', { exact: false }).count() > 0)

// 世界 tab 展开「其他」→ kind 徽标
await page.locator('.panel-tabs').getByRole('button', { name: /世界/ }).click()
await page.waitForTimeout(800)
await page.locator('.world-cat-card', { hasText: '其他' }).first().click().catch(() => {})
await page.waitForTimeout(800)
const badgeCount = await page.locator('.tag-kind').count().catch(() => 0)
check('世界 tab 渲染 kind 徽标', badgeCount > 0, `got ${badgeCount}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败（导入耗时约 ${elapsed}ms）`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
