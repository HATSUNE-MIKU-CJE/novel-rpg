/**
 * M4 提取器端到端测试：mock 返回提取 JSON → extractFacts 解析 → 增量合并逻辑。
 *   npx tsx src/engine/extractor.e2e.ts
 */
import { createServer } from 'http'
import { extractFacts, extractJson, sanitizeResult, type ExtractResult } from './extractor'
import type { ApiConfig } from '../types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---- mock：返回带有角色的提取 JSON ----
const mockReply = `好的，以下是我提取的内容：
\`\`\`json
{
  "characters": [
    {"name": "艾莉丝", "identity": "见习法师", "description": "银发少女，铁炉堡东境的见习法师，随身带着旧魔法书。", "attributes": [{"label": "智力", "value": 8}, {"label": "胆识", "value": 6}, {"label": "武力", "value": 15}]},
    {"name": "铁锤·铜须", "identity": "铁炉堡卫队长", "description": "魁梧的矮人，对陌生人戒备，但尊重勇气。", "attributes": [{"label": "力量", "value": 9.3}, {"label": "", "value": 5}]}
  ],
  "relations": [
    {"from": "艾莉丝", "to": "铁锤·铜须", "relType": "敌人", "label": "初次见面互有敌意"}
  ],
  "facts": [
    {"key": "铁炉堡,东境", "content": "铁炉堡东境最近出现了狼群，商队开始绕路。"},
    {"key": "", "content": "王族徽记是敲击的锤子与铁砧交叉图案。"}
  ]
}
\`\`\`
`

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: mockReply } }] }))
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as any).port

const api: ApiConfig = {
  name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k',
  model: 'mock', temperature: 0.3, maxTokens: 2000, isDefault: 1, createdAt: 0,
}

console.log('【extractJson 容错】')
const j1 = extractJson<{ a: number }>('```json\n{"a": 1}\n```')
check('代码块剥离', j1?.a === 1)
const j2 = extractJson<{ a: number }>('好的，结果如下：{"a": 2} 希望有帮助')
check('包裹文本提取', j2?.a === 2)
const j3 = extractJson<{ a: number }>('{"a": 3,}')
check('尾逗号修复', j3?.a === 3)
check('无 JSON 返回 null', extractJson('没有内容') === null)

console.log('【extractFacts 全链路】')
const result = await extractFacts(api, {
  characters: ['艾莉丝'],
  relations: ['艾莉丝|铁锤·铜须|敌人'],
  facts: ['铁炉堡'],
  recentText: '梦客：我敲开了铁炉堡的大门。\n思客：卫队长铁锤·铜须拦住了你。',
})
check('角色提取 ×2', result.characters.length === 2, `got ${result.characters.length}`)
check('关系提取', result.relations.length === 1 && result.relations[0].relType === '敌人')
check('事实提取 ×2', result.facts.length === 2, `got ${result.facts.length}`)
check('常驻事实（key 空）', result.facts.some((f) => f.key === ''))
check('触发事实带 key', result.facts.some((f) => f.key.includes('铁炉堡')))
check('属性提取：武力钳到 10', result.characters[0].attributes?.find((a) => a.label === '武力')?.value === 10)
check('属性提取：9.3 四舍五入 9', result.characters[1].attributes?.find((a) => a.label === '力量')?.value === 9)
check('属性提取：空 label 被过滤', result.characters[1].attributes?.length === 1)

console.log('【数据质量过滤（sanitizeResult）】')
const parsed = extractJson<ExtractResult>('{"characters":[{"name":"甲"},{"name":""},{"name":"乙","description":"x"}],"relations":[{"from":"a","to":"b","relType":"友"},{"from":"","to":"b","relType":"友"}],"facts":[{"key":"k","content":"内容"},{"key":"k","content":""}]}')
const clean = sanitizeResult(parsed!)
check('空名角色被过滤', clean.characters.length === 2, `got ${clean.characters.length}`)
check('空 from 关系被过滤', clean.relations.length === 1, `got ${clean.relations.length}`)
check('空内容事实被过滤', clean.facts.length === 1, `got ${clean.facts.length}`)

server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
