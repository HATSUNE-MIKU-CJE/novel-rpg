import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { db } from '../db'
import type { Message, Campaign, ApiConfig, Entry, StreamKind, StatusCardDef } from '../types'
import { useDataStore } from './data'
import { renderPromptChain, chatCompletion, chatCompletionStream, type ChatUserMessage } from '../engine/pipeline'
import { parseDreamPlot } from '../engine/dreamParser'
import { buildDreamPromptBlocks, defaultDreamConfig, TALK_SYSTEM, type DreamConfig } from '../engine/dreamPreset'
import { parseUsage, estimateCostYuan } from '../engine/pricing'
import {
  extractFacts, extractJson, mergeAttrs, applyRenames, normCategory,
  collectCategoryCandidates,
  parseAttrSchema, attrSchemaJson, type AttrSchema,
} from '../engine/extractor'
import {
  parseCharacterPayload, characterPayloadJson, characterRowToEntry,
  entryToCharacterShape, computeInjectionLayers, renderInjectionText,
  type InjectionLayer,
} from '../engine/cards-v3'
import { parseOps, opGroup, resolveRefs, parseBars, type OpBlock } from '../engine/ops'
import { dedupStatus } from '../engine/dedup'
import { parseBarSchema, barSchemaJson, readBarValues, writeBarValues, type BarSchema, type BarDef } from '../engine/bars'
import { parseStatusCard, statusCardJson, readStatusValues, writeStatusValues, parseSnap, statusCardProtocol } from '../engine/cards'
import { httpFetch } from '../engine/http'
import type { WorldOverview, Entry as EntryType } from '../types'

/** 剥离 Vue 响应式代理，得到 IndexedDB 可序列化的纯对象 */
function plainMsg<T>(obj: T): T {
  return JSON.parse(JSON.stringify(toRaw(obj)))
}

/** 消息正文（assistant 取解析后的 body） */
export function bodyOfMsg(m: Message): string {
  if (m.role === 'user') return m.content
  try {
    const p = m.parsedJson ? JSON.parse(m.parsedJson) : null
    return p?.body || m.content
  } catch { return m.content }
}

/** 上下文压缩：预算内 80% 触发 */
export const COMPACT_RATIO = 0.8

export interface SyncOutcome {
  chars: number
  rels: number
  facts: number
  /** v2.0：同 key 已有条目 → 生成的「更新」操作数（进审计待确认） */
  upd?: number
  skipped: boolean   // 素材过短未提炼
}

export interface StartGamePack {
  worldview: string
  opening: string
}

export interface SummaryPack {
  title: string
  events: Array<{ time?: string; place?: string; desc: string }>
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    talkMessages: [] as Message[],       // 交流栏（设计商谈）
    gameMessages: [] as Message[],       // 游戏栏（跑团剧情）
    currentStream: 'talk' as StreamKind,
    currentCampaignId: 0,
    sending: false,
    /** v2.1：流式输出的实时增量文本（UI 即时渲染用，完成后清零） */
    liveText: '',
    /** v2.1：流式思维链增量 */
    liveReasoning: '',
    compacting: false,
    organizing: false,
    /** 上一轮交流 AI 提交的操作数（UI 提示用） */
    lastOpCount: 0,
    /** v2.0：操作审计版本号（确认/退回/批量后递增，UI 据此刷新待确认列表） */
    opsVersion: 0,
    error: '' as string,
  }),
  getters: {
    /** 当前流的消息（UI 渲染用） */
    messages(state): Message[] {
      return state.currentStream === 'talk' ? state.talkMessages : state.gameMessages
    },
    currentCampaign(state): Campaign | undefined {
      const ds = useDataStore()
      return ds.campaigns.find((c) => c.id === state.currentCampaignId)
    },
    /** 是否已开始游戏（游戏流可玩）；旧档缺字段视为已开始 */
    inGame(): boolean {
      const c = this.currentCampaign
      return (c?.gameStarted ?? 1) !== 0
    },
    /** 存档累计 token（两流合计） */
    totalTokens(state): number {
      let n = 0
      for (const list of [state.talkMessages, state.gameMessages]) {
        for (const m of list) {
          try {
            const u = m.usageJson ? JSON.parse(m.usageJson) : null
            if (u?.totalTokens) n += u.totalTokens
          } catch { /* ignore */ }
        }
      }
      return n
    },
    /** 存档累计金额（仅 DeepSeek 折算） */
    totalCost(state): number {
      let c = 0
      for (const list of [state.talkMessages, state.gameMessages]) {
        for (const m of list) {
          try {
            const u = m.usageJson ? JSON.parse(m.usageJson) : null
            if (u?.costYuan) c += u.costYuan
          } catch { /* ignore */ }
        }
      }
      return Math.round(c * 10000) / 10000
    },
    /**
     * 当前流上下文压力（0..1+）估算——实现见 actions.ctxPressure。
     * （getters 不支持参数，作为 action 提供，纯计算无副作用）
     */
  },
  actions: {
    async openCampaign(id: number) {
      this.currentCampaignId = id
      const all = await db.messages.where('campaignId').equals(id).sortBy('seq')
      this.talkMessages = all.filter((m) => (m.stream ?? 'game') === 'talk')
      this.gameMessages = all.filter((m) => (m.stream ?? 'game') !== 'talk')
      const c = this.currentCampaign
      // v1.2 迁移：旧档（无 gameStarted）一律视为已开始（旧消息归游戏流）
      if (c && c.gameStarted === undefined) {
        c.gameStarted = 1
        await useDataStore().saveCampaign(c)
      }
      // v3.1：老 characters 表 → kind=character 人物卡条目（幂等：已有同名条目跳过）
      try { await this.migrateLegacyCharacters() } catch { /* 迁移失败不阻塞打开 */ }
      // 未开始游戏 → 先进交流栏；已开始 → 记住上次停留的流
      const started = (c?.gameStarted ?? 1) !== 0
      this.currentStream = !started ? 'talk' : ((c?.lastStream as StreamKind) ?? 'game')
    },

    /** 切换交流/游戏栏 */
    async switchStream(s: StreamKind) {
      this.currentStream = s
      const c = this.currentCampaign
      if (c) {
        c.lastStream = s
        await useDataStore().saveCampaign(c)
      }
    },

    /** 计算本轮命中的触发条目（触发词出现在游戏流最近 N 条消息中） */
    collectInjectedEntries(worldbookIds: number[]): { constant: Entry[]; keyed: Entry[] } {
      const ds = useDataStore()
      const constant: Entry[] = []
      const keyed: Entry[] = []
      const recentText = this.gameMessages
        .slice(-8)
        .map((m) => m.content)
        .join('\n')

      for (const wbId of worldbookIds) {
        for (const e of ds.entriesOf(wbId)) {
          if (!e.enabled || !e.content.trim()) continue
          // 注入策略：AI 条目仅 accepted 进入上下文（pending 待审阅不注入）
          if (e.source === 'ai' && e.status !== 'accepted') continue
          if (!e.key.trim()) { constant.push(e); continue }
          if (recentText && e.key) {
            const keys = e.key.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
            if (keys.some((k) => recentText.includes(k))) keyed.push(e)
          }
        }
      }
      return { constant, keyed }
    },

    /** 角色卡文本（charInject 开关：>0 时作为常驻注入游戏对话） */
    async charCardsText(): Promise<string> {
      const c = this.currentCampaign
      if (!c?.id) return ''
      // v3.1：优先读世界书 kind=character 条目（唯一事实源）；老 characters 表只读兜底
      const entries = this.characterEntries()
      if (entries.length) {
        const lines = entries
          .filter((e) => e.enabled && (e.source !== 'ai' || e.status === 'accepted'))
          .map((e) => {
            const p = parseCharacterPayload(e.payloadJson)
            const hook = e.hook?.trim() ? `（${e.hook.trim()}）` : ''
            return `【人物卡 · ${p.name || e.key}】${p.identity ? p.identity + '。' : ''}${(e.content || '').trim()}${hook}`
          })
        return lines.join('\n')
      }
      const chars = await db.characters.where('campaignId').equals(c.id).toArray()
      const lines = chars.map((ch) =>
        `【角色卡 · ${ch.name}】${ch.identity ? ch.identity + '。' : ''}${ch.description ?? ''}`.trim()
      )
      return lines.join('\n')
    },

    // ---- v3.1：人物卡（世界书 kind=character 单源） ----

    /** 当前存档的人物卡条目（kind=character，含未启用，UI 用） */
    characterEntries(): Entry[] {
      const c = this.currentCampaign
      const ds = useDataStore()
      if (!c?.notebookWorldbookId) return []
      return ds.entriesOf(c.notebookWorldbookId).filter((e) => e.kind === 'character')
    },

    /** 当前主角人物卡条目（isMain=1；无则取第一张启用卡） */
    mainCharacterEntry(): Entry | undefined {
      const all = this.characterEntries()
      return all.find((e) => e.isMain === 1) ?? all.find((e) => e.enabled)
    },

    /** 保存人物卡（条目 upsert；payload/hook/详情/时期） */
    async saveCharacterEntry(e: Entry) {
      if (!e.id) {
        await db.entries.add(plainMsg(e))
      } else {
        await db.entries.put(plainMsg(e))
      }
      await useDataStore().loadAll()
    },

    /** 手改快捷：改人物卡某个字段（payload 内身分/属性/行为/状态条） */
    async patchCharacterEntry(entryId: number, patch: {
      name?: string; identity?: string; realm?: string; behavior?: string
      attributes?: Array<{ label: string; value: number }>
      barValues?: Record<string, number>
      hook?: string; content?: string; timeline?: string; isMain?: number
    }) {
      const e = await db.entries.get(entryId)
      if (!e) return false
      const p = parseCharacterPayload(e.payloadJson)
      if (patch.name !== undefined) p.name = patch.name.trim()
      if (patch.identity !== undefined) p.identity = patch.identity.trim() || undefined
      if (patch.realm !== undefined) p.realm = patch.realm.trim() || undefined
      if (patch.behavior !== undefined) p.behavior = patch.behavior.trim() || undefined
      if (patch.attributes !== undefined) p.attributes = patch.attributes
      if (patch.barValues !== undefined) p.barValues = patch.barValues
      e.payloadJson = characterPayloadJson(p)
      if (patch.hook !== undefined) e.hook = patch.hook.trim() || undefined
      if (patch.content !== undefined) e.content = patch.content
      if (patch.timeline !== undefined) e.timeline = patch.timeline.trim() || undefined
      if (patch.isMain !== undefined) e.isMain = patch.isMain
      e.updatedAt = Date.now()
      await db.entries.put(plainMsg(e))
      await useDataStore().loadAll()
      return true
    },

    /** 迁移：把老 characters 表行转成 kind=character 条目（升级/合并用） */
    async migrateLegacyCharacters(): Promise<number> {
      const c = this.currentCampaign
      if (!c?.id) return 0
      // v3.1.1：旧档可能从未 syncFrom → 无 notebookWorldbookId，先确保笔记簿存在再迁
      const wb = await this.ensureNotebook()
      const notebookId = wb.id!
      const legacy = await db.characters.where('campaignId').equals(c.id!).toArray()
      const entries = this.characterEntries()
      let n = 0
      for (const row of legacy) {
        // 已存在同名人物卡（新模型已经接管）→ 跳过
        if (entries.some((e) => e.key.includes(row.name) || parseCharacterPayload(e.payloadJson).name === row.name)) continue
        const e = characterRowToEntry(row, notebookId)
        e.isMain = 0 // 统一 0；主角标记在迁移完成后补齐
        await db.entries.add(plainMsg(e))
        n++
      }
      if (n) {
        await useDataStore().loadAll()
        // 主角：若迁移前没有 isMain 角色卡，取最早创建的启用卡设为主角
        const after = this.characterEntries()
        if (!after.some((e) => e.isMain === 1) && after.length) {
          const first = [...after].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0]
          if (first.id) {
            first.isMain = 1
            await db.entries.put(plainMsg(first))
            await useDataStore().loadAll()
          }
        }
      }
      return n
    },


    /** 解析存档的 DreamConfig；非内置预设/无配置时返回 null */
    dreamConfig(): DreamConfig | null {
      const c = this.currentCampaign
      if (!c?.dreamConfigJson) return null
      try {
        const cfg = JSON.parse(c.dreamConfigJson) as DreamConfig
        // v2.1 迁移：补齐缺失的组与 custom
        const def = defaultDreamConfig()
        for (const k of Object.keys(def)) {
          if (cfg[k] === undefined) cfg[k] = def[k]
        }
        if (!cfg.custom) cfg.custom = {}
        return cfg
      } catch { return null }
    },

    /** v1.3：存档属性体系（无配置 → 默认通用六维） */
    attrSchema(): AttrSchema {
      return parseAttrSchema(this.currentCampaign?.attrSchemaJson)
    },

    /** v1.8：状态条配置（存档级） */
    barSchema(): BarSchema {
      return parseBarSchema(this.currentCampaign?.barSchemaJson)
    },
    async saveBarSchema(s: BarSchema) {
      const c = this.currentCampaign
      if (!c) return
      c.barSchemaJson = barSchemaJson(s)
      await useDataStore().saveCampaign(c)
    },
    /** 启用的条定义 */
    barDefs(): BarDef[] {
      return this.barSchema().bars.filter((b) => b.enabled)
    },
    /** v2.2：状态卡配置（存档级） */
    statusCard(): StatusCardDef {
      return parseStatusCard(this.currentCampaign?.statusCardJson)
    },
    async saveStatusCard(def: StatusCardDef) {
      const c = this.currentCampaign
      if (!c) return
      c.statusCardJson = statusCardJson(def)
      await useDataStore().saveCampaign(c)
    },

    /** v1.3：保存属性体系 */
    async saveAttrSchema(s: AttrSchema) {
      const c = this.currentCampaign
      if (!c) return
      c.attrSchemaJson = attrSchemaJson(s)
      await useDataStore().saveCampaign(c)
    },

    /** v3.1：当前时期（空 = 不启用时期封存） */
    currentTimeline(): string {
      return this.currentCampaign?.currentTimeline?.trim() ?? ''
    },
    /** v3.1：P1 常驻 hook 预算（条数） */
    p1Budget(): number {
      const n = this.currentCampaign?.injectP1Budget ?? 8
      return Math.max(0, Math.min(30, Math.round(n)))
    },

    /** v1.4：AI 梳理世界观总览（对世界书条目归纳，不抄原文） */
    async buildWorldOverview(): Promise<WorldOverview | null> {
      const c = this.currentCampaign
      if (!c?.id) return null
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) { this.error = '梳理需要 API 配置'; return null }

      const bindings = await db.campaignBindings.where('campaignId').equals(c.id).toArray()
      const wbIds = bindings.map((b) => b.worldbookId)
      if (c.notebookWorldbookId) wbIds.push(c.notebookWorldbookId)
      const lines: string[] = []
      for (const wid of wbIds) {
        for (const e of ds.entriesOf(wid)) {
          if (!e.enabled || !e.content.trim()) continue
          if (e.source === 'ai' && e.status !== 'accepted') continue
          lines.push(`【${e.category || '其他'}】${e.key || '常驻'}：${e.content}`)
        }
      }
      if (!lines.length) { this.error = '还没有已确认的世界观内容'; return null }

      this.organizing = true
      try {
        const reply = await chatCompletion(api, [
          {
            role: 'system',
            content: '你是世界观梳理师。把玩家梦境世界的设定条目整理成一份「世界观总览」。输出严格 JSON（无其他文字、无代码块）：{"summary":"一段话总览（2-3句，概括这个世界的核心面貌）","blocks":[{"category":"类别","content":"本类别的归纳描述（2-3句，像设定介绍，提炼而非抄录）","related":["相关条目触发词，最多5个"]}]}。blocks 覆盖全部类别且不重复。',
          },
          { role: 'user', content: `以下是世界书条目（【类别】触发词：内容）：\n\n${lines.join('\n').slice(0, 20000)}` },
        ])
        const parsed = extractJson<Omit<WorldOverview, 'at'>>(reply)
        if (!parsed?.summary || !Array.isArray(parsed.blocks)) return null
        const overview: WorldOverview = {
          summary: parsed.summary,
          blocks: parsed.blocks.filter((b) => b?.category?.trim() && b?.content?.trim()).slice(0, 12),
          at: Date.now(),
        }
        c.worldOverviewJson = JSON.stringify(overview)
        await ds.saveCampaign(c)
        return overview
      } catch (e: any) {
        this.error = `梳理失败：${e?.message || e}`
        return null
      } finally {
        this.organizing = false
      }
    },

    // ---- v3.1 大整理：剧情态势简报（只进交流栏，全知五要素） ----

    /** 解析存档的剧情态势简报 */
    storyBrief(): StoryBrief | null {
      const c = this.currentCampaign
      if (!c?.storyBriefJson) return null
      try {
        const b = JSON.parse(c.storyBriefJson)
        return b && typeof b === 'object' ? b as StoryBrief : null
      } catch { return null }
    },

    /**
     * 生成/更新剧情态势简报（滚动式：上次简报 + 最近新增剧情 → 新版，300-500 字内）。
     * 全知视角：位置/目标/最近大事/未决悬念/焦点角色 五要素。
     */
    async refreshStoryBrief(): Promise<StoryBrief | null> {
      const c = this.currentCampaign
      if (!c?.id) return null
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) { this.error = '大整理需要 API 配置'; return null }

      // 素材：上次简报（滚动基线，可不完整）+ 最近剧情（自上次游标起）
      const prev = this.storyBrief()
      const fromSeq = c.lastBriefGameSeq ?? 0
      const recent = this.gameMessages.filter((m) => (m.seq ?? 0) > fromSeq && m.role !== 'system')
      const recentText = recent
        .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${bodyOfMsg(m)}`))
        .join('\n\n')
        .slice(-24000)
      if (!recentText.trim() && !prev) { this.error = '还没有剧情可整理'; return null }

      this.organizing = true
      try {
        const prevText = prev
          ? `上次简报（${new Date(prev.at).toLocaleString()}）：\n位置：${prev.position ?? '未知'}\n目标：${prev.goal ?? '未知'}\n最近大事：${(prev.events ?? []).join('；') || '无'}\n未决悬念：${(prev.mysteries ?? []).join('；') || '无'}\n焦点角色：${(prev.focus ?? []).map((f) => `${f.name}（${f.note}）`).join('、') || '无'}`
          : '（暂无上次简报）'
        const reply = await chatCompletion(api, [
          {
            role: 'system',
            content: '你是梦境剧情的「态势简报员」。基于旧简报与最新剧情，输出当前剧情态势简报。输出严格 JSON（无其他文字、无代码块）：{"timeline":"当前时期","position":"玩家位置","goal":"当前目标（1-2句）","events":["最近大事（3-6条，每条≤20字）"],"mysteries":["未决悬念（2-4条，已解决的不再列出，解决了的作为已揭示事实可不提）"],"focus":[{"name":"角色名","note":"一句话备注"}]}。要求：滚动更新（保留仍然有效的旧信息，合并新增），总字数控制在 400 字内；events 按时间正序；已解决的悬念从 mysteries 移除。',
          },
          { role: 'user', content: `${prevText}\n\n=== 最新剧情（自上次简报后） ===\n\n${recentText}` },
        ])
        const parsed = extractJson<StoryBrief>(reply)
        if (!parsed) return null
        const brief: StoryBrief = {
          timeline: parsed.timeline?.trim(),
          position: parsed.position?.trim(),
          goal: parsed.goal?.trim(),
          events: Array.isArray(parsed.events) ? parsed.events.map((s) => String(s).slice(0, 40)).slice(0, 6) : [],
          mysteries: Array.isArray(parsed.mysteries) ? parsed.mysteries.map((s) => String(s)).slice(0, 4) : [],
          focus: Array.isArray(parsed.focus) ? parsed.focus.filter((f) => f?.name?.trim()).slice(0, 5).map((f) => ({ name: String(f.name).trim(), note: String(f.note ?? '').slice(0, 30) })) : [],
          at: Date.now(),
        }
        c.storyBriefJson = JSON.stringify(brief)
        c.lastBriefGameSeq = this.gameMessages[this.gameMessages.length - 1]?.seq ?? fromSeq
        await ds.saveCampaign(c)
        return brief
      } catch (e: any) {
        this.error = `大整理失败：${e?.message || e}`
        return null
      } finally {
        this.organizing = false
      }
    },

    /** 交流栏注入简报文本（无则空串） */
    storyBriefText(): string {
      const b = this.storyBrief()
      if (!b) return ''
      const lines = [
        b.timeline ? `当前时期：${b.timeline}` : '',
        b.position ? `玩家位置：${b.position}` : '',
        b.goal ? `当前目标：${b.goal}` : '',
        (b.events?.length ?? 0) ? `最近大事：${b.events!.map((e, i) => `${i + 1}. ${e}`).join(' ')}` : '',
        (b.mysteries?.length ?? 0) ? `未决悬念：${b.mysteries!.join('；')}` : '',
        (b.focus?.length ?? 0) ? `焦点角色：${b.focus!.map((f) => `${f.name}（${f.note}）`).join('、')}` : '',
      ].filter(Boolean)
      return lines.length ? lines.join('\n') : ''
    },

    /**
     * v1.3：AI 建议属性体系 —— 读交流栏内容 + 当前体系，输出建议维度。
     */
    async suggestAttrSchema(): Promise<AttrSchema | null> {
      const c = this.currentCampaign
      if (!c) return null
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) { this.error = '建议需要 API 配置'; return null }
      const cur = this.attrSchema()
      const talkText = this.talkMessages
        .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${m.content}`))
        .join('\n\n')
        .slice(-40000)
      if (!talkText.trim()) { this.error = '交流栏还没有内容，先和主持聊聊题材吧'; return null }
      try {
        const reply = await chatCompletion(api, [
          {
            role: 'system',
            content: `你是梦境游戏的属性体系设计师。根据玩家与主持的设定讨论，设计一套角色属性维度。
输出严格 JSON（不要其他文字、不要代码块）：{"dims":[{"label":"维度名"}...],"realmLabel":"境界标签名"}
要求：4~8 个维度；维度名 2-4 个字、互相不重叠；契合讨论中的题材（修仙/奇幻/现代等）；realmLabel 为境界/段位类标签名，题材不需要就留空字符串。`,
          },
          {
            role: 'user',
            content: `当前属性体系：${cur.dims.map((d) => d.label).join('、')}（境界标签：${cur.realmLabel ?? '无'}）\n\n玩家与主持的讨论：\n\n${talkText}`,
          },
        ])
        const parsed = extractJson<AttrSchema>(reply)
        if (!parsed || !Array.isArray(parsed.dims) || !parsed.dims.length) return null
        return { dims: parsed.dims.filter((d) => d?.label?.trim()).slice(0, 10), realmLabel: parsed.realmLabel ?? '' }
      } catch (e: any) {
        this.error = `建议生成失败：${e?.message || e}`
        return null
      }
    },

    /** 交流栏 system：主持人格 + 已生效设定参考（世界书带编号 + 角色卡） */
    async buildTalkSystem(): Promise<string> {
      const ds = useDataStore()
      const c = this.currentCampaign
      const parts = [TALK_SYSTEM]
      if (c?.id) {
        const entries = await activeTalkEntries(c)
        // v2.2.1：类别候选动态化——主持人格的 [[WB]] 操作类别枚举跟着存档走
        const usedCats = ds.entries
          .map((e) => e.category)
          .filter((x): x is string => !!x && x !== '其他')
        const catLine = collectCategoryCandidates(usedCats).join('、')
        parts[0] = TALK_SYSTEM.replace(
          'category 从「修炼体系/经济系统/地理环境/种族文化/组织势力/物品神器/其他」选',
          `category 从「${catLine}」选`,
        )
        const lines = entries.map((e, i) => `【${i + 1}】${e.category || '其他'}·${e.key || '常驻'}：${e.content}`)
        const chars = await db.characters.where('campaignId').equals(c.id!).toArray()
        const charText = chars.map((ch) => `【角色卡 · ${ch.name}】${ch.identity ? ch.identity + '。' : ''}${ch.description ?? ''}`.trim()).join('\n')
        if (charText) lines.push(charText)
        const schema = this.attrSchema()
        lines.push(`【当前属性体系】${schema.dims.map((d) => d.label).join('、')}${schema.realmLabel ? `（${schema.realmLabel}）` : ''}（上限 ${schema.maxValue ?? 10}）`)
        const barDefs = this.barSchema().bars.filter((b) => b.enabled)
        if (barDefs.length) {
          const hero = chars[0]
          const heroVals = hero ? readBarValues(hero.barValuesJson) : {}
          lines.push(`【当前状态条】${barDefs.map((b) => `${b.name}（${heroVals[b.name] ?? b.max}/${b.max}）`).join('、')}；主角为第一张角色卡「${hero?.name ?? '（未建角）'}」`)
        }
        if (lines.length) parts.push(`【当前已生效的设定参考】\n${lines.join('\n').slice(0, 8000)}`)
        // v3.1：剧情态势简报（大整理，全知视角，只进交流栏）
        const brief = this.storyBriefText()
        if (brief) parts.push(`【剧情态势】（当前剧情进展，主持场外情报，非玩家所知）\n${brief}`)
      }
      return parts.join('\n\n')
    },

    /** 与 buildTalkSystem 顺序一致的编号→条目映射（AI 提交 ref 时解析用） */
    async buildSettingRefs(): Promise<Array<{ seq: number; entryId: number }>> {
      const c = this.currentCampaign
      if (!c?.id) return []
      const entries = await activeTalkEntries(c)
      return entries
        .map((e, i) => ({ seq: i + 1, entryId: e.id! }))
        .filter((r) => r.entryId)
    },

    /** 游戏流 prompts（预设链，强制写作模式；外部预设兜底） */
    async resolveGamePrompts(): Promise<Array<{ name: string; role: string; content: string; enabled: boolean }>> {
      const ds = useDataStore()
      const campaign = this.currentCampaign!
      const cfg = this.dreamConfig()
      if (cfg) {
        // v1.2：模式概念废弃，游戏流固定写作模式
        const writing = { ...cfg, output_mode: 'writing' }
        const api = ds.getDefaultApi()
        return buildDreamPromptBlocks(writing, api?.model ?? '')
      }
      if (campaign.presetId) {
        const preset = ds.presets.find((p) => p.id === campaign.presetId)
        if (preset) return JSON.parse(preset.promptsJson) as Array<{ name: string; role: string; content: string; enabled: boolean }>
      }
      return [{ name: 'default', role: 'system', content: '你是小说叙事 AI，请用中文推进故事。', enabled: true }]
    },

    /** 主请求：发送用户消息（按当前流） */
    async sendUserMessage(text: string) {
      if (!this.currentCampaignId || !text.trim() || this.sending) return
      const ds = useDataStore()
      const campaign = ds.campaigns.find((c) => c.id === this.currentCampaignId)
      if (!campaign) { this.error = '存档不存在'; return }
      const api = ds.getDefaultApi()
      if (!api) { this.error = '请先在设置中配置 API'; return }
      if (!api.apiKey) { this.error = `「${api.name}」还未填写 API Key，去设置里填一下`; return }

      this.error = ''

      const arr = this.currentStream === 'talk' ? this.talkMessages : this.gameMessages
      const maxSeq = arr.length ? arr[arr.length - 1].seq : 0
      const userMsg: Message = {
        campaignId: this.currentCampaignId,
        role: 'user',
        content: text.trim(),
        stream: this.currentStream,
        seq: maxSeq + 1,
        createdAt: Date.now(),
      }
      userMsg.id = await db.messages.add(plainMsg(userMsg))
      arr.push({ ...userMsg })

      await this.requestAssistant(campaign, api)
    },

    /** 手动重发：删除当前流某轮的最后一条 assistant（及其后续），重新请求 */
    async regenerate() {
      const campaign = this.currentCampaign
      if (!campaign || this.sending) return
      const arr = this.currentStream === 'talk' ? this.talkMessages : this.gameMessages
      const last = [...arr].reverse().find((m) => m.role === 'assistant')
      if (!last) return
      const doomed = arr.filter((m) => (m.seq ?? 0) >= (last.seq ?? 0))
      await db.messages.bulkDelete(doomed.map((m) => m.id!).filter(Boolean))
      const kept = arr.filter((m) => (m.seq ?? 0) < (last.seq ?? 0))
      if (this.currentStream === 'talk') this.talkMessages = kept
      else this.gameMessages = kept
      const api = useDataStore().getDefaultApi()
      if (!api) { this.error = '请先配置 API'; return }
      await this.requestAssistant(campaign, api)
    },

    /** v1.7 长按指定消息重新生成：删除该条 assistant 及后续，重新请求 */
    async regenerateAt(seq: number) {
      const campaign = this.currentCampaign
      if (!campaign || this.sending) return
      const arr = this.currentStream === 'talk' ? this.talkMessages : this.gameMessages
      const target = arr.find((m) => (m.seq ?? 0) === seq && m.role === 'assistant')
      if (!target) return
      const doomed = arr.filter((m) => (m.seq ?? 0) >= seq)
      await db.messages.bulkDelete(doomed.map((m) => m.id!).filter(Boolean))
      const kept = arr.filter((m) => (m.seq ?? 0) < seq)
      if (this.currentStream === 'talk') this.talkMessages = kept
      else this.gameMessages = kept
      const api = useDataStore().getDefaultApi()
      if (!api) { this.error = '请先配置 API'; return }
      await this.requestAssistant(campaign, api)
    },

    /** v1.7 编辑消息内容（assistant 编辑后重新解析，丢弃旧思维链） */
    async editMessage(id: number, text: string, isUser: boolean) {
      const m = await db.messages.get(id)
      if (!m) return
      m.content = text
      m.parsedJson = isUser ? undefined : JSON.stringify(parseDreamPlot(text))
      m.reasoning = undefined
      await db.messages.put(plainMsg(m))
      const patch = (arr: Message[]) => {
        const i = arr.findIndex((x) => x.id === id)
        if (i >= 0) arr[i] = { ...arr[i], ...plainMsg(m) }
      }
      patch(this.talkMessages)
      patch(this.gameMessages)
    },

    /** 共享助理请求逻辑（按流分派） */
    async requestAssistant(campaign: Campaign, api: ApiConfig) {
      if (this.currentStream === 'talk') await this.requestTalk(campaign, api)
      else await this.requestGame(campaign, api)
    },

    /** 交流栏请求：主持人格 + 纯文本历史（不注入世界书/变量/预设宏） */
    async requestTalk(campaign: Campaign, api: ApiConfig) {
      const system = await this.buildTalkSystem()
      const msgs: ChatUserMessage[] = [{ role: 'system', content: system }]
      // v1.8.1：交流流摘要 + 未压缩历史（与游戏流同构）
      let history = this.talkMessages.filter((m) => m.role !== 'system')
      const cutoff = campaign.summarizedTalkSeq ?? 0
      if (cutoff > 0) history = history.filter((m) => (m.seq ?? 0) > cutoff)
      if (campaign.summaryTalk) {
        msgs.push({ role: 'system', content: `【交流记录摘要】\n${campaign.summaryTalk}` })
      }
      for (const m of history) {
        msgs.push({ role: m.role as 'user' | 'assistant', content: m.content })
      }
      await this.chatCompletionAndAppend(msgs, campaign, api, 'talk')
    },

    /** 游戏流请求：完整预设链 + 世界书注入 + 变量宏 */
    async requestGame(campaign: Campaign, api: ApiConfig) {
      const prompts = await this.resolveGamePrompts()
      // v1.8 状态条协议（启用条时追加，AI 每轮末报数）
      const barDefs = this.barDefs()
      if (barDefs.length) {
        prompts.push({
          name: '状态条协议', role: 'system', enabled: true,
          content: `【状态条协议】本存档开启状态条（${barDefs.map((b) => b.name).join('、')}，上限各自定义，默认 100）。每轮回复末尾，若主角（第一张角色卡）状态发生变化，输出块 [[BAR]]{"name":"主角名","values":{"血条":62}}[[/BAR]]；无变化则省略。数值=当前剩余值，出负数按 0、超上限按上限。`,
        })
      }
      // v2.2：状态卡协议（配置层启用时注入，AI 每轮自动报数）
      const statusCardDef = this.statusCard()
      if (statusCardDef.enabled && statusCardDef.fields.some((f) => !f.disabled)) {
        prompts.push({ name: '状态卡协议', role: 'system', enabled: true, content: statusCardProtocol(statusCardDef) })
      }

      const bindings = await db.campaignBindings.where('campaignId').equals(this.currentCampaignId).toArray()
      const wbIds = bindings.map((b) => b.worldbookId)
      // 自动笔记簿始终参与注入（其内 pending 条目已被过滤）
      if (campaign.notebookWorldbookId) wbIds.push(campaign.notebookWorldbookId)
      const { constant: baseConstant, keyed: baseKeyed } = this.collectInjectedEntries(wbIds)
      const constant = [...baseConstant]
      const keyed = [...baseKeyed]

      // v3.1：人物卡注入分层（hook 常驻 / 详情触发 / 时期封存）。
      // 优先用世界书 kind=character 条目；老 characters 表无此类条目时退回整表常驻（只读兼容）。
      const charEntries = this.characterEntries()
      const mainChar = this.mainCharacterEntry()
      const recentText = this.gameMessages
        .slice(-8)
        .map((m) => bodyOfMsg(m) || m.content)
        .join('\n')
      const layers: InjectionLayer = computeInjectionLayers(
        charEntries.filter((e) => e.enabled && (e.source !== 'ai' || e.status === 'accepted')),
        mainChar?.id,
        campaign.currentTimeline,
        recentText,
        this.p1Budget(),
      )

      // 状态每轮喂（P0 一部分）：当前主角状态条 + 状态卡值
      const stateLines: string[] = []
      if (mainChar) {
        const p = parseCharacterPayload(mainChar.payloadJson)
        const barDefs2 = this.barDefs()
        if (barDefs2.length && p.barValues) {
          for (const b of barDefs2) {
            const v = p.barValues[b.name] ?? b.max
            stateLines.push(`${b.name} ${v}/${b.max}`)
          }
        }
        const sc = this.statusCard()
        if (sc.enabled) {
          const vals = readStatusValues(campaign.statusValuesJson)
          for (const f of sc.fields.filter((x) => !x.disabled)) {
            const v = vals[f.label]
            if (Array.isArray(v) && v.length) stateLines.push(`${f.label}：${v.join('、')}`)
            else if (v) stateLines.push(`${f.label}：${v}`)
          }
        }
      }
      if (stateLines.length) layers.p0.unshift(`主角状态：${stateLines.join('；')}`)

      const injection = renderInjectionText(layers)
      const charHookText = injection.constant
      if (charHookText) {
        // 角色/时期/基调的 hook 精要作为常驻注入（P0+P1）
        constant.push({
          worldbookId: campaign.notebookWorldbookId ?? 0,
          key: '', content: charHookText, enabled: 1, source: 'manual', kind: 'note',
          createdAt: 0, updatedAt: 0,
        })
      }
      // 命中触发的人物卡详情（P2）
      for (const detail of injection.keyed) {
        keyed.push({
          worldbookId: campaign.notebookWorldbookId ?? 0,
          key: '', content: detail, enabled: 1, source: 'manual', kind: 'note',
          createdAt: 0, updatedAt: 0,
        })
      }

      // v3.1：仅当没有 kind=character 条目时，退回老 characters 表整表常驻（只读兼容）
      if (charEntries.length === 0 && (campaign.charInject ?? 1) !== 0) {
        const charText = await this.charCardsText()
        if (charText) {
          constant.push({
            worldbookId: campaign.notebookWorldbookId ?? 0,
            key: '', content: charText, enabled: 1, source: 'manual', kind: 'note',
            createdAt: 0, updatedAt: 0,
          })
        }
      }

      // 变量存储
      const vars = new Map<string, string>()
      try { Object.entries(JSON.parse(campaign.varsJson || '{}')).forEach(([k, v]) => vars.set(k, String(v))) } catch { /* ignore */ }
      const persistVars = () => {
        campaign.varsJson = JSON.stringify(Object.fromEntries(vars))
        ds().saveCampaign(campaign)
      }

      // 上下文：摘要 + 未压缩历史（仅游戏流）
      let history = this.gameMessages.filter((m) => m.role !== 'system')
      if ((campaign.summarizedSeq ?? 0) > 0) {
        history = history.filter((m) => (m.seq ?? 0) > (campaign.summarizedSeq ?? 0))
      }
      // v2.1：历史渲染用净化正文（防 AI 复述的杂质文本污染后续上下文）
      const historyForRender = history.map((m) => ({
        ...m,
        content: m.role === 'assistant' ? (bodyOfMsg(m) || m.content) : m.content,
      }))
      // 注入摘要为最早一段历史
      if (campaign.summary) {
        historyForRender.unshift({
          campaignId: campaign.id!, role: 'system',
          content: `【前情摘要】\n${campaign.summary}`,
          seq: 0, createdAt: 0,
        })
      }

      const { messages: msgs } = renderPromptChain({
        campaign,
        prompts,
        history: historyForRender,
        userName: '梦客',
        charName: '思客',
        constantEntries: constant,
        keyedEntries: keyed,
        apiConfig: api,
      }, {
        get: (n) => vars.get(n),
        set: (n, v) => { vars.set(n, v); persistVars() },
        add: (n, v) => { vars.set(n, (vars.get(n) ?? '') + v); persistVars() },
      })

      await this.chatCompletionAndAppend(msgs, campaign, api, 'game')

      // 每 N 轮自动同步游戏流 → 世界书（原「自动整理」）
      const interval = campaign.autoInterval ?? 0
      if (interval > 0 && !this.organizing) {
        const lastOrg = campaign.lastOrganized ?? 0
        const recentUsers = this.gameMessages
          .filter((m) => m.role === 'user' && m.createdAt > lastOrg).length
        if (recentUsers >= interval) this.syncFrom('game')
      }

      // v3.1 大整理：剧情态势简报自动更新（每 20 个用户消息触发，可关）
      if ((campaign.briefEnabled ?? 1) !== 0 && !this.organizing) {
        const fromSeq = campaign.lastBriefGameSeq ?? 0
        const users = this.gameMessages.filter((m) => m.role === 'user' && (m.seq ?? 0) > fromSeq).length
        if (users >= (campaign.briefInterval ?? 20)) {
          // 不阻塞对话：fire-and-forget，失败静默（organizing 标志防并发）
          this.refreshStoryBrief().catch(() => {})
        }
      }
    },

    /** 请求 + 落库 + 统计（两流共用）；talk 流解析 AI 操作块 → 写入操作审计 */
    async chatCompletionAndAppend(msgs: ChatUserMessage[], campaign: Campaign, api: ApiConfig, stream: StreamKind): Promise<number> {
      this.sending = true
      this.liveText = ''
      this.liveReasoning = ''
      try {
        // v2.1 流式：SSE 增量实时上屏；原生无 CORS 时内部回退全量
        const streamed = await chatCompletionStream(api, msgs, (delta) => {
          this.liveText += delta
        }, (reason) => {
          this.liveReasoning += reason
        })
        this.liveText = ''
        const reply = { content: streamed.content, reasoning: streamed.reasoning, usage: streamed.usage }
        // v2.1.1：先剥 [[BAR]] 直通块，再解析 XML（避免 BAR 在 after_format 内时泄漏显示）
        let content = reply.content
        if (stream === 'game') {
          const bars = parseBars(reply.content)
          content = bars.clean
          if (bars.updates.length) await this.applyBarUpdates(bars.updates)
          const snap = parseSnap(content)
          content = snap.clean
          if (snap.updates.length) await this.applySnapUpdates(snap.updates, campaign)
        }
        const parsed = stream === 'game' ? parseDreamPlot(content) : null
        const usage = reply.usage ? parseUsage({ usage: reply.usage }) : null
        const cost = usage && estimateCostYuan(api.model, usage, new Date())
        const costYuan = cost?.costYuan
        // v1.5：交流流解析 AI 操作块 → 临时区审计；ref 编号就地解析为 entryId
        let opCount = 0
        const newOpIds: number[] = []
        if (stream === 'talk') {
          const r = parseOps(reply.content)
          content = r.clean
          if (r.ops.length) {
            const refs = await this.buildSettingRefs()
            for (const o of resolveRefs(r.ops, refs)) {
              const oid = await db.ops.add(plainMsg({
                campaignId: this.currentCampaignId,
                kind: o.op,
                payload: JSON.stringify(o),
                status: 'pending',
                createdAt: Date.now(),
                src: 'ai',
              }))
              newOpIds.push(oid)
            }
            opCount = r.ops.length
          }
        }

        const arr = stream === 'talk' ? this.talkMessages : this.gameMessages
        const maxSeq = arr.length ? arr[arr.length - 1].seq : 0
        const asstMsg: Message = {
          campaignId: this.currentCampaignId,
          role: 'assistant',
          content,
          stream,
          parsedJson: parsed ? JSON.stringify(parsed) : undefined,
          reasoning: reply.reasoning?.trim() ? reply.reasoning.trim() : undefined,
          usageJson: usage ? JSON.stringify({
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costYuan: costYuan,
            peak: cost?.peak,
          }) : undefined,
          seq: maxSeq + 1,
          createdAt: Date.now(),
        }
        asstMsg.id = await db.messages.add(plainMsg(asstMsg))
        arr.push({ ...asstMsg })
        // v2.0：操作块与消息关联（消息内嵌操作卡按 msgId 查询）
        if (newOpIds.length && asstMsg.id) {
          for (const oid of newOpIds) { const op = await db.ops.get(oid); if (op) { op.msgId = asstMsg.id; await db.ops.put(plainMsg(op)) } }
        }

        // 统计累计
        if (usage) {
          campaign.statTokens = (campaign.statTokens ?? 0) + usage.totalTokens
          if (costYuan) campaign.statCostYuan = (campaign.statCostYuan ?? 0) + costYuan
        }

        campaign.lastActive = Date.now()
        await ds().saveCampaign(campaign)

        // 自动上下文压缩检测（80% 预算；两流各有摘要字段）
        if (usage && campaign.ctxBudget && campaign.ctxBudget > 0) {
          if (usage.promptTokens > campaign.ctxBudget * COMPACT_RATIO) {
            this.compactContext(stream)
          }
        }
        // v2.0：交流栏自动整理（talkAutoInterval 条用户消息后同步一次，默认关）
        if (stream === 'talk' && (campaign.talkAutoInterval ?? 0) > 0 && !this.organizing) {
          const recentUsers = this.talkMessages.filter((m) => m.role === 'user' && (m.seq ?? 0) > (campaign.lastSyncedTalkSeq ?? 0)).length
          if (recentUsers >= (campaign.talkAutoInterval ?? 4)) this.syncFrom('talk')
        }
        this.lastOpCount = opCount
        return opCount
      } catch (e: any) {
        this.error = e?.message || String(e)
        return 0
      } finally {
        this.sending = false
        this.liveText = ''
        this.liveReasoning = ''
      }
    },

    // ---- v1.5 AI 操作审计：确认执行 / 退回 ----

    /** 确认执行一条操作 */
    async executeOp(id: number): Promise<boolean> {
      const op = await db.ops.get(id)
      if (!op || op.status !== 'pending') return false
      const p = JSON.parse(op.payload) as OpBlock
      const ok = await this.applyOp(p)
      if (ok) {
        op.status = 'done'
        op.doneAt = Date.now()
        await db.ops.put(plainMsg(op))
        // 刷新条目/角色/关系缓存（配置 tab 与面板数据源）
        await ds().loadAll()
        this.opsVersion++
      }
      return ok
    },

    /** 退回一条操作（不执行） */
    async rejectOp(id: number) {
      const op = await db.ops.get(id)
      if (!op || op.status !== 'pending') return
      op.status = 'rejected'
      op.doneAt = Date.now()
      await db.ops.put(plainMsg(op))
      this.opsVersion++
    },

    /** 全部确认（仅非删除类；删除类必须逐条） */
    async acceptAllOps(): Promise<number> {
      const pending = await db.ops.where('campaignId').equals(this.currentCampaignId).and((o) => o.status === 'pending').toArray()
      let done = 0
      for (const op of pending) {
        const group = opGroup(op.kind)
        if (group === 'del') continue
        if (await this.executeOp(op.id!)) done++
      }
      return done
    },

    /** v1.8：状态条直通更新（游戏流 [[BAR]] 直接生效） */
    async applyBarUpdates(updates: Array<{ name?: string; values: Record<string, number> }>) {
      const defs = this.barDefs()
      if (!defs.length) return
      const cid = this.currentCampaignId
      if (!cid) return
      // v3.1：优先写人物卡条目（payload.barValues）；老 characters 表同步（只读兼容）
      const charEntries = this.characterEntries()
      for (const u of updates) {
        const targetName = u.name
        const entry = targetName
          ? charEntries.find((e) => parseCharacterPayload(e.payloadJson).name === targetName)
          : (charEntries.find((e) => e.isMain === 1) ?? charEntries[0])
        if (!entry) {
          // 无人物卡条目 → 老表兜底
          const chars = await db.characters.where('campaignId').equals(cid).toArray()
          const target = (u.name && chars.find((c) => c.name === u.name)) ?? chars[0]
          if (!target) continue
          const cur = readBarValues(target.barValuesJson)
          for (const [k, v] of Object.entries(u.values)) {
            if (defs.some((d) => d.name === k)) cur[k] = v
          }
          target.barValuesJson = writeBarValues(cur, defs)
          target.updatedAt = Date.now()
          await db.characters.put(plainMsg(target))
          continue
        }
        const p = parseCharacterPayload(entry.payloadJson)
        const cur = { ...(p.barValues ?? {}) }
        for (const [k, v] of Object.entries(u.values)) {
          if (defs.some((d) => d.name === k)) cur[k] = v
        }
        p.barValues = cur
        entry.payloadJson = characterPayloadJson(p)
        entry.updatedAt = Date.now()
        await db.entries.put(plainMsg(entry))
        // 老表同步（只读兼容）
        const chars2 = await db.characters.where('campaignId').equals(cid).toArray()
        const legacy = (u.name && chars2.find((c) => c.name === u.name)) ?? chars2[0]
        if (legacy) {
          const cur2 = readBarValues(legacy.barValuesJson)
          for (const [k, v] of Object.entries(u.values)) {
            if (defs.some((d) => d.name === k)) cur2[k] = v
          }
          legacy.barValuesJson = writeBarValues(cur2, defs)
          legacy.updatedAt = Date.now()
          await db.characters.put(plainMsg(legacy))
        }
      }
      await useDataStore().loadAll()
    },

    /** v2.2：状态卡直通更新（游戏流 [[SNAP]] 直接生效，无需审计） */
    async applySnapUpdates(updates: Array<Record<string, any>>, campaign?: Campaign) {
      const c = campaign ?? this.currentCampaign
      const def = this.statusCard()
      if (!c || !def.enabled || !updates.length) return
      const active = def.fields.filter((f) => !f.disabled)
      const vals = readStatusValues(c.statusValuesJson)
      for (const u of updates) {
        for (const [label, v] of Object.entries(u)) {
          const f = active.find((x) => x.label === label)
          if (!f) continue
          if (f.type === 'list') {
            // v2.2.1：增量语义（add/remove），杜绝全量覆盖丢数据；
            // 兼容旧协议 items（仅当为空时接受，非空时忽略防覆盖）
            const cur = Array.isArray(vals[label]) ? (vals[label] as string[]) : []
            if (v && typeof v === 'object') {
              let next = cur
              if (Array.isArray(v.items) && v.items.length && !cur.length) next = v.items.map(String)
              if (v.add && !next.includes(String(v.add))) next = [...next, String(v.add)]
              if (v.remove) {
                const rm = Array.isArray(v.remove) ? v.remove.map(String) : [String(v.remove)]
                next = next.filter((x) => !rm.includes(x))
              }
              vals[label] = next
            } else if (typeof v === 'string' && v.trim()) {
              // 旧协议兜底：字符串当新增一项（去重）
              const item = v.trim()
              vals[label] = cur.includes(item) ? cur : [...cur, item]
            }
          } else if (typeof v === 'string' && v.trim()) {
            vals[label] = v
          } else if (v && typeof v === 'object' && v.value) {
            vals[label] = String(v.value)
          }
        }
      }
      c.statusValuesJson = writeStatusValues(vals)
      await db.campaigns.put(plainMsg(c))
      await useDataStore().loadAll()
    },

    /** 执行操作主逻辑（确认时调用） */
    async applyOp(p: OpBlock): Promise<boolean> {
      const ds = useDataStore()
      const c = this.currentCampaign
      if (!c?.id) return false
      try {
        switch (p.op) {
          case 'entry.upsert': {
            const notebook = await this.ensureNotebook()
            // 优先 entryId（ref 已解析）；条目已被删则回退 key 匹配（防再造成同 key 双条）
            const exist = p.entryId
              ? (await db.entries.get(p.entryId)) ?? findNotebookEntry(ds, notebook.id!, normalizeKeys(p.key))
              : findNotebookEntry(ds, notebook.id!, normalizeKeys(p.key))
            if (exist) {
              exist.content = p.content ?? exist.content
              if (p.category) exist.category = normCategory(p.category)
              exist.updatedAt = Date.now()
              await db.entries.put(plainMsg(exist))
            } else {
              await db.entries.add(plainMsg({
                worldbookId: notebook.id!,
                key: p.key ?? '',
                content: p.content ?? '',
                category: normCategory(p.category),
                enabled: 1,
                source: 'ai',
                status: 'accepted',   // 已在临时区确认 → 直接生效
                createdAt: Date.now(), updatedAt: Date.now(),
              }))
            }
            return true
          }
          case 'entry.delete': {
            const notebook = await this.ensureNotebook()
            const exist = p.entryId
              ? await db.entries.get(p.entryId)
              : findNotebookEntry(ds, notebook.id!, normalizeKeys(p.key))
            if (exist?.id) { await db.entries.delete(exist.id); return true }
            return false
          }
          case 'entry.disable': {
            const notebook = await this.ensureNotebook()
            const exist = p.entryId
              ? await db.entries.get(p.entryId)
              : findNotebookEntry(ds, notebook.id!, normalizeKeys(p.key))
            if (exist) { exist.enabled = 0; exist.updatedAt = Date.now(); await db.entries.put(plainMsg(exist)); return true }
            return false
          }
          case 'char.upsert': {
            const name = p.name?.trim()
            if (!name) return false
            const chars = await db.characters.where('campaignId').equals(c.id).toArray()
            const exist = chars.find((x) => x.name === name)
            const dimLabels = this.attrSchema().dims.map((d) => d.label)
            const attrsJson = mergeAttrs(exist?.attributesJson, (p.attrs ?? []).filter((a) => dimLabels.includes(a.label)))
            if (exist) {
              if (p.identity) exist.identity = p.identity
              if (p.realm) exist.realm = p.realm
              if (p.description) exist.description = p.description
              if (attrsJson !== undefined) exist.attributesJson = attrsJson
              exist.updatedAt = Date.now()
              await db.characters.put(plainMsg(exist))
            } else {
              await db.characters.add(plainMsg({
                campaignId: c.id,
                name,
                identity: p.identity ?? '',
                realm: p.realm,
                description: p.description ?? '',
                attributesJson: attrsJson,
                source: 'ai', createdAt: Date.now(), updatedAt: Date.now(),
              }))
            }
            return true
          }
          case 'char.rename': {
            const chars = await db.characters.where('campaignId').equals(c.id).toArray()
            const rels = await db.relations.where('campaignId').equals(c.id).toArray()
            const rm = applyRenames(chars, rels, [{ from: p.from ?? '', to: p.to ?? '' }])
            for (const ch of rm.changedChars) await db.characters.put(plainMsg(ch))
            for (const r of rm.changedRels) await db.relations.put(plainMsg(r))
            for (const d of rm.deletedChars) if (d.id) await db.characters.delete(d.id)
            return rm.changedChars.length > 0 || rm.deletedChars.length > 0
          }
          case 'rel.upsert': {
            if (!p.from?.trim() || !p.to?.trim() || !p.relType?.trim()) return false
            const rels = await db.relations.where('campaignId').equals(c.id).toArray()
            const exist = rels.find((r) => r.fromChar === p.from && r.toChar === p.to && r.relType === p.relType)
            if (exist) {
              if (p.label) exist.label = p.label
              await db.relations.put(plainMsg(exist))
            } else {
              await db.relations.add(plainMsg({
                campaignId: c.id,
                fromChar: p.from, toChar: p.to, relType: p.relType, label: p.label ?? '',
                createdAt: Date.now(),
              }))
            }
            return true
          }
          case 'rel.delete': {
            if (!p.from?.trim() || !p.to?.trim() || !p.relType?.trim()) return false
            const rels = await db.relations.where('campaignId').equals(c.id).toArray()
            const exist = rels.find((r) => r.fromChar === p.from && r.toChar === p.to && r.relType === p.relType)
            if (exist?.id) { await db.relations.delete(exist.id); return true }
            return false
          }
          case 'bar.config': {
            const cur = this.barSchema()
            const defs = (p.bars ?? [])
              .filter((b) => b?.name?.trim())
              .map((b) => ({
                id: cur.bars.find((x) => x.name === b.name)?.id ?? `b${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: b.name.trim(),
                color: /^#[0-9a-fA-F]{3,8}$/.test(b.color ?? '') ? b.color! : '#e06c75',
                max: Math.max(1, Number(b.max) || 100),
                enabled: b.enabled !== false,
              }))
            if (!defs.length) return false
            await this.saveBarSchema({ bars: defs.slice(0, 12) })
            return true
          }
          case 'schema.propose': {
            const dims = (p.dims ?? []).filter((d) => d?.label?.trim()).map((d) => ({ label: d.label.trim() }))
            if (!dims.length) return false
            await this.saveAttrSchema({ dims: dims.slice(0, 10), realmLabel: p.realmLabel ?? '' })
            return true
          }
          default:
            return false
        }
      } catch (e: any) {
        this.error = `操作执行失败：${e?.message || e}`
        return false
      }
    },

    /**
     * v1.8.1：当前流上下文压力（0..1+）=（摘要 + 未压缩历史）粗估 token / 预算。
     * 中文按 1 字 ≈ 0.6 token 粗估；预算未启用（0/缺省）返回 0。
     */
    ctxPressure(stream: StreamKind): number {
      const c = this.currentCampaign
      if (!c) return 0
      const budget = c.ctxBudget ?? 0
      if (budget <= 0) return 0
      const est = (t?: string) => (t ? Math.ceil(t.length * 0.6) : 0)
      let n = 0
      if (stream === 'talk') {
        const cutoff = c.summarizedTalkSeq ?? 0
        n += est(c.summaryTalk)
        for (const m of this.talkMessages) {
          if (m.role === 'system') continue
          if ((m.seq ?? 0) <= cutoff) continue
          n += est(m.content)
        }
      } else {
        const cutoff = c.summarizedSeq ?? 0
        n += est(c.summary)
        for (const m of this.gameMessages) {
          if (m.role === 'system') continue
          if ((m.seq ?? 0) <= cutoff) continue
          n += est(m.content)
        }
      }
      return n / budget
    },

    /**
     * 上下文压缩：把已压缩点之前的消息摘要为一段文本（两流各一套字段）。
     * @param stream 目标流（默认 game）；压缩游戏流用 summary/summarizedSeq，交流流用 summaryTalk/summarizedTalkSeq。
     */
    async compactContext(stream: StreamKind = 'game') {
      const c = this.currentCampaign
      if (!c || this.compacting) return
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api) { this.error = '压缩需要 API 配置'; return }

      const msgs = stream === 'talk' ? this.talkMessages : this.gameMessages
      const cutoff = stream === 'talk' ? (c.summarizedTalkSeq ?? 0) : (c.summarizedSeq ?? 0)
      const toSummarize = msgs.filter((m) => (m.seq ?? 0) > cutoff && m.role !== 'system')
      if (toSummarize.length === 0) return

      // 保留最近 12 条不缩（保持细节），压缩更早的
      const keep = 12
      const compactArr = toSummarize.slice(0, Math.max(0, toSummarize.length - keep))
      if (compactArr.length === 0) {
        this.error = '消息还不够长，暂不需要压缩'
        return
      }

      this.compacting = true
      this.error = ''
      try {
        const text = compactArr
          .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${bodyOfMsg(m)}`))
          .join('\n\n')

        const summary = await chatCompletion(api, [
          { role: 'system', content: '你是剧情摘要器。把用户提供的对话压缩为一段紧凑的中文前情摘要（保留关键事件、角色状态、关系变化、未解伏笔）。直接输出摘要文本，不超过 800 字。' },
          { role: 'user', content: `请压缩以下对话：\n\n${text.slice(-60000)}` },
        ])

        const newCutoff = compactArr[compactArr.length - 1].seq ?? 0
        if (stream === 'talk') {
          c.summaryTalk = summary.trim()
          c.summarizedTalkSeq = Math.max(c.summarizedTalkSeq ?? 0, newCutoff)
        } else {
          c.summary = summary.trim()
          c.summarizedSeq = Math.max(c.summarizedSeq ?? 0, newCutoff)
        }
        await ds.saveCampaign(c)

        // 清理被压缩的消息（保留最近 keep 条）
        const doomedIds = compactArr.map((m) => m.id!).filter(Boolean)
        if (doomedIds.length) await db.messages.bulkDelete(doomedIds)
        if (stream === 'talk') {
          this.talkMessages = this.talkMessages.filter((m) => !doomedIds.includes(m.id!))
        } else {
          this.gameMessages = this.gameMessages.filter((m) => !doomedIds.includes(m.id!))
        }
      } catch (e: any) {
        this.error = `压缩失败：${e?.message || e}`
      } finally {
        this.compacting = false
      }
    },

    /**
     * v1.2：按来源流增量提炼（交流流 → 游戏设定；游戏流 → 世界书）。
     * 写角色（含属性）/关系/笔记簿 pending 条目；游标推进，接受后才生效。
     */
    async syncFrom(source: StreamKind): Promise<SyncOutcome> {
      if (!this.currentCampaignId) return { chars: 0, rels: 0, facts: 0, skipped: true }
      const ds = useDataStore()
      const campaign = this.currentCampaign
      if (!campaign) return { chars: 0, rels: 0, facts: 0, skipped: true }
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) {
        this.error = '同步需要 API 配置'
        return { chars: 0, rels: 0, facts: 0, skipped: true }
      }

      const msgs = source === 'talk' ? this.talkMessages : this.gameMessages
      const lastSeq = source === 'talk' ? (campaign.lastSyncedTalkSeq ?? 0) : (campaign.lastSyncedGameSeq ?? 0)
      const recent = msgs.filter((m) => (m.seq ?? 0) > lastSeq)
      if (recent.length === 0) return { chars: 0, rels: 0, facts: 0, skipped: true }
      const text = recent
        .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${bodyOfMsg(m)}`))
        .join('\n\n')
      if (text.trim().length < 40) return { chars: 0, rels: 0, facts: 0, skipped: true }

      this.organizing = true
      this.error = ''
      try {
        // 已有实体（增量去重）
        const chars = await db.characters.where('campaignId').equals(this.currentCampaignId).toArray()
        const rels = await db.relations.where('campaignId').equals(this.currentCampaignId).toArray()
        const notebook = await this.ensureNotebook()
        const notebookEntries = notebook.id ? ds.entriesOf(notebook.id) : []
        // 硬去重基线：所有非 rejected 条目（pending 也算，防反复提取）
        const existingFacts = notebookEntries.filter((e) => e.status !== 'rejected')
        // v1.3：存档属性体系（提取维度强制 + 境界识别）
        const schema = this.attrSchema()
        const dimLabels = schema.dims.map((d) => d.label)

        const result = await extractFacts(api, {
          characters: chars.map((c) => c.name),
          relations: rels.map((r) => `${r.fromChar}|${r.toChar}|${r.relType}`),
          // 已有事实触发词：手动/导入 + AI（含 pending，防止重复提取）
          facts: notebookEntries.filter((e) => e.status !== 'rejected').map((e) => e.key),
          recentText: text,
          attrDims: dimLabels,
          realmLabel: schema.realmLabel ?? '',
          // v2.2.1：存档已用类别（含用户自定义）→ 提取时优先沿用，不再全堆「其他」
          categoryCandidates: notebookEntries
            .map((e) => e.category)
            .filter((c): c is string => !!c && c !== '其他'),
        })

        // 0. 角色改名/合并：先把旧卡名更正（关系两端同步迁移），后续写入按新名匹配
        if ((result.renames ?? []).length) {
          const rm = applyRenames(chars, rels, result.renames)
          for (const c of rm.changedChars) await db.characters.put(plainMsg(c))
          for (const r of rm.changedRels) await db.relations.put(plainMsg(r))
          for (const d of rm.deletedChars) if (d.id) await db.characters.delete(d.id)
        }

        // 3. 写角色（v3.1：kind=character 人物卡条目单源；老 characters 表保持同步供旧 UI 只读）
        //    属性合并；属性只保留存档维度；自动生成 hook（一行精要）
        let newChars = 0, updChars = 0
        const charEntriesNow = notebook.id ? ds.entriesOf(notebook.id).filter((e) => e.kind === 'character') : []
        for (const c of result.characters) {
          // 改名后旧名条目丢弃（AI 应只用新名输出）
          if ((result.renames ?? []).some((r) => r.from === c.name)) continue
          // 已有同名人物卡条目？
          let entry = charEntriesNow.find((e) => parseCharacterPayload(e.payloadJson).name === c.name)
          const dimAttrs = (c.attributes ?? []).filter((a) => dimLabels.includes(a.label))

          if (!entry) {
            // 新建 kind=character 条目
            const payload = characterPayloadJson({
              name: c.name,
              identity: c.identity?.trim() || undefined,
              realm: c.realm?.trim() || undefined,
              attributes: dimAttrs,
            })
            entry = {
              worldbookId: notebook.id!,
              kind: 'character',
              payloadJson: payload,
              hook: `${c.name}${c.identity ? `：${c.identity}` : ''}`,
              isMain: 0,
              key: c.name,
              content: c.description?.trim() ?? '',
              enabled: 1,
              source: 'ai',
              status: 'accepted',
              category: '其他',
              createdAt: Date.now(), updatedAt: Date.now(),
            }
            await db.entries.add(plainMsg(entry))
            newChars++
          } else {
            // 更新既有条目（合并 payload；hook 仅在缺省时生成）
            const p = parseCharacterPayload(entry.payloadJson)
            let changed = false
            if (c.description && c.description !== entry.content) { entry.content = c.description.trim(); changed = true }
            if (c.identity && c.identity !== p.identity) { p.identity = c.identity.trim(); changed = true }
            if (c.realm && c.realm !== p.realm) { p.realm = c.realm.trim(); changed = true }
            if (dimAttrs.length) {
              const merged = mergeAttrs(p.attributes?.length ? JSON.stringify(p.attributes) : undefined, dimAttrs)
              p.attributes = JSON.parse(merged!) as Array<{ label: string; value: number }>
              changed = true
            }
            if (!entry.hook && (c.name || p.identity)) {
              entry.hook = `${p.name || c.name}${p.identity ? `：${p.identity}` : ''}`
              changed = true
            }
            if (changed) {
              entry.payloadJson = characterPayloadJson(p)
              entry.updatedAt = Date.now()
              await db.entries.put(plainMsg(entry))
              updChars++
            }
          }

          // 老 characters 表同步（只读兼容：旧 UI/关系图仍读它）
          const exist = chars.find((x) => x.name === c.name)
          const attrsJson = mergeAttrs(exist?.attributesJson, dimAttrs)
          if (exist) {
            if (c.description && c.description !== exist.description) exist.description = c.description
            if (c.identity && c.identity !== exist.identity) exist.identity = c.identity
            if (c.realm && c.realm !== exist.realm) exist.realm = c.realm
            if (attrsJson !== undefined) exist.attributesJson = attrsJson
            exist.source = exist.source || 'ai'
            exist.updatedAt = Date.now()
            await db.characters.put(plainMsg(exist))
          } else {
            await db.characters.add(plainMsg({
              campaignId: this.currentCampaignId,
              name: c.name, identity: c.identity ?? '', realm: c.realm,
              description: c.description ?? '',
              attributesJson: attrsJson,
              source: 'ai', createdAt: Date.now(), updatedAt: Date.now(),
            }))
          }
        }

        // 4. 写关系（按 from+to+relType 增量更新）
        let newRels = 0
        for (const r of result.relations) {
          const exist = rels.find((x) => x.fromChar === r.from && x.toChar === r.to && x.relType === r.relType)
          if (exist) continue
          await db.relations.add(plainMsg({
            campaignId: this.currentCampaignId,
            fromChar: r.from, toChar: r.to, relType: r.relType, label: r.label ?? '',
            createdAt: Date.now(),
          }))
          newRels++
        }

        // 5. 写自动笔记簿条目（v2.0 归并：同 key/高度相似不再新增——
        //    accepted 目标 → 生成「更新」操作进审计（diff 待确认）
        //    pending 目标 → 就地更新待确认内容（保持单条）
        //    无目标 → 新建 pending）
        let newFacts = 0
        let updPlans = 0
        const seenFacts: Array<{ key?: string; content: string }> = []
        const newOps: Array<{ op: string; entryId?: number; key: string; content: string; category?: string }> = []
        for (const f of result.facts) {
          if (seenFacts.some((s) => factsDup(s, f))) continue
          const hit = existingFacts.find((e) => dedupStatus(e, f) !== null)
          if (hit) {
            if (hit.status === 'pending') {
              // 原地更新待确认内容（防重复 pending）
              if (hit.content.trim() !== f.content.trim() || (f.category && hit.category !== f.category)) {
                hit.content = f.content
                if (f.category) hit.category = f.category
                hit.updatedAt = Date.now()
                await db.entries.put(plainMsg(hit))
              }
            } else if (hit.content.trim() !== f.content.trim() || (f.category && hit.category !== f.category)) {
              // 已是正式条目且内容不同 → 生成更新操作（由用户对比确认）
              newOps.push({ op: 'entry.upsert', entryId: hit.id, key: hit.key || f.key || '', content: f.content, category: f.category })
              updPlans++
            }
            // 内容一致且已有 → 纯重复，什么都不做
            seenFacts.push(f)
            continue
          }
          seenFacts.push(f)
          await db.entries.add(plainMsg({
            worldbookId: notebook.id!,
            key: f.key ?? '',
            content: f.content,
            category: f.category,
            enabled: 1,
            source: 'ai',
            status: 'pending',
            createdAt: Date.now(), updatedAt: Date.now(),
          }))
          newFacts++
        }
        if (newOps.length) {
          for (const o of newOps) {
            await db.ops.add(plainMsg({
              campaignId: this.currentCampaignId,
              kind: o.op,
              payload: JSON.stringify(o),
              status: 'pending',
              createdAt: Date.now(),
              src: 'extract',
            }))
          }
          this.lastOpCount += newOps.length
        }

        if (source === 'talk') campaign.lastSyncedTalkSeq = recent[recent.length - 1].seq
        else campaign.lastSyncedGameSeq = recent[recent.length - 1].seq
        campaign.lastOrganized = Date.now()
        campaign.organizeStats = JSON.stringify({
          chars: newChars + updChars, rels: newRels, facts: newFacts, upd: updPlans, at: Date.now(),
        })
        await ds.saveCampaign(campaign)
        await ds.loadAll()
        return { chars: newChars + updChars, rels: newRels, facts: newFacts, upd: updPlans, skipped: false }
      } catch (e: any) {
        this.error = `同步失败：${e?.message || e}`
        return { chars: 0, rels: 0, facts: 0, skipped: true }
      } finally {
        this.organizing = false
      }
    },

    /** 兼容旧入口：面板「整理世界书」= 游戏流 → 世界书 */
    async organizeWorldbook(): Promise<void> {
      await this.syncFrom('game')
    },

    /**
     * 开始游戏 第一步：提炼交流流 + AI 生成开局包（世界观要点 + 开场白）。
     */
    async prepareStartGame(): Promise<StartGamePack | null> {
      const campaign = this.currentCampaign
      if (!campaign) return null
      await this.syncFrom('talk')
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) { this.error = '开始游戏需要 API 配置'; return null }

      const talkText = this.talkMessages
        .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${m.content}`))
        .join('\n\n')
        .slice(-60000)
      if (!talkText.trim()) { this.error = '交流栏还没有内容'; return null }

      try {
        const reply = await chatCompletion(api, [
          {
            role: 'system',
            content: '你是梦境游戏的开局设计师。根据玩家与游戏设计主持的交流内容，提炼开局包。输出严格 JSON（不要输出其他文字、不要代码块）：{"worldview":"世界观要点，2-3句，凝练，涵盖玩家确定的基调与禁项","opening":"开场白正文，200-400字，用第二人称叙述，点明玩家角色与初始场景，直接进入剧情氛围，不要包含任何 XML 标签"}',
          },
          { role: 'user', content: talkText },
        ])
        const parsed = extractJson<StartGamePack>(reply)
        if (!parsed?.worldview) return null
        return { worldview: parsed.worldview, opening: parsed.opening ?? '' }
      } catch (e: any) {
        this.error = `生成开局包失败：${e?.message || e}`
        return null
      }
    },

    /**
     * 开始游戏 第二步：落档（gameStarted=1）+ 写入开场白（可选）+ 切游戏栏。
     */
    async commitStartGame(opening: string, withOpening: boolean) {
      const campaign = this.currentCampaign
      if (!campaign) return
      campaign.gameStarted = 1
      campaign.lastSyncedTalkSeq = Math.max(campaign.lastSyncedTalkSeq ?? 0, this.talkMessages[this.talkMessages.length - 1]?.seq ?? 0)
      if (withOpening && opening.trim()) {
        const maxSeq = this.gameMessages.length ? this.gameMessages[this.gameMessages.length - 1].seq : 0
        const m: Message = {
          campaignId: this.currentCampaignId,
          role: 'assistant',
          content: opening.trim(),
          stream: 'game',
          parsedJson: JSON.stringify({ kind: 'opening', body: opening.trim() }),
          seq: maxSeq + 1,
          createdAt: Date.now(),
        }
        m.id = await db.messages.add(plainMsg(m))
        this.gameMessages.push({ ...m })
      }
      await ds().saveCampaign(campaign)
      this.currentStream = 'game'
      campaign.lastStream = 'game'
    },

    /**
     * 游戏栏「📜 总结」：把游戏流剧情总结为章节回顾卡，写回游戏流。
     */
    async generateSummary(): Promise<SummaryPack | null> {
      const campaign = this.currentCampaign
      if (!campaign) return null
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) { this.error = '总结需要 API 配置'; return null }

      const text = this.gameMessages
        .filter((m) => m.role !== 'system')
        .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${bodyOfMsg(m)}`))
        .join('\n\n')
        .slice(-50000)
      if (!text.trim()) { this.error = '游戏流还没有剧情'; return null }

      this.organizing = true
      try {
        const reply = await chatCompletion(api, [
          {
            role: 'system',
            content: '你是剧情回顾师。把玩家提供的跑团剧情整理成一章回顾。输出严格 JSON（不要输出其他文字、不要代码块）：{"title":"章节标题，8-14字","events":[{"time":"时间（可空，如：第二天上午）","place":"地点（可空）","desc":"事件，1-2句"}]}。events 按剧情顺序，4-10 条。',
          },
          { role: 'user', content: `请回顾以下剧情：\n\n${text}` },
        ])
        const parsed = extractJson<SummaryPack>(reply)
        if (!parsed?.title || !Array.isArray(parsed.events) || !parsed.events.length) return null
        await this.appendSummaryCard(parsed)
        return parsed
      } catch (e: any) {
        this.error = `总结失败：${e?.message || e}`
        return null
      } finally {
        this.organizing = false
      }
    },

    /** 把回顾卡写回游戏流（可回看） */
    async appendSummaryCard(s: SummaryPack) {
      const maxSeq = this.gameMessages.length ? this.gameMessages[this.gameMessages.length - 1].seq : 0
      const m: Message = {
        campaignId: this.currentCampaignId,
        role: 'assistant',
        content: `${s.title}`,
        stream: 'game',
        parsedJson: JSON.stringify({ kind: 'summary', title: s.title, events: s.events }),
        seq: maxSeq + 1,
        createdAt: Date.now(),
      }
      await db.messages.add(plainMsg(m))
      this.gameMessages.push({ ...m, id: (m as any).id })
    },

    /** 获取/创建存档专属的「自动笔记簿」世界书 */
    async ensureNotebook() {
      const ds = useDataStore()
      const c = this.currentCampaign!
      if (c.notebookWorldbookId) {
        const wb = ds.worldbooks.find((w) => w.id === c.notebookWorldbookId)
        if (wb) return wb
      }
      const wb = {
        name: `${c.name} · 自动笔记簿`,
        description: 'AI 提取的世界书事实（审阅后生效）',
        scope: 'campaign' as const,
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      const id = await db.worldbooks.add(plainMsg(wb))
      c.notebookWorldbookId = id
      await ds.saveCampaign(c)
      await ds.loadAll()
      return ds.worldbooks.find((w) => w.id === id)!
    },
  },
})

/** Pinia store 外部取 ds（避免 action 内循环依赖） */
function ds() {
  return useDataStore()
}

/** 触发词解析（逗号/中文逗号分隔） */
function normalizeKeys(key?: string): string[] {
  return (key ?? '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
}

/**
 * 判定两条事实是否重复：触发词词级相等（任一词相同）或正文完全一致。
 * 注意不用子串匹配：「铁炉堡」≠「铁炉堡货币」，那是两条不同设定。
 */
function factsDup(a: { key?: string; content: string }, b: { key?: string; content: string }): boolean {
  const ka = normalizeKeys(a.key), kb = normalizeKeys(b.key)
  if (ka.length && kb.length && ka.some((x) => kb.includes(x))) return true
  return (a.content ?? '').trim() === (b.content ?? '').trim()
}

/** 在笔记簿中按触发词匹配条目（相等/互相包含均命中） */
function findNotebookEntry(ds: ReturnType<typeof useDataStore>, notebookId: number, keys: string[]): EntryType | undefined {
  if (!keys.length) return undefined
  const list = ds.entriesOf(notebookId)
  return list.find((e) => {
    if (e.status === 'rejected') return false
    const eKeys = (e.key || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    if (!eKeys.length && keys.length === 0) return true
    return eKeys.some((k) => keys.includes(k) || keys.some((x) => x.includes(k) || k.includes(x)))
  })
}

/** 当前生效的世界书条目（与 buildTalkSystem 参考清单同序同过滤） */
async function activeTalkEntries(c: Campaign): Promise<EntryType[]> {
  const ds = useDataStore()
  const bindings = await db.campaignBindings.where('campaignId').equals(c.id!).toArray()
  const wbIds = bindings.map((b) => b.worldbookId)
  if (c.notebookWorldbookId) wbIds.push(c.notebookWorldbookId)
  const out: EntryType[] = []
  for (const wbId of wbIds) {
    for (const e of ds.entriesOf(wbId)) {
      if (!e.enabled || !e.content.trim()) continue
      if (e.source === 'ai' && e.status !== 'accepted') continue
      out.push(e)
    }
  }
  return out
}

interface FullReply { content: string; usage: any; reasoning?: string }

/** v3.1 剧情态势简报（大整理）数据 */
export interface StoryBrief {
  /** 当前时期（如「斗罗大陆·主世界」） */
  timeline?: string
  /** 玩家位置 */
  position?: string
  /** 当前目标（1-2 句） */
  goal?: string
  /** 最近大事（3-6 条） */
  events?: string[]
  /** 未决悬念（2-4 条） */
  mysteries?: string[]
  /** 焦点角色（名字 + 一句话） */
  focus?: Array<{ name: string; note: string }>
  at: number
}

/** chatCompletion + usage 返回（v2.1 起主链路改用 chatCompletionStream，保留给非流式场景） */
async function chatCompletionFull(api: ApiConfig, messages: ChatUserMessage[]): Promise<FullReply> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${api.apiKey}`,
  }
  if (api.headersJson) {
    try { Object.assign(headers, JSON.parse(api.headersJson)) } catch { /* ignore */ }
  }

  const base = api.baseUrl.replace(/\/+$/, '')
  const body: any = {
    model: api.model,
    messages,
    temperature: api.temperature ?? 1,
    top_p: api.topP ?? 0.95,
    stream: false,
  }
  // 输出上限：0 = 不设限（不传字段）
  const maxTokens = api.maxTokens ?? 4000
  if (maxTokens > 0) body.max_tokens = maxTokens

  const resp = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data = await resp.json()
  const msg = data?.choices?.[0]?.message
  const content = msg?.content
  if (typeof content !== 'string') {
    throw new Error('响应格式异常：缺少 choices[0].message.content')
  }
  return { content, usage: parseUsage(data), reasoning: msg?.reasoning_content ?? '' }
}
