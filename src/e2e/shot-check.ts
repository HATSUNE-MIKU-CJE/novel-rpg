/**
 * 验证：角色 tab 底部按钮（迁移）不被 tabbar 遮挡。
 *   node scripts/run-e2e.mjs shot-check.ts（在 src/e2e 下）
 */
import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
// 模拟手机：小视口 + 底部安全区
const page = await browser.newPage({ viewport: { width: 390, height: 700 } })
await page.goto('http://localhost:5173/#/panel')
await page.waitForTimeout(1200)
// 切角色 tab
await page.locator('.panel-tabs').getByRole('button', { name: /角色/ }).click().catch(async () => {
  await page.locator('.panel-tabs button').first().click()
})
await page.waitForTimeout(400)
// 滚动到底部
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/check-bottom.png' })
// 检查迁移按钮是否在视口内且未被 tabbar 覆盖
const btn = await page.getByText('迁移旧角色卡', { exact: false }).first().boundingBox()
const tabbar = await page.locator('.tabbar').boundingBox()
console.log('btn:', JSON.stringify(btn), 'tabbar:', JSON.stringify(tabbar))
if (btn && tabbar) {
  const btnBottom = btn.y + btn.height
  console.log('btn bottom:', btnBottom.toFixed(0), 'tabbar top:', tabbar.y.toFixed(0), 'overlap:', btnBottom > tabbar.y)
}
await browser.close()
process.exit(0)
