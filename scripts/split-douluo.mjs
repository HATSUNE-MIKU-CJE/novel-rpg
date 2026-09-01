/**
 * 斗罗大陆Reborn 世界书拆分器。
 * 依据条目 comment 前缀里的卷标（斗一/斗二/斗三/斗四）分桶，
 * 生成独立可导入的世界书 JSON（保持 ST 原始结构与字段原样）。
 *
 * 用法：node scripts/split-douluo.mjs
 * 输出：/home/miku/dsh-work/斗罗大陆Reborn-<卷>.json（含通用）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = '/home/miku/dsh-work/斗罗大陆Reborn.json'
const OUT_DIR = '/home/miku/dsh-work'
const VOLUMES = ['斗一', '斗二', '斗三', '斗四']
const VOL_MAP = { 斗一: '斗一', 斗二: '斗二', 斗三: '斗三', 斗四: '斗四' }

const raw = JSON.parse(readFileSync(SRC, 'utf8'))
const srcEntries = raw.entries // 对象形式 {"0": {...}}
if (!srcEntries || typeof srcEntries !== 'object' || Array.isArray(srcEntries)) {
  throw new Error('期望 entries 为对象形式')
}

const buckets = new Map()
for (const vol of [...VOLUMES, '通用']) buckets.set(vol, {})
let empty = 0

for (const [k, e] of Object.entries(srcEntries)) {
  if (!e || !e.content) { empty++; continue }
  const c = String(e.comment ?? '')
  const m = c.match(/斗[一二三四五]/)
  const vol = m ? VOL_MAP[m[0]] ?? '通用' : '通用'
  buckets.get(vol)[k] = e
}

// 写入：保留顶层 originalData，entries 只含本桶
let total = 0
const stats = {}
for (const vol of [...VOLUMES, '通用']) {
  const entries = buckets.get(vol)
  const count = Object.keys(entries).length
  stats[vol] = count
  total += count
  const out = { entries, originalData: raw.originalData }
  const path = `${OUT_DIR}/斗罗大陆Reborn-${vol}.json`
  writeFileSync(path, JSON.stringify(out), 'utf8')
  console.log(`✅ ${path}  ${count} 条`)
}

console.log(`\n合计写入 ${total} 条（原文件 ${Object.keys(srcEntries).length} 条，跳过空内容 ${empty} 条）`)
