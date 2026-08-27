/**
 * v2.0 专项端到端：① 提取归并（同 key → 生成更新操作而非重复新增）
 * ② 清理预览 → 确认 → 回收站 → 还原
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// mock：书记官（提取）/ 游戏设计主持（交流栏）
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
      // 同 key「龙涎屿」，内容与已有条目不同 → 应生成「更新」操作而非新 pending
      content = '```json\n{"characters":[],"relations":[],"facts":[{"key":"龙涎屿","content":"龙涎屿位于苏门答腊西北侧，为珊瑚环礁，中央有雨水泻湖。","category":"地理环境"}]}\n```'
    } else {
      content = '好，把龙涎屿的气候特点再补充得完整一些，形成一条完整的设定描述。'
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
page.on('pageerror', (e) => console.log('[page-err]', String(e).slice(0, 300)))

const entriesOf = (wb: number) => `(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return all.filter((e) => e.worldbookId === ${wb} && e.status !== 'rejected').map((e) => ({ id: e.id, key: e.key, status: e.status, c: (e.content || '').slice(0, 16) }))
})()`

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
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('v2档')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)

const seed: any = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const camp = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res((r.result ?? [])[0]) })
  const wbId = await new Promise((res) => {
    const tx = db.transaction('worldbooks', 'readwrite')
    const id = tx.objectStore('worldbooks').add({ name: camp.name + ' · 自动笔记簿', description: '', scope: 'campaign', createdAt: Date.now(), updatedAt: Date.now() })
    id.onsuccess = () => res(id.result)
  })
  camp.notebookWorldbookId = wbId
  await new Promise((res) => { const tx = db.transaction('campaigns', 'readwrite'); tx.objectStore('campaigns').put(camp); tx.oncomplete = () => res() })
  const now = Date.now()
  const mk = (i) => ({ worldbookId: wbId, key: '龙涎屿', content: '龙涎屿位于苏门答腊西北侧、溜山东北，为珊瑚环礁，中央有雨水泻湖，属赤道热带气候。', category: '地理环境', enabled: 1, source: 'ai', status: 'accepted', createdAt: now - i * 1000, updatedAt: now - i * 1000 })
  await new Promise((res) => { const tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').add(mk(0)); tx.objectStore('entries').add(mk(1)); tx.oncomplete = () => res() })
  return { wbId }
})()`)
await page.reload()
await page.waitForTimeout(1000)

// ===== ① 清理预览 → 确认 → 回收站 → 还原 =====
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^世界$/ }).click()
await page.waitForTimeout(400)
await page.locator('.world-cat-card', { hasText: '地理环境' }).first().click()
await page.waitForTimeout(500)
check('重复提示条出现', await page.getByText(/检测到 1 组重复设定/).count() > 0)
await page.getByRole('button', { name: /一键清理/ }).click()
await page.waitForTimeout(400)
check('清理预览弹层出现', await page.getByText('清理重复设定').count() > 0)
check('预览显示保留内容', await page.getByText(/保留/).count() > 0)
await page.getByRole('button', { name: /确认清理/ }).click()
await page.waitForTimeout(800)
let after: any = await page.evaluate(entriesOf(seed.wbId))
console.log('① 清理后:', JSON.stringify(after))
check('清理后仅剩 1 条', after.length === 1, `实际 ${after.length}`)
await page.locator('.modal-full > div').first().locator('button').last().click()
await page.waitForTimeout(300)
check('回收站条出现', await page.getByText(/回收站（/).count() > 0)
await page.getByRole('button', { name: /还原/ }).first().click()
await page.waitForTimeout(800)
after = await page.evaluate(entriesOf(seed.wbId))
console.log('① 还原后:', JSON.stringify(after))
check('还原后恢复 2 条', after.length === 2, `实际 ${after.length}`)

// ===== ② 提取归并：同 key → 更新操作（防重复新增） =====
// 先删掉一条，恢复「单条」状态，再触发交流栏整理（syncFrom('talk') 需要消息增量：
// 在交流栏发一条消息 → 点整理设定 → mock 书记官返回同 key 不同内容）
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.locator('.chat-inputbar textarea').fill('龙涎屿的气候再描述更细一点')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('交流栏未整理横幅出现', await page.getByText(/条消息未整理/).count() > 0)
await page.getByRole('button', { name: /整理设定/ }).click()
await page.waitForTimeout(2500)
// 提取命中同 key 已有 accepted 条目 → 应生成 entry.upsert 更新操作（不在临时区新增）
const ops: any = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('ops', 'readonly').objectStore('ops').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return all.filter((o) => o.status === 'pending').map((o) => ({ kind: o.kind, src: o.src, p: (o.payload || '').slice(0, 90) }))
})()`)
console.log('② pending ops:', JSON.stringify(ops))
check('生成更新操作（提取归并）', ops.length === 1 && ops[0].kind === 'entry.upsert' && ops[0].src === 'extract', JSON.stringify(ops))
const entriesAfter: any = await page.evaluate(entriesOf(seed.wbId))
console.log('② 提取后条目:', JSON.stringify(entriesAfter))
check('条目数不变（未新增重复）', entriesAfter.length === 2, `实际 ${entriesAfter.length}`)
const pendings: any = entriesAfter.filter((e: any) => e.status === 'pending')
check('无 pending 新增（走操作审计而非临时区）', pendings.length === 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
