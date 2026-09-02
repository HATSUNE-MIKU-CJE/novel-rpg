import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { db } from '../db'
import type { ApiConfig, Preset, Worldbook, Entry, Campaign, TrashItem } from '../types'
import { parseStPresetJson, type ImportedPreset } from '../engine/presetImport'
import { seedBuiltinNodes } from '../engine/builtinNodes'
import { defaultDreamConfig, DREAM_PRESET_NAME } from '../engine/dreamPreset'
import { parseCharacterPayload, characterPayloadJson } from '../engine/cards-v3'

/** 剥离 Vue 响应式代理，得到 IndexedDB 可序列化的纯对象 */
function plain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(toRaw(obj)))
}

/**
 * v3.2：按 ST 条目 comment 的 emoji/前缀粗分类 kind（斗罗式世界书）。
 * 👤=人物  📍/🏰=地点  ⚔️/🛡️=规则/体系  🗺️=地理  👥=势力  📜/📅=事件  💎/🗡️=物品  ⚙️=规则
 */
export function guessKindFromComment(comment?: string): 'character' | 'location' | 'item' | 'event' | 'rule' | 'faction' | 'note' {
  const c = String(comment ?? '').trim()
  if (!c) return 'note'
  if (/👤|人物|角色|人设/.test(c)) return 'character'
  if (/📖|📜|📅|事件|故事|历史|传说|战役|纪年|年表|剧情|纪事/.test(c)) return 'event'
  if (/📍|🏰|🗺|地域|地点|大陆|城|村|森林|山|海|谷|遗迹|世界格局/.test(c)) return 'location'
  if (/👥|势力|家族|宗门|公会|组织|帝国|王国/.test(c)) return 'faction'
  if (/💎|🗡|🔮|⚗|武器|装备|神器|宝物|物品|魂导器/.test(c)) return 'item'
  if (/⚔|🛡|⚙|规则|体系|修炼|武魂|魂环|魂技|制度|能力/.test(c)) return 'rule'
  return 'note'
}

/** v3.2：从 comment 提取 hook（「👤斗三：唐舞桐」→「唐舞桐」；锚点条目的精要） */
export function guessHookFromEntry(e: any, kind: string): string | undefined {
  const c = String(e?.comment ?? '').trim()
  // 形如「👤斗三：唐舞桐」→ 冒号后为名；「🔮物品名」→ 物品名
  const m = c.match(/[：:]\s*(.+?)$/)
  if (m?.[1]?.trim()) return m[1].trim()
  return undefined
}

/**
 * v3.5：SillyTavern 导入内容清洗（世界书设定文本 → App 纯文本）。
 * ST 世界书条目常带运行时结构（宏/HTML 标签/--- 分隔线）与 markdown 排版，
 * 导入后原样显示很违和，这里在入库时统一剥离：
 *   - {{...}} 宏标记（{{char}}/{{getvar::..}}/{{setvar::..}} 等）→ 删除
 *   - <!-- 注释 -->、<标签> 尖括号结构（含 ST 锚点 <faction_xxx>/<rule_xxx>/<worldview_detail_xxx>）→ 删除
 *   - markdown 结构 → 纯文本：# 标题标记、行首列表符号（-、*、+）、加粗、下划线、斜体、行内代码标记（反引号）
 *   - 英文音译括号注释（如 (Tang San)）→ 删除（正文中英文紧随中文名的注音，UI 显示违和）
 *   - 独立行的 --- 分隔线 → 删除
 *   - \r、多余连续空行 → 归一
 */
export function cleanImportedContent(s: string): string {
  let t = String(s ?? '')
  t = t.replace(/\r\n?/g, '\n')
  t = t.replace(/\{\{[^{}]{1,160}\}\}/g, '')
  t = t.replace(/<!--[\s\S]*?-->/g, '')
  // 尖括号标签（含闭合）：<faction_武魂殿>、<rule_经济系统>、<worldview_detail_xxx> 等 ST 锚点
  t = t.replace(/<\/?[a-zA-Z][^>]{0,80}>/g, '')
  // markdown：行首标题标记 / 列表标记（后跟空格，允许缩进）→ 去掉标记保留正文
  t = t.replace(/^[ \t]*#{1,6}\s+/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  // markdown：加粗/下划线/斜体/行内代码 → 原文
  t = t.replace(/\*\*([^*\n]{1,200})\*\*/g, '$1')
  t = t.replace(/__([^_\n]{1,200})__/g, '$1')
  t = t.replace(/\*([^*\n]{1,200})\*/g, '$1')
  t = t.replace(/`{1,3}([^`\n]{1,200})`{1,3}/g, '$1')
  // 英文音译括号注释：(Tang San) / (Xiao Wu) 等
  t = t.replace(/\([A-Za-z][A-Za-z0-9 .\-_]{0,40}\)/g, '')
  // 独立行的 --- 分隔线删除；保留正文缩进（设定文本层级依赖缩进）
  t = t.split('\n').map((l) => (/^\s*-{3,}\s*$/.test(l) ? '' : l)).join('\n')
  t = t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/**
 * v3.5：导入人物卡时从 comment/key 提取显名，生成 payload（否则卡名靠 hook 顶替、
 * 结构化字段全空）。取不到名返回 undefined（该卡由用户后续手动补）。
 */
export function guessCharacterName(e: any, key: string, hook?: string): string | undefined {
  if (hook?.trim()) return hook.trim()
  if (key) {
    const first = key.split(/[,，]/).map((k) => k.trim()).filter(Boolean)[0]
    if (first) return first
  }
  // 兜底：comment 里最后一个冒号后是显名（与 hook 提取同规则）；否则去 emoji/冒号前缀取首段
  const c = String(e?.comment ?? '').trim()
  const m = c.match(/[：:]\s*(.+?)$/)
  if (m?.[1]?.trim()) return m[1].trim()
  const c2 = c.replace(/^[\p{Emoji}\s·:：]+/u, '').trim()
  const m2 = c2.match(/^([^：:]{1,20})/)
  if (m2?.[1]?.trim()) return m2[1].trim()
  return undefined
}

/**
 * 引用稳定化合并：以旧数组中的对象为基底，把新数据字段合并进去。
 * 新 id 追加、消失的 id 剔除（对 trash/campaigns 按删除语义处理）。
 * 保留引用 → 外部持有的旧引用始终与 store 同步。
 */
function mergeById<T extends { id?: number }>(oldArr: T[], newArr: T[]): T[] {
  if (!newArr.length) return []
  const oldMap = new Map<number, T>()
  for (const o of oldArr) if (o.id != null) oldMap.set(o.id, o)
  const merged: T[] = []
  const seen = new Set<number>()
  for (const n of newArr) {
    if (n.id == null) { merged.push(n); continue }
    seen.add(n.id)
    const o = oldMap.get(n.id)
    if (o && typeof o === 'object' && typeof n === 'object') {
      Object.assign(o, n)
      merged.push(o)
    } else {
      merged.push(n)
    }
  }
  return merged
}

export const useDataStore = defineStore('data', {
  state: () => ({
    apiConfigs: [] as ApiConfig[],
    presets: [] as Preset[],
    worldbooks: [] as Worldbook[],
    entries: [] as Entry[],
    campaigns: [] as Campaign[],
    /** v2.0：回收站（最新在前，最多 20 条） */
    trashed: [] as TrashItem[],
    loaded: false,
  }),
  actions: {
    /**
     * 引用稳定化加载：新数据「合并回既有对象」而非整体替换数组。
     * 背景：旧实现每次 loadAll 都换新对象引用，任何持有旧引用的异步流程
     * （syncFrom/compactContext 等的 campaign 变量）在末尾 saveCampaign 时
     * 会把其它流程刚写入库的新字段覆盖回旧值——表现为「属性/状态卡数据莫名其妙丢失」。
     * 稳定引用后，旧引用与 store 共享同一对象，字段永远同步。
     */
    async loadAll() {
      const [apiConfigs, presets, worldbooks, entries, campaigns, trashed] = await Promise.all([
        db.apiConfigs.toArray(),
        db.presets.toArray(),
        db.worldbooks.toArray(),
        db.entries.toArray(),
        db.campaigns.toArray(),
        db.trash.orderBy('deletedAt').reverse().limit(20).toArray(),
      ])
      this.apiConfigs = mergeById(this.apiConfigs, apiConfigs)
      this.presets = mergeById(this.presets, presets)
      this.worldbooks = mergeById(this.worldbooks, worldbooks)
      this.entries = mergeById(this.entries, entries)
      this.campaigns = mergeById(this.campaigns, campaigns)
      this.trashed = mergeById(this.trashed, trashed)
      this.loaded = true
    },

    /** 首次启动：种入内置节点（DeepSeek 官方 + opencode-go） */
    async init() {
      await seedBuiltinNodes()
      await this.loadAll()
    },

    /** 新存档默认配置：内置梦鲸思客·精简 + 1M 上下文预算 */
    defaultCampaign(partial: Partial<Campaign> = {}): Campaign {
      return {
        name: '新梦境',
        dreamConfigJson: JSON.stringify(defaultDreamConfig()),
        varsJson: '{}',
        autoInterval: 5,
        ctxBudget: 1000000,
        summarizedSeq: 0,
        summary: '',
        statTokens: 0,
        statCostYuan: 0,
        gameStarted: 0,
        lastSyncedTalkSeq: 0,
        lastSyncedGameSeq: 0,
        charInject: 1,
        lastStream: 'talk',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastActive: Date.now(),
        ...partial,
      }
    },

    // ---- API 配置 ----
    async saveApiConfig(cfg: ApiConfig) {
      if (cfg.isDefault) {
        await db.apiConfigs.toCollection().modify((c) => { c.isDefault = 0 })
      }
      const id = await db.apiConfigs.put(plain(cfg))
      await this.loadAll()
      return id
    },
    async deleteApiConfig(id: number) {
      await db.apiConfigs.delete(id)
      await this.loadAll()
    },
    getDefaultApi(): ApiConfig | undefined {
      return this.apiConfigs.find((c) => c.isDefault) ?? this.apiConfigs[0]
    },

    // ---- 预设 ----
    async importPresetFromFile(file: File): Promise<ImportedPreset> {
      const text = await file.text()
      const imported = parseStPresetJson(text, file.name)
      const preset: Preset = {
        name: imported.name,
        sourceName: imported.sourceName,
        promptsJson: JSON.stringify(imported.prompts),
        paramsJson: JSON.stringify(imported.params),
        createdAt: Date.now(),
      }
      await db.presets.add(preset)
      await this.loadAll()
      return imported
    },
    async deletePreset(id: number) {
      await db.presets.delete(id)
      await this.loadAll()
    },

    // ---- 世界书 ----
    async saveWorldbook(wb: Worldbook) {
      wb.updatedAt = Date.now()
      await db.worldbooks.put(plain(wb))
      await this.loadAll()
    },
    async deleteWorldbook(id: number) {
      await db.worldbooks.delete(id)
      await db.entries.where('worldbookId').equals(id).delete()
      await this.loadAll()
    },
    async saveEntry(entry: Entry) {
      if (entry.createdAt) entry.updatedAt = Date.now()
      await db.entries.put(plain(entry))
      await this.loadAll()
    },
    async deleteEntry(id: number) {
      // v2.0：删除前备份到回收站（撤销恢复兜底）
      const e = await db.entries.get(id)
      if (e) {
        await db.trash.add(plain({
          campaignId: 0,
          kind: 'entry' as const,
          refId: e.id!,
          payload: JSON.stringify(e),
          title: `${(e.key || '常驻').split(/[,，]/)[0]} · ${(e.content ?? '').slice(0, 32)}`,
          deletedAt: Date.now(),
        }))
      }
      await db.entries.delete(id)
      await this.loadAll()
    },
    /** v2.0：还原回收站条目（按 trash id） */
    async restoreTrash(id: number): Promise<boolean> {
      const t = await db.trash.get(id)
      if (!t) return false
      try {
        const e = JSON.parse(t.payload) as Entry
        const exists = await db.entries.get(t.refId)
        if (!exists) await db.entries.put(e)
      } catch { /* 坏数据忽略 */ }
      await db.trash.delete(id)
      await this.loadAll()
      return true
    },
    /** 最近的回收站条目（世界书条目类） */
    recentTrash(limit = 5): TrashItem[] {
      return this.trashed.slice(0, limit)
    },

    // ---- 存档 ----
    async saveCampaign(c: Campaign) {
      const id = await db.campaigns.put(plain(c))
      await this.loadAll()
      return id
    },
    async deleteCampaign(id: number) {
      await db.campaigns.delete(id)
      await db.messages.where('campaignId').equals(id).delete()
      await db.characters.where('campaignId').equals(id).delete()
      await db.relations.where('campaignId').equals(id).delete()
      await db.campaignBindings.where('campaignId').equals(id).delete()
      await this.loadAll()
    },
    entriesOf(worldbookId: number): Entry[] {
      return this.entries.filter((e) => e.worldbookId === worldbookId)
    },

    /**
     * 导入世界书 JSON（本 App 规范 或 SillyTavern 风格）。
     * 返回导入统计。campaignId 可选：带角色/关系时写入该存档。
     * targetWbId 可选：v3.4 导入到指定世界书（如存档自动笔记簿）——
     *   给定时不新建世界书，条目直接写入该本（进入卡体系）；缺省新建（现状）。
     */
    async importWorldbookJson(text: string, wbNameHint?: string, campaignId?: number, targetWbId?: number) {
      const data = JSON.parse(text)
      const wbMeta = data.worldbook ?? {}
      const name = String(wbMeta.name ?? wbNameHint ?? '导入的世界书').trim() || '导入的世界书'

      // 创世界书（仅 targetWbId 未给定时）
      let wbId = targetWbId ?? 0
      if (!wbId) {
        const wb: Worldbook = {
          name,
          description: wbMeta.description ?? '',
          scope: 'global',
          createdAt: Date.now(), updatedAt: Date.now(),
        }
        wbId = await db.worldbooks.add(wb)
      }

      // entries：支持 keys 数组（ST）/ key 字符串（本规范）/ 对象形式（{"0":{...}} 斗罗式）
      // v3.2：按 ST comment 的 emoji 前缀粗分类 kind；导入条目 source=imported
      let entryCount = 0
      const rawEntries = Array.isArray(data.entries)
        ? data.entries
        : (data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : [])
      for (const e of rawEntries) {
        if (!e || !e.content) continue
        let key = ''
        if (Array.isArray(e.keys) && e.keys.length) key = e.keys.map(String).join(',')
        else if (Array.isArray(e.entry_keys) && e.entry_keys.length) key = e.entry_keys.map(String).join(',')
        else if (e.key) key = Array.isArray(e.key) ? e.key.map(String).join(',') : String(e.key)
        // ST：constant=true → 常驻（key 置空）
        if (e.constant === true || e.constant === 'true') key = ''
        // v3.5：kind 支持规范显式声明（v2），缺省按 comment 粗分类
        const KIND_SET = new Set(['character', 'location', 'item', 'event', 'rule', 'faction', 'timeline', 'note'])
        const kind = (KIND_SET.has(String(e.kind ?? '')) ? String(e.kind) : guessKindFromComment(e.comment)) as NonNullable<Entry['kind']>
        // v3.5：hook/timeline/isMain 支持规范显式字段；缺省从 comment 提取
        const hook = (typeof e.hook === 'string' && e.hook.trim())
          ? e.hook.trim()
          : guessHookFromEntry(e, kind)
        const timeline = e.timeline ? String(e.timeline).trim() || undefined : undefined
        const isMain = (e.isMain === 1 || e.isMain === true) ? 1 : 0
        // v3.5：人物卡 key 为空 → 补人物名做触发词（避免常驻全量注入）
        const charName = kind === 'character' ? guessCharacterName(e, key, hook) : undefined
        if (kind === 'character' && !key && charName) key = charName
        // v3.5：payload 支持规范显式给定（v2）；人物卡缺 name 时自动补（保证卡面可显示）
        let payloadJson: string | undefined
        if (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)) {
          payloadJson = JSON.stringify(e.payload)
        }
        if (kind === 'character') {
          const p = parseCharacterPayload(payloadJson)
          if (!p.name?.trim()) {
            const nm = charName ?? (key ? key.split(/[,，]/)[0].trim() : '')
            if (nm && nm !== '未命名') {
              p.name = nm
              payloadJson = characterPayloadJson(p)
            }
          }
        }
        await db.entries.add(plain({
          worldbookId: wbId,
          kind,
          // v3.2：抖罗锚点条目的 hook 从 comment 提取（「👤斗三：唐舞桐」→ 人物名）
          hook,
          key,
          payloadJson,
          timeline,
          isMain: kind === 'character' ? isMain : undefined,
          // v3.5：ST 原文清洗（宏/标签/分隔线），避免卡片 UI 显示违和的英文结构
          content: cleanImportedContent(String(e.content)),
          enabled: e.enabled === false ? 0 : 1,
          source: 'imported',
          createdAt: Date.now(), updatedAt: Date.now(),
        }))
        entryCount++
      }

      // characters / relations（可选）
      // v3.5：characters 老格式 → kind=character 人物卡条目（进卡体系；绑定/入笔记簿即见）
      let charCount = 0, relCount = 0
      if (Array.isArray(data.characters)) {
        for (const c of data.characters) {
          if (!c?.name) continue
          const nm = String(c.name).trim()
          const p = parseCharacterPayload('')
          p.name = nm
          p.identity = c.identity ? String(c.identity).trim() || undefined : undefined
          p.realm = c.realm ? String(c.realm).trim() || undefined : undefined
          if (Array.isArray(c.attributes)) {
            p.attributes = c.attributes
              .filter((a: any) => a?.label?.trim() && typeof a.value === 'number')
              .map((a: any) => ({ label: String(a.label).trim(), value: Math.max(0, Math.min(100, Math.round(a.value))) }))
          }
          await db.entries.add(plain({
            worldbookId: wbId,
            kind: 'character',
            hook: p.identity ? `${nm}：${p.identity}` : nm,
            key: nm,
            payloadJson: characterPayloadJson(p),
            content: cleanImportedContent(String(c.description ?? '')),
            enabled: 1,
            source: 'imported',
            createdAt: Date.now(), updatedAt: Date.now(),
          }))
          charCount++
        }
      }
      if (campaignId && Array.isArray(data.relations)) {
        for (const r of data.relations) {
          if (!r?.from || !r?.to || !r?.relType) continue
          await db.relations.add(plain({
            campaignId,
            fromChar: String(r.from),
            toChar: String(r.to),
            relType: String(r.relType),
            label: r.label ? String(r.label) : '',
            createdAt: Date.now(),
          }))
          relCount++
        }
      }

      await this.loadAll()
      // v3.2：返回 kind 分布（导入预览/提示用）
      const kindDist = new Map<string, number>()
      for (const e of this.entries.filter((x) => x.worldbookId === wbId)) {
        const k = e.kind ?? 'note'
        kindDist.set(k, (kindDist.get(k) ?? 0) + 1)
      }
      return { wbId, entryCount, charCount, relCount, kindDist: Object.fromEntries(kindDist) }
    },
  },
})
