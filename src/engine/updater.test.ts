/**
 * 更新检查逻辑自测。
 *   npx tsx src/engine/updater.test.ts
 */
import { compareVersions } from './updater'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('【版本比较】')
check('1.0.1 > 1.0.0', compareVersions('1.0.1', '1.0.0') > 0)
check('1.0.0 < 1.0.1', compareVersions('1.0.0', '1.0.1') < 0)
check('v 前缀容忍', compareVersions('v1.2.0', '1.2.0') === 0)
check('相等', compareVersions('2.3.4', '2.3.4') === 0)
check('主版本优先', compareVersions('2.0.0', '1.9.9') > 0)
check('补丁版本', compareVersions('1.0.1', '1.0.0') > 0)
check('三位对两位', compareVersions('1.0.1', '1.0') > 0)
check('未来版本', compareVersions('1.0.0', '1.0.5') < 0)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
