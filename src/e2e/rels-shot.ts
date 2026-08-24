import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.evaluate(() => new Promise<void>((resolve) => {
  const req = indexedDB.open('novel-rpg')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction(['campaigns', 'characters', 'relations'], 'readwrite')
    tx.objectStore('campaigns').put({
      id: 9, name: '关系图示例', dreamConfigJson: '{}', varsJson: '{}',
      autoInterval: 5, ctxBudget: 1000000, createdAt: Date.now(), updatedAt: Date.now(), lastActive: Date.now(),
    })
    const chars = [
      { campaignId: 9, name: '艾莉丝', identity: '见习法师', description: '银发少女，带着旧魔法书。', source: 'ai', createdAt: 1, updatedAt: 1 },
      { campaignId: 9, name: '铁锤', identity: '卫队长', description: '魁梧矮人，外冷内热。', source: 'ai', createdAt: 1, updatedAt: 1 },
      { campaignId: 9, name: '老酒保', identity: '旅店老板', description: '消息灵通的老矮人。', source: 'ai', createdAt: 1, updatedAt: 1 },
      { campaignId: 9, name: '狼王', identity: '未知', description: '东境的威胁。', source: 'ai', createdAt: 1, updatedAt: 1 },
    ]
    chars.forEach((c) => tx.objectStore('characters').add(c))
    const rels = [
      { campaignId: 9, fromChar: '艾莉丝', toChar: '铁锤', relType: '同伴', label: '互相戒备' },
      { campaignId: 9, fromChar: '艾莉丝', toChar: '老酒保', relType: '熟人', label: '常客' },
      { campaignId: 9, fromChar: '铁锤', toChar: '老酒保', relType: '旧识' },
      { campaignId: 9, fromChar: '老酒保', toChar: '狼王', relType: '仇恨', label: '死了个侄子' },
    ]
    rels.forEach((r) => tx.objectStore('relations').add(r))
    tx.oncomplete = () => { db.close(); resolve() }
  }
}))
await page.reload()
await page.waitForTimeout(800)
await page.goto('http://localhost:5173/#/chat')
await page.waitForTimeout(400)
// 打开面板 → 关系 tab
await page.locator('.tabbar').getByText('面板').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /🕸 关系/ }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: 'docs/screenshot-rels.png' })
console.log('saved')
await browser.close()
