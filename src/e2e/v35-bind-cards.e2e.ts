/**
 * v3.5 绑定即接入 e2e：模拟用户报告场景——
 *   导入世界书（不勾选「入笔记簿」）→ 新建书 → 之后「绑定」→ 人物卡自动接入角色 tab。
 * 同时验证：v2 规范字段（kind/payload/hook/timeline/isMain）导入保留 + ST 原文清洗 + 幂等。
 *   node scripts/run-e2e.mjs v35-bind-cards.e2e.ts
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const SAMPLE = JSON.stringify({
  version: 2,
  worldbook: { name: '星海纪·测试', description: '绑定接入验证用' },
  entries: [
    {
      kind: 'character', key: ['林一', '阿一'], hook: '林一：铁匠学徒，天生怪力',
      content: '{{char}}星海城铁匠铺学徒，15 岁。\n---\n力气大得反常，能徒手拉弯铁条。',
      payload: { name: '林一', identity: '铁匠学徒' }, timeline: '第一卷', isMain: 1,
    },
    {
      kind: 'character', key: '苏月', hook: '苏月：药庐传人',
      content: '<b>云游医师</b>，记性极好。',
      payload: { name: '苏月', identity: '药庐传人' },
    },
    {
      kind: 'location', key: ['星海城'], hook: '星海城：北境第一大城',
      content: '北境第一大城。', payload: { name: '星海城', region: '北境', danger: 20 },
    },
    { content: '通用货币为「星币」。（备注条目，无 kind）' },
  ],
  relations: [{ from: '林一', to: '苏月', relType: '同伴' }],
})

const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      choices: [{ message: { role: 'assistant', content: '好。' } }],
    }))
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

// 建存档
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /新档/ }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('斗罗篇')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(800)

// 面板 → 配置 → 世界书 → 导入（取消「入笔记簿」勾选）
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
check('默认勾选「入笔记簿」', await page.locator('.modal-sheet input[type="checkbox"]').isChecked())
await page.locator('.modal-sheet input[type="checkbox"]').uncheck()
check('已取消勾选（将新建世界书）', !(await page.locator('.modal-sheet input[type="checkbox"]').isChecked()))
await page.locator('.modal-sheet textarea').fill(SAMPLE)
await page.waitForTimeout(300)
await page.getByRole('button', { name: /^导入$/ }).last().click()
await page.waitForTimeout(2500)
check('提示导入成功（新建世界书）', dialogs.some((m) => m.includes('导入成功') && !m.includes('自动笔记簿')), dialogs.filter((m) => m.includes('导入成功')).join(' | '))

// 角色 tab：尚未绑定 → 无卡
await page.locator('.panel-tabs').getByRole('button', { name: /^角色/ }).click()
await page.waitForTimeout(800)
check('绑定前角色 tab 无卡（笔记簿为空）', (await page.locator('.char-card').count()) === 0)

// 配置 → 找到新书 → 绑定 → 勾选当前存档
await page.locator('.panel-tabs').getByRole('button', { name: /配置/ }).click()
await page.waitForTimeout(500)
const wbCard = page.locator('.wb-card', { hasText: '星海纪·测试' })
check('新世界书已创建', (await wbCard.count()) === 1)
await wbCard.getByRole('button', { name: '绑定' }).click()
await page.waitForTimeout(500)
await page.locator('.list-row', { hasText: '斗罗篇' }).locator('input[type="checkbox"]').check()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '完成' }).click()
await page.waitForTimeout(400)

// 角色 tab：绑定即自动接入 → 2 张卡
await page.locator('.panel-tabs').getByRole('button', { name: /^角色/ }).click()
await page.waitForTimeout(1000)
const charCount = await page.locator('.char-card').count()
check('绑定后角色 tab 自动接入 2 张人物卡', charCount === 2, `got ${charCount}`)
check('林一 出现在角色 tab', await page.getByText('林一', { exact: false }).count() > 0)
check('苏月 出现在角色 tab', await page.getByText('苏月', { exact: false }).count() > 0)

// db 校验：v2 字段保留 + ST 原文清洗 + 原书条目不动
const res: any = await page.evaluate(`(async () => {
  const req = indexedDB.open('novel-rpg')
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
  const all = await new Promise((res) => { const r = db.transaction('entries', 'readonly').objectStore('entries').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const cams = await new Promise((res) => { const r = db.transaction('campaigns', 'readonly').objectStore('campaigns').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const binds = await new Promise((res) => { const r = db.transaction('campaignBindings', 'readonly').objectStore('campaignBindings').getAll(); r.onsuccess = () => res(r.result ?? []) })
  const nbId = cams[0]?.notebookWorldbookId
  const inNb = all.filter((e) => e.worldbookId === nbId)
  return {
    bindCount: binds.length,
    nbId,
    total: all.length,
    nbCards: inNb.filter((e) => e.kind === 'character').map((e) => ({
      name: JSON.parse(e.payloadJson || '{}').name, isMain: e.isMain, timeline: e.timeline,
      hook: e.hook, key: e.key, content: e.content,
    })),
    nbLocations: inNb.filter((e) => e.kind === 'location').length,
    nbNotes: inNb.filter((e) => e.kind === 'note').length,
    srcCards: all.filter((e) => e.kind === 'character').length,
  }
})()`)
console.log('[dbg]', JSON.stringify(res))
check('绑定记录 = 1', res.bindCount === 1, `got ${res.bindCount}`)
check('笔记簿存在', res.nbId > 0, `got ${res.nbId}`)
check('笔记簿有 2 张人物卡（复制接入）', res.nbCards?.length === 2, JSON.stringify(res.nbCards?.map((c: any) => c.name)))
const lin = res.nbCards?.find((c: any) => c.name === '林一')
check('林一 payload.name 正确', lin?.name === '林一')
check('林一 isMain=1 保留', lin?.isMain === 1, `got ${lin?.isMain}`)
check('林一 timeline=第一卷 保留', lin?.timeline === '第一卷', `got ${lin?.timeline}`)
check('林一 hook 保留', lin?.hook === '林一：铁匠学徒，天生怪力', `got ${lin?.hook}`)
check('林一 key 保留触发词', lin?.key === '林一,阿一', `got ${lin?.key}`)
check('content 已清洗（无 {{ 宏 / --- 分隔线）', lin && !lin.content.includes('{{') && !lin.content.includes('---'), JSON.stringify(lin?.content))
check('苏月 content 已清洗 HTML 标签', res.nbCards?.some((c: any) => c.name === '苏月' && !c.content.includes('<b>')), JSON.stringify(res.nbCards))
check('地点卡未接入（留在原书）', res.nbLocations === 0, `got ${res.nbLocations}`)
check('备注卡未接入', res.nbNotes === 0, `got ${res.nbNotes}`)
check('原书仍保留全部 4 条', res.total === 6, `got ${res.total}（原书 4 + 笔记簿复制 2）`)
check('全书 character 类共 2（复制副本）', res.srcCards === 4, `got ${res.srcCards}`)

// 幂等：解除绑定再绑定 → 不重复接入
await page.locator('.panel-tabs').getByRole('button', { name: /配置/ }).click()
await page.waitForTimeout(500)
await wbCard.getByRole('button', { name: '绑定' }).click()
await page.waitForTimeout(500)
await page.locator('.list-row', { hasText: '斗罗篇' }).locator('input[type="checkbox"]').uncheck()
await page.waitForTimeout(800)
await page.locator('.list-row', { hasText: '斗罗篇' }).locator('input[type="checkbox"]').check()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '完成' }).click()
await page.locator('.panel-tabs').getByRole('button', { name: /^角色/ }).click()
await page.waitForTimeout(1000)
check('重新绑定幂等（仍 2 张卡）', (await page.locator('.char-card').count()) === 2)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
mock.close()
process.exit(fail ? 1 : 0)
