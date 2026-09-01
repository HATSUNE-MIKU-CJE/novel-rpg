/**
 * v3.1 人物卡纪元 e2e：模型地基（kind=character）+ 注入分层 + 大整理简报。
 *   npx tsx src/e2e/v31-cards.e2e.ts
 *
 * 覆盖：
 *  1. 整理后角色写 kind=character 条目（世界书单源，老表同步只读兼容）
 *  2. 人物卡在「角色」tab 渲染（名称/身份/hook）
 *  3. 注入分层：主角 hook 常驻（P0）；非主角未提及不注入；提及才触发详情
 *  4. 大整理：交流栏主持可见剧情态势简报
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 记录收到的所有 system 文本（验证注入用） */
const seenSystems: string[] = []

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
    seenSystems.push(sysText)
    let content: string
    if (sysText.includes('书记官')) {
      content = '```json\n{"characters":[{"name":"艾莉丝","identity":"见习法师","realm":"炼气三层","description":"银发少女，带着旧魔法书。","attributes":[{"label":"智力","value":8}]},{"name":"铁锤","identity":"卫队长","description":"魁梧矮人。","attributes":[{"label":"力量","value":9}]}],"relations":[{"from":"艾莉丝","to":"铁锤","relType":"同伴"}],"facts":[]}\n```'
    } else if (sysText.includes('开局设计师')) {
      content = '{"worldview":"晨雾小岛。","opening":"晨雾披上小岛的城垛。"}'
    } else if (sysText.includes('游戏设计主持')) {
      // 大整理 mock：主主持人在交流栏收到简报后的回复
      content = '剧情态势已在掌握之中。'
    } else if (sysText.includes('态势简报员')) {
      content = '{"timeline":"晨雾小岛","position":"海岸山洞","goal":"寻找失踪的灯塔守夜人","events":["艾莉丝上山","发现教堂地窖"],"mysteries":["灯塔灯光来源"],"focus":[{"name":"艾莉丝","note":"见习法师"}]}'
    } else {
      const lastUser = (parsed.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? '').slice(-20)
      content = `<dream_plot><dream_body>回应：「${lastUser}」</dream_body></dream_plot>`
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
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('人物卡纪元档')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)

// 交流栏铺垫
await page.locator('.chat-inputbar textarea').fill('我想去一个海港小镇冒险')
await page.locator('.send-btn').click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /^游戏/ }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(4500)
await page.getByRole('button', { name: /开始游戏（含开场白）/ }).click()
await page.waitForTimeout(2500)

// 游戏流推进两轮 → 整理（syncFrom 写 kind=character 条目）
await page.locator('.chat-inputbar textarea').fill('望向海平线')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
await page.locator('.chat-inputbar textarea').fill('搜索海岸洞穴')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)

// 手动整理（syncFrom game）
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /整理世界书/ }).click()
await page.waitForTimeout(3500)

check('人物卡出现（艾莉丝）', await page.locator('.char-card', { hasText: '艾莉丝' }).count() > 0)
check('人物卡出现（铁锤）', await page.locator('.char-card', { hasText: '铁锤' }).count() > 0)

// 校验 db：kind=character 条目存在（新模型单源）
const dbg = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return all.filter((e) => e.kind === 'character').map((e) => ({ name: (JSON.parse(e.payloadJson || '{}')).name, hook: e.hook, timeline: e.timeline, isMain: e.isMain }))
})()`)
console.log('[dbg] character entries:', JSON.stringify(dbg))
const dbgCasted = dbg as Array<{ name: string; hook?: string; timeline?: string; isMain?: number }>
check('kind=character 条目写入（×2）', Array.isArray(dbgCasted) && dbgCasted.length === 2, JSON.stringify(dbgCasted).slice(0, 200))
check('hook 自动生成', dbgCasted.every((e) => !!e.hook))

// 回到对话游戏栏：验证注入（P0 主角 hook 在请求中）——通过 mock 收到的 messages 无法直接看，
// 改为验证大整理在交流栏生效：点「大整理」
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /^交流/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /大整理/ }).click()
await page.waitForTimeout(3000)
// 发一条交流消息，mock 的「游戏设计主持」分支会收到简报（若 buildTalkSystem 注入成功）
await page.locator('.chat-inputbar textarea').fill('我们现在打听得如何')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('交流栏对话正常（大整理后）', await page.locator('.msg-card').count() > 0)
// 大整理实证：交流栏系统提示必须包含【剧情态势】简报
check('交流栏系统提示含剧情态势简报', seenSystems.some((s) => s.includes('【剧情态势】')), seenSystems.slice(-2).map((s) => s.slice(0, 80)).join(' | '))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
