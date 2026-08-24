import Dexie, { type Table } from 'dexie'
import type {
  ApiConfig, Worldbook, Entry, Campaign, CampaignBinding,
  Preset, Message, Character, Relation,
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
  }
}

export const db = new NovelRpgDB()
