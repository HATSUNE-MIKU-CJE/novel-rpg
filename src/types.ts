/** 数据模型定义（Dexie / IndexedDB） */

// ---------------- API 配置 ----------------
export interface ApiConfig {
  id?: number
  name: string          // 配置名，如「硅基流动」
  baseUrl: string       // 如 https://api.siliconflow.cn/v1
  apiKey: string
  model: string         // 如 deepseek-ai/DeepSeek-V3
  temperature?: number
  maxTokens?: number
  topP?: number
  headersJson?: string  // 额外请求头（JSON 字符串）
  isDefault?: number    // 1=默认 0=否
  createdAt: number
}

// ---------------- 世界书 ----------------
export interface Worldbook {
  id?: number
  name: string
  description?: string
  scope: 'global' | 'campaign'   // global=全局共享；campaign=存档专属
  createdAt: number
  updatedAt: number
}

/** 条目极简：触发词 + 内容 + 来源；key 为空 = 常驻 */
export interface Entry {
  id?: number
  worldbookId: number
  key: string           // 触发词，多词用半角逗号分隔；空 = 常驻
  content: string
  enabled: number       // 0/1
  source: 'manual' | 'ai' | 'imported'
  status?: 'pending' | 'accepted' | 'rejected'  // ai 条目审阅状态
  createdAt: number
  updatedAt: number
}

// ---------------- 存档 ----------------
export interface Campaign {
  id?: number
  name: string
  systemNote?: string    // 存档备注
  presetId?: number      // 关联预设（外部导入的）
  presetJson?: string    // 预设快照（prompts 数组 + 参数）——导入后固化
  /** 内置梦鲸思客的 12 组开关配置（DreamConfig JSON） */
  dreamConfigJson?: string
  varsJson?: string      // 会话变量 sleep_var_* 等
  autoInterval?: number  // 每 N 轮自动整理，0=关闭，默认 5
  /** 上下文压缩预算（token），0=不启用；默认 1M */
  ctxBudget?: number
  /** 已压缩的消息 seq 上限（此前的消息已折入摘要） */
  summarizedSeq?: number
  /** 剧情摘要文本（压缩后的历史摘要） */
  summary?: string
  /** 统计缓存：累计 token */
  statTokens?: number
  statCostYuan?: number
  /** M4：自动笔记簿世界书 id */
  notebookWorldbookId?: number
  lastOrganized?: number
  organizeStats?: string   // JSON：上次整理的统计 {chars, rels, facts, at}
  createdAt: number
  updatedAt: number
  lastActive: number
}

// 存档 × 世界书 绑定（mode: ref|copy）
export interface CampaignBinding {
  id?: number
  campaignId: number
  worldbookId: number
  mode: 'ref' | 'copy'
  createdAt: number
}

// ---------------- 预设 ----------------
export interface Preset {
  id?: number
  name: string
  sourceName?: string    // 原始文件名
  promptsJson: string    // [{name, role, content, enabled}]
  paramsJson: string     // {temperature, top_p, ...}
  createdAt: number
}

// ---------------- 对话 ----------------
export interface Message {
  id?: number
  campaignId: number
  role: 'user' | 'assistant' | 'system'
  content: string           // 原始内容（assistant 为未解析 XML 原文，前端解析展示）
  /** 解析后的展示结构（assistant）：正文/场景/选项/说书等 */
  parsedJson?: string
  /** usage：{prompt_tokens, completion_tokens, total_tokens, costYuan?} */
  usageJson?: string
  /** 思维链（reasoning_content），可折叠展开 */
  reasoning?: string
  seq: number
  createdAt: number
}

// ---------------- 角色 & 关系 ----------------
export interface Character {
  id?: number
  campaignId: number
  name: string
  avatar?: string
  identity?: string
  attributesJson?: string
  statusJson?: string
  description?: string
  source: 'manual' | 'ai'
  createdAt: number
  updatedAt: number
}

export interface Relation {
  id?: number
  campaignId: number
  fromChar: string
  toChar: string
  relType: string
  label?: string
  description?: string
  createdAt: number
}
