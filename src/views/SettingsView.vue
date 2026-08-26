<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import Icon from '../components/Icon.vue'
import { BUILTIN_NODES } from '../engine/builtinNodes'
import { DEEPSEEK_PRICES, isPeakHour, PRICE_SOURCE_DATE } from '../engine/pricing'
import { checkForUpdate, UPDATE_REPO } from '../engine/updater'
import { exportFile } from '../engine/exportFile'
import PresetPanel from './PresetPanel.vue'
import UpdaterCard from './UpdaterCard.vue'
import type { ApiConfig } from '../types'

const ds = useDataStore()
const chat = useChatStore()
const toast = ref('')
let t: number | undefined
function showToast(m: string) { toast.value = m; clearTimeout(t); t = window.setTimeout(() => toast.value = '', 2200) }

const subTab = ref<'api' | 'preset' | 'stats'>('api')

// ---- 启动自动检查更新 ----
onMountedCheck()
async function onMountedCheck() {
  try {
    await checkForUpdate(UPDATE_REPO, '1.1.1')
  } catch { /* 静默失败，用户可在设置页手动检查 */ }
}

// ---- API 配置编辑 ----
const editing = ref<ApiConfig | null>(null)
const showEditor = ref(false)

function openEditor(cfg?: ApiConfig) {
  editing.value = cfg ? { ...cfg } : {
    name: '', baseUrl: '', apiKey: '', model: '',
    temperature: 1, maxTokens: 4000, topP: 0.95,
    isDefault: !ds.apiConfigs.length ? 1 : 0,
    createdAt: Date.now(),
  }
  showEditor.value = true
}

async function saveCfg() {
  if (!editing.value) return
  const v = editing.value.isDefault ? 1 : 0
  await ds.saveApiConfig({ ...editing.value, isDefault: v })
  showEditor.value = false
  showToast('已保存')
}

async function setDefault(id: number) {
  await ds.saveApiConfig({ ...ds.apiConfigs.find(c => c.id === id)!, isDefault: 1 })
  showToast('已设为默认')
}

/** 一键添加内置节点（跳过低填） */
async function addBuiltin(idx: number) {
  const n = BUILTIN_NODES[idx]
  if (ds.apiConfigs.some((c) => c.baseUrl === n.baseUrl)) {
    showToast('该节点已存在')
    return
  }
  await ds.saveApiConfig({ ...n, name: n.name, createdAt: Date.now(), apiKey: '' })
  showToast(`已添加「${n.name}」，请补填 Key`)
}

// ---- 预设导入 ----
const fileInput = ref<HTMLInputElement>()
async function onPresetFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const imp = await ds.importPresetFromFile(f)
    showToast(`已导入预设「${imp.name}」（${imp.prompts.filter(p => p.enabled).length} 个启用提示词块）`)
  } catch (e: any) {
    showToast('导入失败：' + (e?.message || '格式不对'))
  }
}

// ---- 统计 ----
const globalStats = computed(() => {
  let tokens = 0, cost = 0, rounds = 0
  for (const c of ds.campaigns) {
    tokens += c.statTokens ?? 0
    cost += c.statCostYuan ?? 0
  }
  const msgs = [...chat.talkMessages, ...chat.gameMessages]
  rounds = msgs.filter((m) => m.role === 'assistant').length
  return { tokens, cost, rounds }
})

const nowPeak = computed(() => isPeakHour(new Date()))

// ---- 数据备份 ----
const backupInput = ref<HTMLInputElement>()
async function exportBackup() {
  const dump = {
    version: 1,
    exportedAt: new Date().toISOString(),
    apiConfigs: await db.apiConfigs.toArray(),
    worldbooks: await db.worldbooks.toArray(),
    entries: await db.entries.toArray(),
    campaigns: await db.campaigns.toArray(),
    campaignBindings: await db.campaignBindings.toArray(),
    presets: await db.presets.toArray(),
    messages: await db.messages.toArray(),
    characters: await db.characters.toArray(),
    relations: await db.relations.toArray(),
  }
  const content = JSON.stringify(dump, null, 2)
  await exportFile(`novel-rpg-backup-${Date.now()}.json`, content)
  showToast('已导出备份 JSON')
}

async function onBackupFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  const text = await f.text()
  try {
    const dump = JSON.parse(text)
    if (!confirm('导入备份将【覆盖】当前所有数据（先确认已导出当前数据）。继续？')) return
    await db.delete()   // 清库
    await db.open()
    // 按表恢复
    for (const tbl of ['apiConfigs', 'worldbooks', 'entries', 'campaigns', 'campaignBindings', 'presets', 'messages', 'characters', 'relations'] as const) {
      const rows = dump[tbl]
      if (Array.isArray(rows) && rows.length) {
        await (db[tbl] as any).bulkPut(rows)
      }
    }
    await ds.init()
    showToast('备份已导入，重新加载中…')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    showToast('导入失败：' + (e?.message || '备份文件无效'))
  }
}

const priceRows = Object.entries(DEEPSEEK_PRICES).map(([model, r]) => ({ model, r }))
</script>

<template>
  <div class="page">
    <div class="page-title" style="display:flex; align-items:center; gap:7px"><span style="color:var(--accent-deep); display:flex"><Icon name="gear" :size="18" /></span>设置</div>

    <!-- 子导航 -->
    <div style="display:flex; gap:8px; margin-bottom:14px">
      <button class="btn btn-sm" :class="subTab === 'api' ? 'btn-primary' : 'btn-ghost'" @click="subTab='api'"><Icon name="link" :size="13" /> API</button>
      <button class="btn btn-sm" :class="subTab === 'preset' ? 'btn-primary' : 'btn-ghost'" @click="subTab='preset'"><Icon name="sliders" :size="13" /> 预设</button>
      <button class="btn btn-sm" :class="subTab === 'stats' ? 'btn-primary' : 'btn-ghost'" @click="subTab='stats'">📊 统计</button>
    </div>

    <!-- ===== API 配置 ===== -->
    <template v-if="subTab === 'api'">
      <div class="card">
        <div style="display:flex; align-items:center; margin-bottom:10px">
          <b style="flex:1">🔌 API 配置</b>
          <button class="btn btn-soft btn-sm" @click="openEditor()">＋ 自定义</button>
        </div>

        <!-- 内置节点快捷添加 -->
        <div class="list-sub" style="margin-bottom:6px">快速添加内置节点（Key 自填）：</div>
        <div style="display:flex; gap:8px; margin-bottom:12px">
          <button class="btn btn-ghost btn-sm" @click="addBuiltin(0)">DeepSeek 官方</button>
          <button class="btn btn-ghost btn-sm" @click="addBuiltin(1)">opencode-go 网关</button>
        </div>

        <div v-if="!ds.apiConfigs.length" class="empty-hint" style="padding:16px 0">
          还没有 API 配置<br />上方快速添加或点「＋ 自定义」
        </div>
        <div v-for="c in ds.apiConfigs" :key="c.id" class="list-row" style="padding:10px 2px">
          <div>
            <div class="list-title">
              {{ c.name }}
              <span v-if="c.isDefault" class="entry-tag tag-constant">默认</span>
              <span v-if="!c.apiKey" class="entry-tag tag-trigger">待填 Key</span>
            </div>
            <div class="list-sub">{{ c.model }} · {{ c.baseUrl }} · 输出上限 {{ (c.maxTokens ?? 4000) > 0 ? (c.maxTokens ?? 4000) : '∞' }}</div>
          </div>
          <div style="display:flex; gap:6px">
            <button v-if="!c.isDefault" class="btn btn-ghost btn-sm" @click="setDefault(c.id!)">默认</button>
            <button class="btn btn-soft btn-sm" @click="openEditor(c)">编</button>
            <button class="btn btn-danger btn-sm" @click="ds.deleteApiConfig(c.id!)">删</button>
          </div>
        </div>
      </div>

      <div class="section-gap"></div>

      <!-- 外部预设导入 -->
      <div class="card">
        <div style="display:flex; align-items:center; margin-bottom:10px">
          <b style="flex:1">📜 外部预设（ST 格式）</b>
          <button class="btn btn-soft btn-sm" @click="fileInput?.click()">导入 JSON</button>
          <input ref="fileInput" type="file" accept=".json" style="display:none" @change="onPresetFile" />
        </div>
        <div v-if="!ds.presets.length" class="empty-hint" style="padding:16px 0">
          内置「梦鲸思客·精简」在 预设 Tab 里调，无需导入<br />这里用于导入其他 SillyTavern 预设
        </div>
        <div v-for="p in ds.presets" :key="p.id" class="list-row">
          <div style="flex:1">
            <div class="list-title">{{ p.name }}</div>
            <div class="list-sub">{{ p.sourceName }} · {{ (JSON.parse(p.promptsJson) as any[]).length }} 个提示词块</div>
          </div>
          <button class="btn btn-danger btn-sm" @click="ds.deletePreset(p.id!)">删</button>
        </div>
      </div>

      <div class="section-gap"></div>

      <!-- 版本更新 -->
      <UpdaterCard />

      <div class="section-gap"></div>

      <!-- 数据管理 -->
      <div class="card">
        <div style="margin-bottom:10px"><b>💾 数据管理</b></div>
        <button class="btn btn-ghost btn-block" @click="exportBackup">导出整库备份 JSON</button>
        <button class="btn btn-soft btn-block" style="margin-top:8px" @click="backupInput?.click()">导入备份（覆盖）</button>
        <input ref="backupInput" type="file" accept=".json" style="display:none" @change="onBackupFile" />
        <div class="list-sub" style="margin-top:6px">所有数据仅存在本机（IndexedDB），换机/清缓存前请先导出备份。</div>
      </div>
    </template>

    <!-- ===== 预设开关 ===== -->
    <PresetPanel v-else-if="subTab === 'preset'" />

    <!-- ===== 统计 ===== -->
    <template v-else>
      <div class="card" style="margin-bottom:14px">
        <div class="list-title" style="margin-bottom:8px">📊 用量统计</div>
        <div class="stat-grid">
          <div class="stat-cell">
            <div class="stat-num">{{ (globalStats.tokens / 1000).toFixed(1) }}k</div>
            <div class="list-sub">全局 token</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num">¥{{ globalStats.cost.toFixed(3) }}</div>
            <div class="list-sub">累计金额</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num">{{ globalStats.rounds }}</div>
            <div class="list-sub">本轮数</div>
          </div>
        </div>
        <div class="list-sub" style="margin-top:8px">
          当前为{{ nowPeak ? '高峰' : '空闲' }}时段
          <span v-if="globalStats.cost === 0"> · 金额折算仅 DeepSeek 官方模型</span>
        </div>
      </div>

      <div class="card">
        <div style="margin-bottom:8px"><b>💴 DeepSeek 官方价格表</b></div>
        <div class="list-sub" style="margin-bottom:8px">
          元/百万 token · 空闲 = 高峰×0.5 · 高峰：周一至周五 9-12/14-18 点（北京时间） · 数据抓取于 {{ PRICE_SOURCE_DATE }}
        </div>
        <div style="overflow-x:auto">
          <table class="price-table">
            <tr><th>模型</th><th>输入·命中</th><th>输入·未命中</th><th>输出</th><th>（元/百万token，空闲/高峰）</th></tr>
            <tr v-for="p in priceRows" :key="p.model">
              <td>{{ p.model }}</td>
              <td>{{ p.r.hitIdle }}/{{ p.r.hitPeak }}</td>
              <td>{{ p.r.missIdle }}/{{ p.r.missPeak }}</td>
              <td>{{ p.r.outIdle }}/{{ p.r.outPeak }}</td>
            </tr>
          </table>
        </div>
      </div>
    </template>

    <!-- API 编辑弹层 -->
    <div v-if="showEditor && editing" class="modal-mask" @click.self="showEditor = false">
      <div class="modal-sheet">
        <div class="modal-title">API 配置</div>
        <div class="field"><label>配置名 *</label><input v-model="editing.name" placeholder="如：硅基流动" /></div>
        <div class="field"><label>Base URL *</label><input v-model="editing.baseUrl" placeholder="https://api.example.com/v1" /></div>
        <div class="field"><label>API Key *</label><input v-model="editing.apiKey" type="password" placeholder="sk-…" /></div>
        <div class="field"><label>模型 *（选 DeepSeek 官方模型时自动折算金额）</label><input v-model="editing.model" placeholder="如：deepseek-v4-flash" /></div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px">
          <div class="field"><label>温度</label><input type="number" step="0.1" v-model.number="editing.temperature" /></div>
          <div class="field"><label>Top P</label><input type="number" step="0.05" v-model.number="editing.topP" /></div>
          <div class="field">
            <label>输出上限</label>
            <input type="number" step="1000" v-model.number="editing.maxTokens" />
          </div>
        </div>
        <div class="list-sub" style="margin:-6px 0 10px">
          输出上限填 0 = 不限（不传 max_tokens，用模型默认）；任意正整数透传。
        </div>
        <div class="field" style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" v-model="editing.isDefault" style="width:auto" />
          <label style="margin:0">设为默认配置</label>
        </div>
        <button class="btn btn-primary btn-block" @click="saveCfg">保存</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat-cell { text-align: center; padding: 10px 0; background: var(--bg); border-radius: var(--radius-sm); }
.stat-num { font-size: 20px; font-weight: 700; color: var(--accent-deep); }
.price-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.price-table th, .price-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--line); }
.price-table th { color: var(--ink-soft); font-weight: 600; font-size: 12px; }
</style>
