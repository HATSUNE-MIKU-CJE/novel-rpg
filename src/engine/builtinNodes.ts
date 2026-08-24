/**
 * 内置默认节点：DeepSeek 官方 + opencode-go 网关（key 留空占位，用户填）。
 * 首次启动（api_configs 为空）时自动种入。
 */

import { db } from '../db'

export const BUILTIN_NODES = [
  {
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 1,
    maxTokens: 4000,
    topP: 0.95,
    isDefault: 0,
  },
  {
    name: 'opencode-go 网关',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 1,
    maxTokens: 4000,
    topP: 0.95,
    isDefault: 1,
  },
]

export async function seedBuiltinNodes(): Promise<boolean> {
  const count = await db.apiConfigs.count()
  if (count > 0) return false
  const now = Date.now()
  for (const n of BUILTIN_NODES) {
    await db.apiConfigs.add({ ...n, createdAt: now })
  }
  return true
}
