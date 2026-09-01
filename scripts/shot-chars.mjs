/**
 * UI 检查截图：面板 → 角色 tab，看迁移按钮是否渲染。
 *   node scripts/shot-chars.mjs
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200)) })

await page.goto('http://localhost:5173/#/panel')
await page.waitForTimeout(1500)

// 无存档时先建一个（或看当前状态）
const hasTabBar = await page.locator('.tabbar').count()
console.log('tabbar:', hasTabBar)
if (hasTabBar) {
  await page.locator('.tabbar').getByText('面板', { exact: true }).click().catch(async () => {
    await page.locator('.tabbar').getByText('面板').first().click()
  })
}
await page.waitForTimeout(800)

// 面板角色 tab
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click().catch(async () => {
  await page.locator('.panel-tabs button').first().click()
})
await page.waitForTimeout(600)

// 完整页面截图（角色 tab）
await page.screenshot({ path: '/tmp/panel-chars-top.png', fullPage: false })
await page.screenshot({ path: '/tmp/panel-chars-full.png', fullPage: true })

// 打印关键文本
const bodyText = await page.locator('body').innerText()
console.log('--- body text (slice) ---')
console.log(bodyText.slice(0, 800))
console.log('--- 迁移按钮 count:', await page.getByText('迁移旧角色卡', { exact: false }).count())
console.log('--- 整理世界书 count:', await page.getByText('整理世界书', { exact: false }).count())

await browser.close()
process.exit(0)
