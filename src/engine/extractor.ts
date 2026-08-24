/**
 * 事实提取引擎：把最近对话变成结构化「世界书事实」。
 *
 * 输入：最近 N 轮对话 + 已有实体清单（增量合并防重复创建）
 * 输出：{ characters, relations, facts }
 *   - characters → 角色面板数据（按名字增量更新）
 *   - relations  → 关系图数据（按 from+to+relType 增量更新）
 *   - facts      → 自动笔记簿条目（key 触发词 + content）
 */

import type { ApiConfig } from '../types'
import { chatCompletion } from './pipeline'

export interface ExtractedCharacter {
  name: string
  identity?: string
  description?: string
}

export interface ExtractedRelation {
  from: string
  to: string
  relType: string
  label?: string
}

export interface ExtractedFact {
  key: string      // 触发词，逗号分隔；空 = 常驻
  content: string
}

export interface ExtractResult {
  characters: ExtractedCharacter[]
  relations: ExtractedRelation[]
  facts: ExtractedFact[]
  raw: string
}

/** 已有实体清单（防重复） */
export interface ExistingEntities {
  characters: string[]   // 名字
  relations: string[]    // "from|to|relType"
  facts: string[]        // 触发词
  /** 尚未整理的对话范围（限最近若干条文本用） */
  recentText: string
}

const SYSTEM_PROMPT = `你是梦境世界书的「书记官」。阅读一段 AI 跑团对话，提取其中值得沉淀到世界书的新信息。

输出严格 JSON（不要输出任何其他文字、不要代码块），格式：
{
  "characters": [{"name": "角色名", "identity": "身份/地位", "description": "一两句关键特征"}],
  "relations": [{"from": "甲", "to": "乙", "relType": "关系类型", "label": "简要描述"}],
  "facts": [{"key": "触发词，多个用逗号分隔，可以为空表示常驻", "content": "一条事实，一句到两句"}]
}

规则：
1. 只提取「新的」或「发生了变化的」信息。已有的不要重复提取。
2. characters：新的重要角色；或已知角色的重要变化（身份、状态转折）。
3. relations：新出现或变化的关系（亲缘/敌友/恋人/师徒等）。
4. facts：世界观设定、地点、物品、重要事件、剧情转折。一条事实一记，不要大段复制原文。
5. 名字用对话中的原称。无法确定名字的次要角色不提取。
6. 如果某类没有新内容，输出空数组。
7. 全部用中文。`

/** 从模型输出中提取 JSON（容错：剥离代码块、找首尾大括号） */
export function extractJson<T>(raw: string): T | null {
  let text = raw.trim()
  // 剥离 ```json ... ``` 或 ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  // 找第一个 { 到最后一个 }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  text = text.slice(start, end + 1)
  try {
    return JSON.parse(text) as T
  } catch {
    // 常见小修：尾逗号
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')) as T
    } catch {
      return null
    }
  }
}

/** 清洗提取结果（空字段过滤等），纯函数便于测试 */
export function sanitizeResult(parsed: Partial<ExtractResult>): ExtractResult {
  return {
    characters: Array.isArray(parsed.characters)
      ? parsed.characters.filter(c => c?.name && String(c.name).trim())
      : [],
    relations: Array.isArray(parsed.relations)
      ? parsed.relations.filter(r => r?.from?.trim() && r?.to?.trim())
      : [],
    facts: Array.isArray(parsed.facts)
      ? parsed.facts.filter(f => f?.content?.trim())
      : [],
    raw: '',
  }
}

export async function extractFacts(
  api: ApiConfig,
  existing: ExistingEntities,
): Promise<ExtractResult> {
  const existingInfo = [
    existing.characters.length ? `已登记角色：${existing.characters.join('、')}` : '',
    existing.relations.length ? `已有关系：${existing.relations.join('；')}` : '',
    existing.facts.length ? `已有事实触发词：${existing.facts.join('、')}` : '',
  ].filter(Boolean).join('\n') || '（暂无已登记信息）'

  const reply = await chatCompletion(api, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${existingInfo}\n\n=== 请阅读以下对话，提取新事实 ===\n\n${existing.recentText.slice(0, 24000)}` },
  ])

  const parsed = extractJson<ExtractResult>(reply)
  if (!parsed) {
    return { characters: [], relations: [], facts: [], raw: reply }
  }
  return { ...sanitizeResult(parsed), raw: reply }
}
