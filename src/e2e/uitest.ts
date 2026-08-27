/**
 * 浏览器端到端测试 v3（v1.2 双流）：内置节点 → 新建存档 → 交流栏对话 → 开始游戏向导
 * → 游戏栏对话 → 整理世界书 → 角色卡/雷达图 → 待审阅。
 *   npx tsx src/e2e/uitest.ts
 */
import { chromium } from 'playwright'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- mock OpenAI：按 system 提示词区分 书记官/开局设计师/设计主持/写作 ----
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
    console.log('[mock] stream=', !!parsed.stream, 'lastMsg=', JSON.stringify((parsed.messages.at(-1)?.content ?? '').slice(0, 30)))
    const lastUser = parsed.messages.filter((m: any) => m.role === 'user').at(-1)
    const lines = (lastUser?.content ?? '').split('\n').filter((l: string) => l.trim())
    const echoed = lines.at(-1) ?? ''
    const sysText = (parsed.messages[0]?.content ?? '') + (parsed.messages[1]?.content ?? '')

    let content: string
    if (sysText.includes('书记官')) {
      // 事实/设定提取（属性按默认六维：力量/敏捷/智力/意志/感知/魅力）
      content = '```json\n{"characters":[{"name":"艾莉丝","identity":"见习法师","realm":"炼气三层","description":"银发少女，带着旧魔法书","attributes":[{"label":"智力","value":8},{"label":"意志","value":6},{"label":"感知","value":5}]},{"name":"铁锤","identity":"卫队长","description":"魁梧矮人","attributes":[{"label":"力量","value":9}]}],"relations":[{"from":"艾莉丝","to":"铁锤","relType":"同伴"}],"facts":[{"key":"铁炉堡","content":"铁炉堡东境出现狼群。","category":"地理环境"},{"key":"艾莉丝","content":"艾莉丝的旧魔法书疑似来自王室。","category":"物品神器"},{"key":"","content":"王族徽记是锤与铁砧交叉图案。","category":"种族文化"}]}\n```'
    } else if (sysText.includes('开局设计师')) {
      content = '{"worldview":"矮人王国铁炉堡的清晨，狼群与王族古书之谜将揭开序幕。","opening":"晨雾披上铁炉堡的城垛。你背着行囊站在东门前，远处狼嚎与锻锤声交织——旧魔法书的秘密，正等你推开这扇门。"}'
    } else if (sysText.includes('剧情回顾师')) {
      content = '{"title":"铁炉堡清晨之约","events":[{"time":"清晨","place":"东门","desc":"敲开东门遇见艾莉丝。"},{"time":"上午","place":"城门口","desc":"狼群在远处嚎叫，铁锤队长出现。"}]}'
    } else if (sysText.includes('属性体系设计师')) {
      content = '{"dims":[{"label":"体魄"},{"label":"灵根"},{"label":"悟性"},{"label":"心境"},{"label":"神识"},{"label":"气运"}],"realmLabel":"境界"}'
    } else if (sysText.includes('世界观梳理师')) {
      content = '{"summary":"铁炉堡的清晨，狼群与王室旧书之谜交织成冒险的序章。","blocks":[{"category":"地理环境","content":"东境狼群出没，商队绕路而行。","related":["铁炉堡"]},{"category":"种族文化","content":"王族以锤与铁砧为徽记。","related":[]}]}'
    } else if (sysText.includes('游戏设计主持')) {
      // 交流栏：纯文本回应；含「记下来」→ 输出操作协议块
      if (echoed.includes('记下来')) {
        content = '已记下，去临时区确认。[[WB]]{"op":"entry.upsert","key":"铁炉堡货币","content":"以铜币为基本单位，汇率由王都铸造局控制。","category":"经济系统"}[[/WB]]'
      } else {
        content = `好，${echoed.slice(0, 30)} —— 这个方向很有味道。我们先把世界观锚定：你想让铁炉堡处于什么时代？`
      }
    } else {
      // v2.1.1：游戏流回复模拟「after_format 泄漏场景」（规范复述 + 正文镜像 + BAR 塞进后置区）
      content = `<dream_plot>\n<dream_body>回应：「${echoed.slice(0, 40)}」</dream_body>\n<dream_after_format>\n，其中可包含状态栏。\n二、辨视角：\n- 主要角色：艾莉丝。\n三、遵写规：\n- 文风：直接白话\n回应：「${echoed.slice(0, 40)}」\n[[BAR]]{"name":"艾莉丝","values":{"血条":72}}[[/BAR]]\n</dream_after_format>\n</dream_plot>`
    }

    if (parsed.stream) {
      // v2.1：SSE 流式模拟（分 8 块吐 + usage 尾块）
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const usage = {
        prompt_tokens: 3200, completion_tokens: 450, total_tokens: 3650,
        prompt_cache_hit_tokens: 2400, prompt_cache_miss_tokens: 800,
      }
      console.log('[mock] SSE begin, len=', content.length)
      const chunks: string[] = []
      const step = Math.max(1, Math.ceil(content.length / 8))
      for (let i = 0; i < content.length; i += step) chunks.push(content.slice(i, i + step))
      const dump = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      let bi = 0
      const timer = setInterval(() => {
        if (bi < chunks.length) {
          dump({ choices: [{ delta: { role: 'assistant', content: chunks[bi] } }] })
          bi++
        } else {
          dump({ choices: [{ delta: {} }], usage })
          dump({ choices: [{ delta: {}, finish_reason: 'stop' }] })
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(timer)
        }
      }, 30)
      res.on('close', () => clearInterval(timer))
      return
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
const ocRow = page.locator('.list-row', { hasText: 'opencode-go 网关' })
check('Key 已填（本行待填标记消失）', !(await ocRow.innerText()).includes('待填 Key'))

// ---- 3. 预设开关面板（无存档时应显示提示）----
console.log('【预设开关】')
await page.getByRole('button', { name: /^预设$/ }).click()
await page.waitForTimeout(400)
check('无存档提示', await page.getByText('先打开一个存档').count() > 0)
check('输出模式组已隐藏', await page.getByText('输出模式', { exact: false }).count() === 0)
await page.getByRole('button', { name: /API/ }).click()

// ---- 4. 新建存档 → 应进入交流栏 ----
console.log('【存档+交流】')
await page.locator('.tabbar').getByText('对话').click()
await page.getByRole('button', { name: /新档/ }).click()
await page.waitForTimeout(300)
await page.getByPlaceholder('如：我的梦境 · 夜航星海').fill('铁炉堡篇')
await page.getByRole('button', { name: '创建' }).click()
await page.waitForTimeout(600)
check('存档已创建', await page.getByText('铁炉堡篇', { exact: true }).count() > 0)
check('流切换条出现', await page.getByText('交流', { exact: false }).count() > 0 && await page.getByText('游戏', { exact: false }).count() > 0)
check('默认在交流栏', await page.getByText(/和 AI 组队设计你的梦境游戏/).count() > 0)

// 交流栏发消息（mock 主持人格返回纯文本）
console.log('【交流对话】')
await page.locator('.chat-inputbar textarea').fill('我想玩一个矮人铁炉堡的跑团')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('交流用户消息上屏', await page.getByText('我想玩一个矮人铁炉堡的跑团').count() > 0)
check('交流 AI 回复上屏', await page.getByText(/这个方向很有味道/).count() > 0)
check('交流栏不渲染 XML（无 dream_body）', await page.getByText('dream_body').count() === 0)
check('交流栏压缩按钮存在', await page.locator('.stream-actions').getByRole('button', { name: /^压缩$/ }).count() > 0)

// ---- 4.5 AI 操作协议（交流栏主持写世界书）----
console.log('【AI 操作协议】')
await page.locator('.chat-inputbar textarea').fill('把铁炉堡的货币体系记下来')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('协议块从正文剥离', await page.getByText('已记下，去临时区确认。').count() > 0)
check('消息内嵌操作卡出现（v2.0）', await page.locator('.op-card').count() > 0)
check('操作卡标题显示', await page.getByText('世界书条目「铁炉堡货币」').count() > 0)
// 就在消息下方确认（v2.0 即时化）
await page.locator('.op-card').getByRole('button', { name: /确认/ }).click()
await page.waitForTimeout(600)
check('操作卡确认后变已生效', await page.getByText('已生效').count() > 0)
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: /^世界$/ }).click()
await page.waitForTimeout(400)
check('面板操作区不出现（已就地确认）', await page.getByText(/AI 操作（/).count() === 0)
await page.getByRole('button', { name: /^世界$/ }).click()
await page.waitForTimeout(300)
check('条目已写入世界书（类别卡显影）', await page.getByText('经济系统', { exact: true }).count() > 0)
await page.locator('.tabbar').getByText('对话').click()
await page.waitForTimeout(400)

// ---- 5. 开始游戏向导 ----
console.log('【开始游戏向导】')
await page.getByRole('button', { name: /梦境推进/ }).click()
await page.waitForTimeout(400)
check('游戏栏未开始显示入口', await page.getByText('梦境尚未开启').count() > 0)
await page.getByRole('button', { name: /开始游戏/ }).click()
await page.waitForTimeout(5000)
check('开局设定卡出现', await page.getByText('开局设定卡').count() > 0)
const wv = await page.locator('.modal-sheet textarea').first().inputValue()
check('世界观填出', wv.includes('铁炉堡的清晨'), wv.slice(0, 30))
check('开局角色卡出现', await page.getByText('艾莉丝', { exact: false }).count() > 0)
await page.getByRole('button', { name: /开始游戏（含开场白）/ }).click()
await page.waitForTimeout(2500)
check('开场白写入游戏流', await page.getByText(/晨雾披上铁炉堡的城垛/).count() > 0)

// ---- 6. 游戏对话（写作） ----
console.log('【游戏对话】')
await page.locator('.chat-inputbar textarea').fill('我走到东门前，敲了三下。')
await page.locator('.send-btn').click()
await page.waitForTimeout(2500)
check('游戏用户消息上屏', await page.getByText('我走到东门前，敲了三下。').count() > 0)
check('AI 回复上屏（XML 解析成正文）', await page.getByText(/回应：/).count() > 0)
check('无泄漏文本（辨视角不显示）', await page.getByText('辨视角').count() === 0)
check('无泄漏文本（遵写规不显示）', await page.getByText('遵写规').count() === 0)
check('无 BAR 原文上屏', await page.getByText('[[BAR]]').count() === 0)
check('无 XML 标签原文上屏', await page.getByText('dream_after_format').count() === 0)
check('token 统计显示', await page.getByText(/共 3\.7k token/).count() > 0)
check('金额折算显示', await page.getByText(/¥0\./).count() > 0)
check('状态条 HUD 出现（AI 报数 72/100）', await page.getByText('72/100').count() > 0)

// ---- 6.3 消息长按操作 ----
console.log('【消息长按】')
await page.locator('.msg-card').last().dispatchEvent('touchstart', {})
await page.waitForTimeout(750)
check('长按弹出操作条', await page.getByText('消息操作').count() > 0)
// 编辑
await page.getByRole('button', { name: /编辑/ }).click()
await page.waitForTimeout(300)
const editBox = page.locator('.modal-sheet textarea').first()
await editBox.fill('（编辑后）回应：「我走到东门前，敲了三下。」')
const editModal = page.locator('.modal-mask').filter({ hasText: '编辑消息' })
await editModal.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
check('编辑后内容上屏', await page.getByText(/编辑后）回应/).count() > 0)
// 重新生成（长按该条）
await page.locator('.msg-card').last().dispatchEvent('touchstart', {})
await page.waitForTimeout(750)
await page.getByRole('button', { name: /重新生成/ }).click()
await page.waitForTimeout(2500)
check('重新生成成功（新回复）', await page.getByText(/回应：/).count() > 0 && await page.getByText(/编辑后/).count() === 0)

// ---- 6.5 章节总结 + 同步设定按钮 ----
console.log('【章节总结】')
await page.getByRole('button', { name: /^总结$/ }).click()
await page.waitForTimeout(3000)
check('回顾卡出现', await page.getByText('铁炉堡清晨之约').count() > 0)
check('回顾事件渲染', await page.getByText('敲开东门遇见艾莉丝').count() > 0)

console.log('【整理交流设定】')

await page.getByRole('button', { name: /^交流/ }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /整理设定/ }).click()
await page.waitForTimeout(1500)
check('整理反馈出现', await page.getByText(/暂无新设定|已整理交流设定/).count() > 0)
await page.getByRole('button', { name: /^游戏/ }).click()
await page.waitForTimeout(400)

// ---- 7. 面板：存档切换 + 整理世界书 ----
console.log('【面板 · 存档】')
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
check('面板顶端带存档名', await page.getByText('铁炉堡篇').count() > 0)
await page.getByRole('button', { name: /铁炉堡篇/ }).click()
await page.waitForTimeout(300)
check('存档切换弹层出现', await page.getByText('选择存档').count() > 0)
await page.locator('.list-row', { hasText: '铁炉堡篇' }).click()
await page.waitForTimeout(400)

console.log('【整理世界书】')
await page.getByRole('button', { name: /^角色$/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /整理世界书/ }).click()
await page.waitForTimeout(2000)
check('角色卡出现（艾莉丝）', await page.getByText('艾莉丝', { exact: false }).count() > 0)
check('角色身份显示', await page.getByText('见习法师', { exact: false }).count() > 0)
check('整理统计显示', await page.getByText(/上次整理/).count() > 0)

// 点角色卡 → 全屏角色页（六维雷达 + 境界）
console.log('【角色全屏页】')
await page.locator('.char-card', { hasText: '艾莉丝' }).click()
await page.waitForTimeout(600)
check('全屏页标题', await page.getByText('艾莉丝', { exact: true }).count() > 0)
check('能力雷达出现', await page.getByText('能力雷达').count() > 0)
check('六维雷达渲染', await page.locator('svg polygon[fill="var(--accent)"]').count() > 0)
check('境界显示', await page.getByText('炼气三层', { exact: false }).count() > 0)
check('编辑按钮（可编辑）', await page.getByRole('button', { name: /编辑角色卡/ }).count() > 0)
await page.getByRole('button', { name: '✕' }).click()
await page.waitForTimeout(300)

// ---- 8. 世界 tab：属性设定 + 临时区 ----
console.log('【世界 tab】')
await page.getByRole('button', { name: /^世界$/ }).click()
await page.waitForTimeout(400)
check('属性设定卡出现', await page.getByText('属性设定').count() > 0)
check('血条设定卡出现', await page.getByText('血条设定').count() > 0)
check('默认六维展示', await page.getByText('力量', { exact: true }).count() > 0)

async function pendingCount(): Promise<number> {
  const m = await page.getByText(/临时区（AI 新展开 \d+ 条/).innerText()
  return parseInt(m.match(/\d+/)![0], 10)
}
check('临时区出现', await page.getByText(/临时区（AI 新展开/).count() > 0)
check('临时条目带类别', await page.getByText('地理环境', { exact: true }).count() > 0)
const beforeP = await pendingCount()
await page.getByTitle('确认写入世界书').first().click()
await page.waitForTimeout(400)
check('确认后临时区减 1', (await pendingCount()) === beforeP - 1)
await page.getByTitle('丢弃').first().click()
await page.waitForTimeout(400)
check('丢弃后临时区再减 1', (await pendingCount()) === beforeP - 2)

// 世界观梳理（AI 归纳，不是条目抄录）
console.log('【世界观梳理】')
check('更新按钮存在', await page.getByTitle('同步最新设定').count() > 0)
await page.getByRole('button', { name: /^梳理$/ }).click()
await page.waitForTimeout(3000)
check('梳理摘要出现', await page.getByText('铁炉堡的清晨').count() > 0)
check('类别卡概括出现', await page.getByText('东境狼群出没').count() > 0)
check('类别卡存在（地理环境）', await page.getByText('地理环境', { exact: true }).count() > 0)
await page.locator('.world-cat-card', { hasText: '地理环境' }).click()
await page.waitForTimeout(400)
check('类别卡详情打开（条目全文）', await page.getByText('铁炉堡东境出现狼群').count() > 0)
check('详情内可编辑/删除', await page.getByRole('button', { name: /^编$/ }).count() > 0)
check('详情内可新增条目', await page.getByRole('button', { name: /新增条目/ }).count() > 0)
await page.locator('.modal-full > div').first().locator('button').last().click()
await page.waitForTimeout(300)

// 属性建议（AI 按交流内容）
console.log('【属性建议】')
await page.getByRole('button', { name: /按交流建议/ }).click()
await page.waitForTimeout(2500)
check('建议维度填入编辑区', await page.locator('input[placeholder="维度名"]').count() >= 4)
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
check('保存后显示新维度（体魄）', await page.getByText('体魄', { exact: true }).count() > 0)

// ---- 9. 配置 tab：世界书卡 + 绑定 + 变量 ----
console.log('【配置 tab】')
await page.getByRole('button', { name: /^配置$/ }).click()
await page.waitForTimeout(400)
check('世界书默认收起', await page.getByText(/世界书（.*本）/).count() > 0)
await page.getByText(/世界书（.*本）/).click()
await page.waitForTimeout(300)
check('书本卡出现', await page.locator('.wb-card').count() > 0)
// 打开卡 → 详情页
await page.locator('.wb-card', { hasText: '自动笔记簿' }).getByRole('button', { name: /打开/ }).click()
await page.waitForTimeout(400)
check('书详情条目全文', await page.getByText('铁炉堡东境出现狼群').count() > 0)
check('详情内条目管理按钮', await page.getByRole('button', { name: /^删$/ }).count() > 0)
check('详情内新增条目', await page.getByRole('button', { name: /＋ 条目/ }).count() > 0)
// 绑定弹层（多存档勾选）
await page.getByRole('button', { name: /绑定/ }).last().click()
await page.waitForTimeout(400)
check('绑定弹层出现', await page.getByText(/绑定存档/).count() > 0)
const bindCk = page.locator('.modal-sheet input[type="checkbox"]').first()
await bindCk.check()
await page.waitForTimeout(300)
check('勾选生效（checkbox checked）', await bindCk.isChecked())
await bindCk.uncheck()
await page.waitForTimeout(300)
await page.getByRole('button', { name: '完成' }).click()
await page.waitForTimeout(300)
// 关闭详情
await page.locator('.modal-full > div').first().locator('button').last().click()
await page.waitForTimeout(300)
// 变量折叠
await page.getByText(/会话变量（.*）/).click()
await page.waitForTimeout(300)
check('变量查看器展开', await page.getByText('这里显示的是存档的宏变量').count() > 0)

// ---- 10. 关系图 ----
console.log('【关系图】')
await page.getByRole('button', { name: /^关系$/ }).click()
await page.waitForTimeout(500)
check('关系图渲染', await page.locator('.rel-graph svg circle').count() >= 2)
await page.locator('.rel-graph svg circle').first().click()
await page.waitForTimeout(500)
check('关系图点击弹全屏角色页', await page.getByText('能力雷达').count() > 0)
await page.getByRole('button', { name: '✕' }).click()

// ---- 11. 截图 ----
await page.screenshot({ path: join(root, 'docs', 'screenshot-v3.png'), fullPage: true })

await browser.close()
mock.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (errors.length) console.log('JS 错误：', errors.slice(0, 5))
process.exit(fail ? 1 : 0)
