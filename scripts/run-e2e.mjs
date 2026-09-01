/**
 * e2e runner：起 vite → 等就绪 → 跑指定 tsx 测试 → 清理。
 *   node scripts/run-e2e.mjs v2-status.e2e.ts
 */
import { spawn } from 'node:child_process'

const testFile = process.argv[2]
if (!testFile) { console.error('usage: node scripts/run-e2e.mjs <test.ts>'); process.exit(1) }

const vite = spawn('npx', ['vite', '--port', '5173'], { cwd: process.cwd(), stdio: 'ignore', detached: false })

const waitReady = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://localhost:5173/')
      if (r.ok) return true
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const ok = await waitReady()
if (!ok) { console.error('vite not ready'); vite.kill(); process.exit(1) }

const runner = spawn('npx', ['tsx', 'src/e2e/' + testFile], { cwd: process.cwd(), stdio: 'inherit' })
const code = await new Promise((res) => runner.on('close', res))
vite.kill()
process.exit(code ?? 1)
