import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto('http://localhost:5173/#/settings')
await page.waitForTimeout(800)
await page.evaluate(() => new Promise<void>((resolve) => {
  const req = indexedDB.open('novel-rpg')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction(['campaigns'], 'readwrite')
    tx.objectStore('campaigns').put({
      id: 1, name: '宝宝测试档', dreamConfigJson: JSON.stringify({
        main_style: 'baihua', minor_style: ['info_gap', 'nsfw_direct'], role_setting: 'user_is_user',
        person: 'third', rush: 'no_rush', narrator: 'balanced', length: 'dyn_long',
        banword: 'deepseek', channel: 'auto', thinking: 'normal', protocols: ['scene_info'], output_mode: 'writing',
        custom: {},
      }),
      varsJson: '{}', autoInterval: 5, ctxBudget: 1000000, createdAt: Date.now(), updatedAt: Date.now(), lastActive: Date.now(),
    })
    tx.oncomplete = () => { db.close(); resolve() }
  }
}))
await page.reload()
await page.waitForTimeout(800)
await page.getByRole('button', { name: /🎛 预设/ }).click()
await page.waitForTimeout(500)
// 展开「自定义角色」看 custom 参数（滚动到角色设定组）
await page.getByText('自定义角色', { exact: true }).scrollIntoViewIfNeeded()
await page.getByText('自定义角色', { exact: true }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: 'docs/screenshot-panel-expand.png' })
console.log('saved expand')
// 自定义字数
await page.getByText('自定义字数', { exact: true }).scrollIntoViewIfNeeded()
await page.getByText('自定义字数', { exact: true }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: 'docs/screenshot-panel-length.png' })
console.log('saved length')
await browser.close()
