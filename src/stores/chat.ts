import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { db } from '../db'
import type { Message, Campaign, ApiConfig, Entry, Worldbook } from '../types'
import { useDataStore } from './data'
import { renderPromptChain, chatCompletion, type ChatUserMessage } from '../engine/pipeline'
import { parseDreamPlot } from '../engine/dreamParser'
import { buildDreamPromptBlocks, defaultDreamConfig, type DreamConfig } from '../engine/dreamPreset'
import { parseUsage, estimateCostYuan } from '../engine/pricing'
import { extractFacts } from '../engine/extractor'
import { httpFetch } from '../engine/http'

/** 剥离 Vue 响应式代理，得到 IndexedDB 可序列化的纯对象 */
function plainMsg<T>(obj: T): T {
  return JSON.parse(JSON.stringify(toRaw(obj)))
}

/** 消息正文（assistant 取解析后的 body） */
function bodyOfMsg(m: Message): string {
  if (m.role === 'user') return m.content
  try {
    const p = m.parsedJson ? JSON.parse(m.parsedJson) : null
    return p?.body || m.content
  } catch { return m.content }
}

/** 上下文压缩：预算内 80% 触发 */
export const COMPACT_RATIO = 0.8

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as Message[],
    currentCampaignId: 0,
    sending: false,
    compacting: false,
    organizing: false,
    error: '' as string,
  }),
  getters: {
    currentCampaign(state): Campaign | undefined {
      const ds = useDataStore()
      return ds.campaigns.find((c) => c.id === state.currentCampaignId)
    },
    /** 存档累计 token */
    totalTokens(state): number {
      let n = 0
      for (const m of state.messages) {
        try {
          const u = m.usageJson ? JSON.parse(m.usageJson) : null
          if (u?.totalTokens) n += u.totalTokens
        } catch { /* ignore */ }
      }
      return n
    },
    /** 存档累计金额（仅 DeepSeek 折算） */
    totalCost(state): number {
      let c = 0
      for (const m of state.messages) {
        try {
          const u = m.usageJson ? JSON.parse(m.usageJson) : null
          if (u?.costYuan) c += u.costYuan
        } catch { /* ignore */ }
      }
      return Math.round(c * 10000) / 10000
    },
  },
  actions: {
    async openCampaign(id: number) {
      this.currentCampaignId = id
      this.messages = await db.messages.where('campaignId').equals(id).sortBy('seq')
    },

    /** 计算本轮命中的触发条目（触发词出现在最近 N 条消息中） */
    collectInjectedEntries(worldbookIds: number[]): { constant: Entry[]; keyed: Entry[] } {
      const ds = useDataStore()
      const constant: Entry[] = []
      const keyed: Entry[] = []
      const recentText = this.messages
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

    /** 获取渲染用 prompts 序列（内置预设 > 外部预设 > 简易兜底） */
    async resolvePrompts(): Promise<Array<{ name: string; role: string; content: string; enabled: boolean }>> {
      const ds = useDataStore()
      const campaign = this.currentCampaign!
      const cfg = this.dreamConfig()
      if (cfg) {
        // 自动渠道：需要模型名判断思考标记
        const api = ds.getDefaultApi()
        return buildDreamPromptBlocks(cfg, api?.model ?? '')
      }
      if (campaign.presetId) {
        const preset = ds.presets.find((p) => p.id === campaign.presetId)
        if (preset) return JSON.parse(preset.promptsJson)
      }
      return [{ name: 'default', role: 'system', content: '你是小说叙事 AI，请用中文推进故事。', enabled: true }]
    },

    /** 主请求：发送用户消息 */
    async sendUserMessage(text: string) {
      if (!this.currentCampaignId || !text.trim() || this.sending) return
      const ds = useDataStore()
      const campaign = ds.campaigns.find((c) => c.id === this.currentCampaignId)
      if (!campaign) { this.error = '存档不存在'; return }
      const api = ds.getDefaultApi()
      if (!api) { this.error = '请先在设置中配置 API'; return }
      if (!api.apiKey) { this.error = `「${api.name}」还未填写 API Key，去设置里填一下`; return }

      this.error = ''

      const maxSeq = this.messages.length ? this.messages[this.messages.length - 1].seq : 0
      const userMsg: Message = {
        campaignId: this.currentCampaignId,
        role: 'user',
        content: text.trim(),
        seq: maxSeq + 1,
        createdAt: Date.now(),
      }
      await db.messages.add(userMsg)
      this.messages.push({ ...userMsg, id: (userMsg as any).id })

      await this.requestAssistant(campaign, api)
    },

    /** 手动重发：删除某轮的最后一条 assistant（及其后续），重新请求 */
    async regenerate() {
      const campaign = this.currentCampaign
      if (!campaign || this.sending) return
      const last = [...this.messages].reverse().find((m) => m.role === 'assistant')
      if (!last) return
      // 删除该条 assistant 及其后的所有消息
      const doomed = this.messages.filter((m) => (m.seq ?? 0) >= (last.seq ?? 0))
      await db.messages.bulkDelete(doomed.map((m) => m.id!).filter(Boolean))
      this.messages = this.messages.filter((m) => (m.seq ?? 0) < (last.seq ?? 0))
      const api = useDataStore().getDefaultApi()
      if (!api) { this.error = '请先配置 API'; return }
      await this.requestAssistant(campaign, api)
    },

    /** 共享助理请求逻辑（含：上下文压缩检测 + usage 记录 + 统计） */
    async requestAssistant(campaign: Campaign, api: ApiConfig) {
      const ds = useDataStore()
      const prompts = await this.resolvePrompts()

      const bindings = await db.campaignBindings.where('campaignId').equals(this.currentCampaignId).toArray()
      const wbIds = bindings.map((b) => b.worldbookId)
      // 自动笔记簿始终参与注入（其内 pending 条目已被过滤）
      if (campaign.notebookWorldbookId) wbIds.push(campaign.notebookWorldbookId)
      const { constant, keyed } = this.collectInjectedEntries(wbIds)

      // 变量存储
      const vars = new Map<string, string>()
      try { Object.entries(JSON.parse(campaign.varsJson || '{}')).forEach(([k, v]) => vars.set(k, String(v))) } catch { /* ignore */ }
      const persistVars = () => {
        campaign.varsJson = JSON.stringify(Object.fromEntries(vars))
        ds.saveCampaign(campaign)
      }

      // 上下文：摘要 + 未压缩历史
      let history = this.messages.filter((m) => m.role !== 'system')
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

      this.sending = true
      try {
        const reply = await chatCompletionFull(api, msgs)
        const parsed = parseDreamPlot(reply.content)
        const usage = reply.usage
        const cost = usage && estimateCostYuan(api.model, usage, new Date())

        const costYuan = cost?.costYuan
        const maxSeq = this.messages.length ? this.messages[this.messages.length - 1].seq : 0
        const asstMsg: Message = {
          campaignId: this.currentCampaignId,
          role: 'assistant',
          content: reply.content,
          parsedJson: JSON.stringify(parsed),
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
        await db.messages.add(asstMsg)
        this.messages.push({ ...asstMsg, id: (asstMsg as any).id })

        // 统计累计
        if (usage) {
          campaign.statTokens = (campaign.statTokens ?? 0) + usage.totalTokens
          if (costYuan) campaign.statCostYuan = (campaign.statCostYuan ?? 0) + costYuan
        }
        campaign.lastActive = Date.now()
        await ds.saveCampaign(campaign)

        // 自动上下文压缩检测（80% 预算）
        if (usage && campaign.ctxBudget && campaign.ctxBudget > 0) {
          if (usage.promptTokens > campaign.ctxBudget * COMPACT_RATIO) {
            this.compactContext(campaign)
          }
        }

        // M4：每 N 轮自动整理世界书（异步，不阻塞）
        const interval = campaign.autoInterval ?? 0
        if (interval > 0 && !this.organizing) {
          // 距上次整理已超过 N 轮用户消息，或从未整理过
          const lastOrg = campaign.lastOrganized ?? 0
          const need = (() => {
            const recentUsers = this.messages
              .filter((m) => m.role === 'user' && m.createdAt > lastOrg).length
            return recentUsers >= interval
          })()
          if (need) this.organizeWorldbook()
        }
      } catch (e: any) {
        this.error = e?.message || String(e)
      } finally {
        this.sending = false
      }
    },

    /**
     * 上下文压缩：把已压缩点之前的消息摘要为一段文本。
     * 触发：手动 或 自动（预算 80%）。
     */
    async compactContext(campaign?: Campaign) {
      const c = campaign ?? this.currentCampaign
      if (!c || this.compacting) return
      const ds = useDataStore()
      const api = ds.getDefaultApi()
      if (!api) { this.error = '压缩需要 API 配置'; return }

      const cutoff = c.summarizedSeq ?? 0
      const toSummarize = this.messages.filter((m) => (m.seq ?? 0) > cutoff && m.role !== 'system')
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
          .map((m) => (m.role === 'user' ? `梦客：${m.content}` : `思客：${m.content}`))
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
        this.messages = this.messages.filter((m) => !doomedIds.includes(m.id!))
      } catch (e: any) {
        this.error = `压缩失败：${e?.message || e}`
      } finally {
        this.compacting = false
      }
    },

    /**
     * M4：整理世界书（AI 事实提取 → 自动笔记簿 pending 条目 + 角色/关系增量更新）。
     * 手动按钮与「每 N 轮自动触发」都走这个入口。
     */
    async organizeWorldbook(): Promise<void> {
      if (!this.currentCampaignId || this.sending || this.compacting) return
      const ds = useDataStore()
      const campaign = this.currentCampaign
      if (!campaign) return
      const api = ds.getDefaultApi()
      if (!api || !api.apiKey) {
        this.error = '整理世界书需要 API 配置'
        return
      }

      this.organizing = true
      this.error = ''
      try {
        // 1. 最近对话文本（最近 24 条，取解析后的正文）
        const recent = this.messages.slice(-24)
        const recentText = recent.map((m) =>
          m.role === 'user' ? `梦客：${m.content}` : `思客：${bodyOfMsg(m)}`,
        ).join('\n\n')
        if (!recentText.trim()) return

        // 2. 已有实体（增量去重）
        const chars = await db.characters.where('campaignId').equals(this.currentCampaignId).toArray()
        const rels = await db.relations.where('campaignId').equals(this.currentCampaignId).toArray()
        const notebook = await this.ensureNotebook()
        const notebookEntries = db.entries && notebook.id
          ? ds.entriesOf(notebook.id)
          : []

        const result = await extractFacts(api, {
          characters: chars.map((c) => c.name),
          relations: rels.map((r) => `${r.fromChar}|${r.toChar}|${r.relType}`),
          facts: notebookEntries.filter((e) => e.source !== 'ai' || e.status === 'accepted').map((e) => e.key),
          recentText,
        })

        // 3. 写角色（按名字增量更新）
        let newChars = 0, updChars = 0
        for (const c of result.characters) {
          const exist = chars.find((x) => x.name === c.name)
          if (exist) {
            if (c.description && c.description !== exist.description) {
              exist.description = c.description
              exist.identity = c.identity ?? exist.identity
              exist.updatedAt = Date.now()
              await db.characters.put(plainMsg(exist))
              updChars++
            }
          } else {
            await db.characters.add(plainMsg({
              campaignId: this.currentCampaignId,
              name: c.name, identity: c.identity ?? '', description: c.description ?? '',
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
            enabled: 1,
            source: 'ai',
            status: 'pending',
            createdAt: Date.now(), updatedAt: Date.now(),
          }))
          newFacts++
        }

        campaign.lastOrganized = Date.now()
        campaign.organizeStats = JSON.stringify({
          chars: newChars + updChars, rels: newRels, facts: newFacts, at: Date.now(),
        })
        await ds.saveCampaign(campaign)
        await ds.loadAll()
      } catch (e: any) {
        this.error = `整理失败：${e?.message || e}`
      } finally {
        this.organizing = false
      }
    },

    /** 获取/创建存档专属的「自动笔记簿」世界书 */
    async ensureNotebook() {
      const ds = useDataStore()
      const c = this.currentCampaign!
      if (c.notebookWorldbookId) {
        const wb = ds.worldbooks.find((w) => w.id === c.notebookWorldbookId)
        if (wb) return wb
      }
      const wb: Worldbook = {
        name: `${c.name} · 自动笔记簿`,
        description: 'AI 提取的世界书事实（审阅后生效）',
        scope: 'campaign',
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

interface FullReply { content: string; usage: any }

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
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('响应格式异常：缺少 choices[0].message.content')
  }
  return { content, usage: parseUsage(data) }
}
