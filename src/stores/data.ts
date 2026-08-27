import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { db } from '../db'
import type { ApiConfig, Preset, Worldbook, Entry, Campaign, TrashItem } from '../types'
import { parseStPresetJson, type ImportedPreset } from '../engine/presetImport'
import { seedBuiltinNodes } from '../engine/builtinNodes'
import { defaultDreamConfig, DREAM_PRESET_NAME } from '../engine/dreamPreset'

/** 剥离 Vue 响应式代理，得到 IndexedDB 可序列化的纯对象 */
function plain<T>(obj: T): T {
  return JSON.parse(JSON.stringify(toRaw(obj)))
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
    async loadAll() {
      const [apiConfigs, presets, worldbooks, entries, campaigns, trashed] = await Promise.all([
        db.apiConfigs.toArray(),
        db.presets.toArray(),
        db.worldbooks.toArray(),
        db.entries.toArray(),
        db.campaigns.toArray(),
        db.trash.orderBy('deletedAt').reverse().limit(20).toArray(),
      ])
      this.apiConfigs = apiConfigs
      this.presets = presets
      this.worldbooks = worldbooks
      this.entries = entries
      this.campaigns = campaigns
      this.trashed = trashed
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
     */
    async importWorldbookJson(text: string, wbNameHint?: string, campaignId?: number) {
      const data = JSON.parse(text)
      const wbMeta = data.worldbook ?? {}
      const name = String(wbMeta.name ?? wbNameHint ?? '导入的世界书').trim() || '导入的世界书'

      // 创世界书
      const wb: Worldbook = {
        name,
        description: wbMeta.description ?? '',
        scope: 'global',
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      const wbId = await db.worldbooks.add(wb)

      // entries：支持 keys 数组（ST）或 key 字符串（本规范）
      let entryCount = 0
      const entries = Array.isArray(data.entries) ? data.entries : []
      for (const e of entries) {
        if (!e || !e.content) continue
        let key = ''
        if (Array.isArray(e.keys) && e.keys.length) key = e.keys.map(String).join(',')
        else if (Array.isArray(e.entry_keys) && e.entry_keys.length) key = e.entry_keys.map(String).join(',')
        else if (e.key) key = Array.isArray(e.key) ? e.key.map(String).join(',') : String(e.key)
        // ST：constant=true → 常驻（key 置空）
        if (e.constant === true || e.constant === 'true') key = ''
        await db.entries.add(plain({
          worldbookId: wbId,
          key,
          content: String(e.content),
          enabled: e.enabled === false ? 0 : 1,
          source: 'imported',
          createdAt: Date.now(), updatedAt: Date.now(),
        }))
        entryCount++
      }

      // characters / relations（可选）
      let charCount = 0, relCount = 0
      if (campaignId && Array.isArray(data.characters)) {
        for (const c of data.characters) {
          if (!c?.name) continue
          await db.characters.add(plain({
            campaignId,
            name: String(c.name),
            identity: c.identity ? String(c.identity) : '',
            description: c.description ? String(c.description) : '',
            source: 'ai',
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
      return { wbId, entryCount, charCount, relCount }
    },
  },
})
