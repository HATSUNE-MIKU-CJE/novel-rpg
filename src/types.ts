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
  /** v1.3：世界类别（修炼体系/经济系统/…），用于世界 tab 板块分组 */
  category?: string
  createdAt: number
  updatedAt: number
}

// ---------------- 存档 ----------------
export type StreamKind = 'talk' | 'game'

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
  /** v2.0：交流栏每 N 条用户消息自动整理（0=关闭，默认 0） */
  talkAutoInterval?: number
  /** 上下文压缩预算（token），0=不启用；默认 1M */
  ctxBudget?: number
  /** 已压缩的消息 seq 上限（此前的消息已折入摘要） */
  summarizedSeq?: number
  /** 剧情摘要文本（压缩后的历史摘要） */
  summary?: string
  /** v1.8.1：交流流已压缩的消息 seq 上限 */
  summarizedTalkSeq?: number
  /** v1.8.1：交流流摘要文本 */
  summaryTalk?: string
  /** 统计缓存：累计 token */
  statTokens?: number
  statCostYuan?: number
  /** M4：自动笔记簿世界书 id */
  notebookWorldbookId?: number
  lastOrganized?: number
  organizeStats?: string   // JSON：上次整理的统计 {chars, rels, facts, at}
  /** v1.2 双流：1=已开始游戏（游戏流可玩）；0=仍在交流阶段 */
  gameStarted?: number
  /** v1.2：交流流 → 游戏设定 的同步游标（已同步到的 seq） */
  lastSyncedTalkSeq?: number
  /** v1.2：游戏流 → 交流栏 的同步游标 */
  lastSyncedGameSeq?: number
  /** v1.2：1=角色卡作为常驻注入游戏对话（默认）；0=仅面板可视化 */
  charInject?: number
  /** v1.2：上次停留的流（重开存档时进入哪个） */
  lastStream?: StreamKind
  /** v1.3：存档级属性体系（AttrSchema JSON：dims + realmLabel） */
  attrSchemaJson?: string
  /** v1.4：世界观总览（AI 梳理结果 WorldOverview JSON） */
  worldOverviewJson?: string
  /** v1.8：状态条配置（BarSchema JSON：bars 模板列表） */
  barSchemaJson?: string
  /** v2.2：状态卡配置（StatusCardDef JSON：字段注册表+开关） */
  statusCardJson?: string
  /** v2.2：状态卡当前值（Record<string, string | string[]> JSON，AI 每轮直通更新） */
  statusValuesJson?: string
  createdAt: number
  updatedAt: number
  lastActive: number
}

/** v1.4 世界观总览（AI 对世界书条目的归纳，非抄录） */
export interface WorldOverview {
  summary: string
  blocks: Array<{
    category: string
    content: string
    related: string[]   // 相关条目触发词（最多 5 个）
  }>
  at: number
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
  /** v1.2 双流：talk=交流栏（设计商谈），game=游戏流（跑团剧情）；缺省/旧数据视为 game */
  stream?: StreamKind
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
  /** v1.3：境界/段位等（自由文本，AI 可从对话识别） */
  realm?: string
  attributesJson?: string
  /** v1.8：状态条数值（JSON Record<条名, 数值>） */
  barValuesJson?: string
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

// ---------------- AI 操作审计（v1.5） ----------------
/** AI 协议块操作（临时区审阅 → 确认执行/退回） */
export interface Op {
  id?: number
  campaignId: number
  /** 操作类型：entry.upsert / entry.delete / entry.disable / char.upsert / char.rename / rel.upsert / rel.delete / schema.propose */
  kind: string
  /** 操作参数 JSON */
  payload: string
  status: 'pending' | 'done' | 'rejected'
  createdAt: number
  doneAt?: number
  /** v2.0：产生该操作的交流栏消息 id（消息内嵌操作卡关联） */
  msgId?: number
  /** v2.0：自动/手动同步来源标记（extract=书记官提取 / ai=AI 操作块 / manual=手动） */
  src?: 'extract' | 'ai' | 'manual'
}

// ---------------- 回收站（v2.0） ----------------
/** 被删除的世界书条目/角色/关系，保留以便撤销恢复 */
export interface TrashItem {
  id?: number
  campaignId: number
  /** entry | character | relation */
  kind: 'entry' | 'character' | 'relation'
  /** 被删除记录的主键（恢复时用 put 归还） */
  refId: number
  /** 记录完整内容（恢复用） */
  payload: string
  /** 删除标题（展示用） */
  title: string
  deletedAt: number
}

// ---------------- 状态卡（v2.2） ----------------
/** 状态卡字段：单行（text）或 清单（list） */
export interface StatusCardField {
  id: string
  /** 显示名/AI 报数键（两者一致） */
  label: string
  /** text=单行文本；list=物品/事件清单（支持追加） */
  type: 'text' | 'list'
  /** v2.2：字段级停用 */
  disabled?: boolean
}

export interface StatusCardDef {
  /** 整卡开关（关 = 不注入协议、不解析、不显示） */
  enabled: boolean
  fields: StatusCardField[]
}
