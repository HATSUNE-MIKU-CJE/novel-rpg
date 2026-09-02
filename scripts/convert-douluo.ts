/**
 * 斗罗世界书 ST JSON → NovelRPG 世界书规范 v2 转换器。
 * 将「通用/斗一/斗二」按 App v2 格式离线整理：kind/hook/key/timeline/isMain/payload，
 * 内容统一剥离 markdown/ST 标签/英文音译，人物卡语义化（身份→identity、魂力等级→realm）。
 *   npx tsx scripts/convert-douluo.ts [通用 斗一 斗二 ...]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { cleanImportedContent, guessKindFromComment, guessHookFromEntry } from '../src/stores/data'

/** 「唐三Q」→「唐三」（ST 作者冠名后缀清理；不误删无 Q 的名字） */
function cleanName(s: string): string {
  return String(s ?? '').replace(/Q+$/u, '').trim()
}

/** 从 content 提取字段值，如 「- **身份**: 史莱克七怪核心、…」→「史莱克七怪核心」 */
function extractField(content: string, label: string): string | undefined {
  const re = new RegExp(`(?:^|\\n)\\s*[-*+]?\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*([^\\n]+)`)
  const m = content.match(re)
  return m?.[1]?.trim() || undefined
}

/** 过长字段截断（身份取第一段，避免卡面超长） */
function shortField(v: string, max = 24): string | undefined {
  const t = String(v ?? '').split(/[、，,;；]/)[0].trim()
  return t ? t.slice(0, max) : undefined
}

let totalEntries = 0, totalCards = 0, totalResidue = 0, totalMain = 0

function convert(vol: string) {
  const file = `/home/miku/dsh-work/斗罗大陆Reborn-${vol}.json`
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const entries: any[] = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries ?? {})
  const outEntries: any[] = []
  const dist = new Map<string, number>()
  let residue = 0, noName = 0, main = 0

  for (const e of entries) {
    if (!e?.content) continue
    const comment = String(e.comment ?? '')
    const kind = guessKindFromComment(comment)
    dist.set(kind, (dist.get(kind) ?? 0) + 1)

    // key（ST keys 数组 → v2 数组）
    let key: string[] = []
    if (Array.isArray(e.keys) && e.keys.length) key = e.keys.map(String)
    else if (Array.isArray(e.entry_keys) && e.entry_keys.length) key = e.entry_keys.map(String)
    else if (e.key) key = Array.isArray(e.key) ? e.key.map(String) : [String(e.key)]

    // hook（comment 冒号后）+ 冠名清理
    let hook = guessHookFromEntry(e, kind)?.trim() || ''
    hook = cleanName(hook)

    // 时期：comment 卷标（斗一/斗二…；「通用」不设时期 = 全时期有效）
    const volTag = comment.match(/斗[一二三四五]/)?.[0] || undefined

    // 内容清洗（宏/标签/markdown/英文音译 → 纯文本）
    const content = cleanImportedContent(String(e.content))
    if (/<\/?[a-zA-Z][^>]{0,80}>|\{\{|^\s*#+\s+|^\s*[-*+]\s+|\*\*|\x60[^\x60\n]{1,200}\x60|\([A-Za-z][A-Za-z0-9 .\-_]{0,40}\)/m.test(content)) residue++

    const entry: any = {
      kind,
      key,
      content,
      enabled: e.enabled !== false,
    }
    if (volTag) entry.timeline = volTag
    if (hook) entry.hook = hook

    if (kind === 'character') {
      const name = cleanName(hook || key[0] || extractField(content, '全名') || '')
      if (!name) { noName++; continue }
      const payload: any = { name }
      const identity = extractField(content, '身份')
      if (identity) payload.identity = shortField(identity)
      const realm = extractField(content, '魂力等级')
      if (realm) payload.realm = shortField(realm, 30)
      entry.payload = payload
      if (!key.length) entry.key = [name]
      if (name.includes('唐三') && !main && vol === '斗一') { entry.isMain = 1; main++ }
      totalCards++
    } else if (kind !== 'note') {
      const nm = cleanName(hook || key[0] || '')
      if (nm) entry.payload = { name: nm }
    }
    outEntries.push(entry)
  }

  const out = {
    version: 2,
    worldbook: {
      name: `斗罗大陆Reborn · ${vol}`,
      description: `由 ST 世界书离线转换（NovelRPG v2 规范）：人物卡含身份/魂力，卷标为时期，唐三设主角。`,
    },
    entries: outEntries,
  }
  const outPath = `/home/miku/dsh-work/斗罗大陆Reborn-${vol}.v2.json`
  writeFileSync(outPath, JSON.stringify(out), 'utf8')

  console.log(`\n✅ ${vol}: ${outEntries.length} 条 → ${outPath}`)
  console.log(`   kind 分布: ${JSON.stringify(Object.fromEntries(dist))}`)
  console.log(`   人物卡 ${totalCards ? dist.get('character') : 0} · payload.name 缺失 ${noName} · 残留标记 ${residue} · 主角标记 ${main}`)
  console.log(`   文件大小: ${(statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`)
  totalEntries += outEntries.length
  totalResidue += residue
  totalMain += main
}

const vols = process.argv.slice(2)
if (!vols.length) {
  console.error('用法: npx tsx scripts/convert-douluo.ts 通用 斗一 斗二 [斗三 斗四]')
  process.exit(1)
}
for (const v of vols) convert(v)
console.log(`\n===== 合计 ${totalEntries} 条 · 残留 ${totalResidue} · 主角 ${totalMain} =====`)
