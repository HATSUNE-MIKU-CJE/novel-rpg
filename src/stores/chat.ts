import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { db } from '../db'
import type { Message, Campaign, ApiConfig, Entry, StreamKind } from '../types'
import { useDataStore } from './data'
import { renderPromptChain, chatCompletion, type ChatUserMessage } from '../engine/pipeline'
import { parseDreamPlot } from '../engine/dreamParser'
import { buildDreamPromptBlocks, defaultDreamConfig, TALK_SYSTEM, type DreamConfig } from '../engine/dreamPreset'
import { parseUsage, estimateCostYuan } from '../engine/pricing'
import {
  extractFacts, extractJson, mergeAttrs, applyRenames, normCategory,
  parseAttrSchema, attrSchemaJson, type AttrSchema,
} from '../engine/extractor'
import { parseOps, opGroup, resolveRefs, type OpBlock } from '../engine/ops'
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
    compacting: false,
    organizing: false,
    /** 上一轮交流 AI 提交的操作数（UI 提示用） */
    lastOpCount: 0,
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
      const chars = await db.characters.where('campaignId').equals(c.id).toArray()
      const lines = chars.map((ch) =>
        `【角色卡 · ${ch.name}】${ch.identity ? ch.identity + '。' : ''}${ch.description ?? ''}`.trim()
      )
      return lines.join('\n')
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

    /** v1.3：保存属性体系 */
    async saveAttrSchema(s: AttrSchema) {
      const c = this.currentCampaign
      if (!c) return
      c.attrSchemaJson = attrSchemaJson(s)
      await useDataStore().saveCampaign(c)
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
        const lines = entries.map((e, i) => `【${i + 1}】${e.category || '其他'}·${e.key || '常驻'}：${e.content}`)
        const charText = await this.charCardsText()
        if (charText) lines.push(charText)
        const schema = this.attrSchema()
        lines.push(`【当前属性体系】${schema.dims.map((d) => d.label).join('、')}${schema.realmLabel ? `（${schema.realmLabel}）` : ''}`)
        if (lines.length) parts.push(`【当前已生效的设定参考】\n${lines.join('\n').slice(0, 8000)}`)
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
      for (const m of this.talkMessages) {
        if (m.role === 'system') continue
        msgs.push({ role: m.role as 'user' | 'assistant', content: m.content })
      }
      await this.chatCompletionAndAppend(msgs, campaign, api, 'talk')
    },

    /** 游戏流请求：完整预设链 + 世界书注入 + 变量宏 */
    async requestGame(campaign: Campaign, api: ApiConfig) {
      const prompts = await this.resolveGamePrompts()

      const bindings = await db.campaignBindings.where('campaignId').equals(this.currentCampaignId).toArray()
      const wbIds = bindings.map((b) => b.worldbookId)
      // 自动笔记簿始终参与注入（其内 pending 条目已被过滤）
      if (campaign.notebookWorldbookId) wbIds.push(campaign.notebookWorldbookId)
      const { constant, keyed } = this.collectInjectedEntries(wbIds)
      // v1.2：角色卡注入开关（默认开）
      if ((campaign.charInject ?? 1) !== 0) {
        const charText = await this.charCardsText()
        if (charText) {
          constant.push({
            worldbookId: campaign.notebookWorldbookId ?? 0,
            key: '', content: charText, enabled: 1, source: 'manual',
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
      const historyForRender = history.map((m) => ({ ...m }))
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
    },

    /** 请求 + 落库 + 统计（两流共用）；talk 流解析 AI 操作块 → 写入操作审计 */
    async chatCompletionAndAppend(msgs: ChatUserMessage[], campaign: Campaign, api: ApiConfig, stream: StreamKind): Promise<number> {
      this.sending = true
      try {
        const reply = await chatCompletionFull(api, msgs)
        const parsed = stream === 'game' ? parseDreamPlot(reply.content) : null
        const usage = reply.usage
        const cost = usage && estimateCostYuan(api.model, usage, new Date())
        const costYuan = cost?.costYuan

        // v1.5：交流流解析 AI 操作块 → 临时区审计；ref 编号就地解析为 entryId
        let content = reply.content
        let opCount = 0
        if (stream === 'talk') {
          const r = parseOps(reply.content)
          content = r.clean
          if (r.ops.length) {
            const refs = await this.buildSettingRefs()
            for (const o of resolveRefs(r.ops, refs)) {
              await db.ops.add(plainMsg({
                campaignId: this.currentCampaignId,
                kind: o.op,
                payload: JSON.stringify(o),
                status: 'pending',
                createdAt: Date.now(),
              }))
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

        // 统计累计
        if (usage) {
          campaign.statTokens = (campaign.statTokens ?? 0) + usage.totalTokens
          if (costYuan) campaign.statCostYuan = (campaign.statCostYuan ?? 0) + costYuan
        }
        campaign.lastActive = Date.now()
        await ds().saveCampaign(campaign)

        // 自动上下文压缩检测（80% 预算，仅游戏流有摘要机制）
        if (stream === 'game' && usage && campaign.ctxBudget && campaign.ctxBudget > 0) {
          if (usage.promptTokens > campaign.ctxBudget * COMPACT_RATIO) {
            this.compactContext(campaign)
          }
        }
        this.lastOpCount = opCount
        return opCount
      } catch (e: any) {
        this.error = e?.message || String(e)
        return 0
      } finally {
        this.sending = false
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

    /** 执行操作主逻辑（确认时调用） */
    async applyOp(p: OpBlock): Promise<boolean> {
      const ds = useDataStore()
      const c = this.currentCampaign
      if (!c?.id) return false
      try {
        switch (p.op) {
          case 'entry.upsert': {
            const notebook = await this.ensureNotebook()
            // 优先 entryId（ref 已解析）；回退 key 匹配
            const exist = p.entryId
              ? await db.entries.get(p.entryId)
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
     * 上下文压缩：把已压缩点之前的消息摘要为一段文本（游戏流专用）。
     */
    async compactContext(campaign?: Campaign) {
      const c = campaign ?? this.currentCampaign
      if (!c || this.compacting) return
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api) { this.error = '压缩需要 API 配置'; return }

      const cutoff = c.summarizedSeq ?? 0
      const toSummarize = this.gameMessages.filter((m) => (m.seq ?? 0) > cutoff && m.role !== 'system')
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
        c.summary = summary.trim()
        c.summarizedSeq = Math.max(c.summarizedSeq ?? 0, newCutoff)
        await ds.saveCampaign(c)

        // 清理被压缩的消息（保留最近 keep 条）
        const doomedIds = compactArr.map((m) => m.id!).filter(Boolean)
        if (doomedIds.length) await db.messages.bulkDelete(doomedIds)
        this.gameMessages = this.gameMessages.filter((m) => !doomedIds.includes(m.id!))
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
        })

        // 0. 角色改名/合并：先把旧卡名更正（关系两端同步迁移），后续写入按新名匹配
        if ((result.renames ?? []).length) {
          const rm = applyRenames(chars, rels, result.renames)
          for (const c of rm.changedChars) await db.characters.put(plainMsg(c))
          for (const r of rm.changedRels) await db.relations.put(plainMsg(r))
          for (const d of rm.deletedChars) if (d.id) await db.characters.delete(d.id)
        }

        // 3. 写角色（按名字增量更新，属性合并；属性只保留存档维度）
        let newChars = 0, updChars = 0
        for (const c of result.characters) {
          // 改名后旧名条目丢弃（AI 应只用新名输出）
          if ((result.renames ?? []).some((r) => r.from === c.name)) continue
          const exist = chars.find((x) => x.name === c.name)
          const dimAttrs = (c.attributes ?? []).filter((a) => dimLabels.includes(a.label))
          const attrsJson = mergeAttrs(exist?.attributesJson, dimAttrs)
          if (exist) {
            const changed = (c.description && c.description !== exist.description)
              || (c.identity && c.identity !== exist.identity)
              || (c.realm && c.realm !== exist.realm)
              || (attrsJson !== exist.attributesJson)
            if (changed) {
              if (c.description) exist.description = c.description
              if (c.identity) exist.identity = c.identity
              if (c.realm) exist.realm = c.realm
              if (attrsJson !== undefined) exist.attributesJson = attrsJson
              exist.source = exist.source || 'ai'
              exist.updatedAt = Date.now()
              await db.characters.put(plainMsg(exist))
              updChars++
            }
          } else {
            await db.characters.add(plainMsg({
              campaignId: this.currentCampaignId,
              name: c.name, identity: c.identity ?? '', realm: c.realm,
              description: c.description ?? '',
              attributesJson: attrsJson,
              source: 'ai', createdAt: Date.now(), updatedAt: Date.now(),
            }))
            newChars++
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

        // 5. 写自动笔记簿条目（pending 待审阅）
        let newFacts = 0
        for (const f of result.facts) {
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

        if (source === 'talk') campaign.lastSyncedTalkSeq = recent[recent.length - 1].seq
        else campaign.lastSyncedGameSeq = recent[recent.length - 1].seq
        campaign.lastOrganized = Date.now()
        campaign.organizeStats = JSON.stringify({
          chars: newChars + updChars, rels: newRels, facts: newFacts, at: Date.now(),
        })
        await ds.saveCampaign(campaign)
        await ds.loadAll()
        return { chars: newChars + updChars, rels: newRels, facts: newFacts, skipped: false }
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

/** chatCompletion + usage 返回 */
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
