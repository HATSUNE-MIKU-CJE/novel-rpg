import Dexie, { type Table } from 'dexie'
import type {
  ApiConfig, Worldbook, Entry, Campaign, CampaignBinding,
  Preset, Message, Character, Relation, Op, TrashItem,
} from './types'

class NovelRpgDB extends Dexie {
  apiConfigs!: Table<ApiConfig, number>
  worldbooks!: Table<Worldbook, number>
  entries!: Table<Entry, number>
  campaigns!: Table<Campaign, number>
  campaignBindings!: Table<CampaignBinding, number>
  presets!: Table<Preset, number>
  messages!: Table<Message, number>
  characters!: Table<Character, number>
  relations!: Table<Relation, number>
  /** v1.5：AI 操作审计（协议块 → 临时区 → 确认执行/退回） */
  ops!: Table<Op, number>
  /** v2.0：回收站（删除的世界书条目/角色/关系，可撤销恢复） */
  trash!: Table<TrashItem, number>

  constructor() {
    super('novel-rpg')
    this.version(1).stores({
      apiConfigs: '++id, name, isDefault',
      worldbooks: '++id, name, scope',
      entries: '++id, worldbookId, enabled, source, status',
      campaigns: '++id, name, presetId, lastActive',
      campaignBindings: '++id, campaignId, worldbookId, [campaignId+worldbookId]',
      presets: '++id, name',
      messages: '++id, campaignId, seq, [campaignId+seq]',
      characters: '++id, campaignId, name',
      relations: '++id, campaignId',
    })
    // v1.2：消息双流（talk/game），旧数据 stream 缺省 = game
    this.version(2).stores({
      messages: '++id, campaignId, seq, stream, [campaignId+seq], [campaignId+stream+seq]',
    })
    // v1.5：AI 操作审计表
    this.version(3).stores({
      ops: '++id, campaignId, status, [campaignId+status]',
    })
    // v2.0：回收站表
    this.version(4).stores({
      trash: '++id, campaignId, kind, deletedAt',
    })
    // v3.1：类型化世界书（Entry 加 kind/timeline；索引按类型/时期查询）
    this.version(5).stores({
      entries: '++id, worldbookId, kind, timeline, enabled, source, status, [worldbookId+kind]',
    })
  }
}

export const db = new NovelRpgDB()
