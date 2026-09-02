<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { db } from '../db'
import { useChatStore } from '../stores/chat'
import RadarChart from './RadarChart.vue'
import Icon from '../components/Icon.vue'
import type { AttrSchema } from '../engine/extractor'
import { readBarValues } from '../engine/bars'
import type { BarDef } from '../engine/bars'
import type { Character } from '../types'

const props = defineProps<{ character: Character; schema: AttrSchema; bars?: BarDef[] }>()
const emit = defineEmits<{ close: []; saved: [Character] }>()

const chat = useChatStore()

/** v3.2：所见即所得直改——无「编辑模式」，值即改即存（回车/失焦） */
const draft = ref({ realm: '', description: '', attrs: [] as Array<{ label: string; value: number }> })

/** v3.1：该角色是否绑定人物卡条目（是 → 保存写世界书，否 → 写老 characters 表） */
const entryId = computed(() => (props.character as any).entryId as number | undefined)

/** 状态条数值 */
const barMap = computed<Record<string, number>>(() => readBarValues(props.character.barValuesJson))
const barEdit = ref<Record<string, number>>({ ...barMap.value })
watch(() => props.character, (c) => { barEdit.value = { ...readBarValues(c.barValuesJson) } }, { immediate: true })

/** 旧格式 attributesJson → Map(label → value) */
function parseAttrs(json?: string): Map<string, number> {
  const map = new Map<string, number>()
  if (!json) return map
  try {
    const arr = JSON.parse(json) as Array<{ label?: string; value?: number }>
    if (Array.isArray(arr)) for (const a of arr) if (a?.label) map.set(String(a.label), Number(a.value) || 0)
  } catch { /* ignore */ }
  return map
}

function load() {
  const c = props.character
  const map = parseAttrs(c.attributesJson)
  draft.value = {
    realm: c.realm ?? '',
    description: c.description ?? '',
    attrs: props.schema.dims.map((d) => ({ label: d.label, value: map.get(d.label) ?? 0 })),
  }
}
watch(() => [props.character, props.schema], load, { immediate: true })

/** 展示用雷达数据（schema 顺序） */
const radarAttrs = computed(() =>
  props.schema.dims.map((d) => {
    const v = draft.value.attrs.find((a) => a.label === d.label)?.value ?? 0
    return { label: d.label, value: v }
  }),
)
const realmLabel = computed(() => props.schema.realmLabel ?? '')

/** 该角色参与的关系 */
const relations = ref<Array<{ fromChar: string; toChar: string; relType: string; label?: string }>>([])
watch(
  () => props.character,
  async (c) => {
    const cid = c.campaignId
    if (!cid) { relations.value = []; return }
    const all = await db.relations.where('campaignId').equals(cid).toArray()
    relations.value = all.filter((r) => r.fromChar === c.name || r.toChar === c.name)
  },
  { immediate: true },
)

/** 关联条目：绑定世界书/笔记簿中 key 或 content 含角色名的条目 */
const relatedEntries = ref<Array<{ key: string; content: string; status?: string; category?: string }>>([])
watch(
  () => props.character,
  async (c) => {
    const cid = c.campaignId
    if (!cid) { relatedEntries.value = []; return }
    const { useDataStore } = await import('../stores/data')
    const ds = useDataStore()
    const bs = await db.campaignBindings.where('campaignId').equals(cid).toArray()
    const wbIds = bs.map((b) => b.worldbookId)
    const camp = ds.campaigns.find((x) => x.id === cid)
    if (camp?.notebookWorldbookId) wbIds.push(camp.notebookWorldbookId)
    const hit = new Map<string, { key: string; content: string; status?: string; category?: string }>()
    for (const wid of wbIds) {
      for (const e of ds.entriesOf(wid)) {
        if (!e.enabled || !e.content.trim() || e.status === 'rejected') continue
        const keys = (e.key || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
        if (keys.some((k) => k.includes(c.name)) || e.content.includes(c.name)) {
          hit.set(String(e.id), { key: e.key || '常驻', content: e.content, status: e.status, category: e.category })
        }
      }
    }
    relatedEntries.value = [...hit.values()].slice(0, 8)
  },
  { immediate: true },
)

let saveTimer: number | undefined
/** 直改保存（失焦/回车触发，轻提示不打断） */
async function quickSave() {
  clearTimeout(saveTimer)
  const c = props.character
  const attrs = draft.value.attrs.filter((a) => a.label.trim() && a.value > 0).map((a) => ({ label: a.label, value: a.value }))
  if (entryId.value) {
    await chat.patchCharacterEntry(entryId.value, {
      realm: draft.value.realm.trim() || undefined,
      behavior: draft.value.description.trim() || undefined,
      attributes: attrs,
      barValues: { ...barEdit.value },
    })
  } else {
    const updated: Character = {
      ...c,
      barValuesJson: JSON.stringify(barEdit.value),
      realm: draft.value.realm.trim() || undefined,
      description: draft.value.description.trim(),
      attributesJson: JSON.stringify(attrs),
      updatedAt: Date.now(),
    }
    await db.characters.put(JSON.parse(JSON.stringify(updated)))
    emit('saved', updated)
  }
  emit('saved', { ...props.character })
}
/** 数值输入：数字变化即保存（小延迟合并） */
function onValueChange() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { quickSave() }, 600)
}
</script>

<template>
  <div class="modal-full">
    <div style="display:flex; align-items:center; gap:12px; max-width:640px; margin:0 auto">
      <div class="char-avatar" style="width:56px; height:56px; font-size:25px; margin:0; flex-shrink:0">
        {{ character.name.slice(0, 1) }}
      </div>
      <div style="flex:1; min-width:0">
        <div style="font-size:19px; font-weight:700">{{ character.name }}</div>
        <div class="list-sub">
          {{ character.identity || '身份未知' }} ·
          <template v-if="realmLabel && character.realm">{{ realmLabel }}：{{ character.realm }} · </template>
          {{ character.source === 'ai' ? 'AI 提取' : (character.source === 'imported' ? '导入' : '手动') }}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="emit('close')">✕</button>
    </div>

    <!-- 六维能力雷达（直改：数值输入框常显） -->
    <div style="max-width:640px; margin:10px auto 0" class="card">
      <label style="display:block; font-size:13px; font-weight:600; color:var(--ink-soft); margin-bottom:6px">
        🧭 能力雷达{{ realmLabel ? ` · ${realmLabel}` : '' }}
      </label>
      <RadarChart :attrs="radarAttrs" :max="(schema.maxValue ?? 10)" />
      <div class="attr-edit-list">
        <label style="font-size:13px; font-weight:600; color:var(--ink-soft); margin:8px 0 4px">数值（点数字即改，鼠标移开自动保存）</label>
        <div v-for="a in draft.attrs" :key="a.label" class="attr-edit-row">
          <span style="flex:1; font-size:14px; font-weight:600">{{ a.label }}</span>
          <input v-model.number="a.value" type="number" min="0" :max="(schema.maxValue ?? 10)" style="width:70px" @change="onValueChange" />
        </div>
        <div v-if="realmLabel" class="field" style="margin-top:10px">
          <label>{{ realmLabel }}（点即改）</label>
          <input v-model="draft.realm" :placeholder="`如：金丹期 / 见习法师`" @change="onValueChange" />
        </div>
      </div>
    </div>

    <!-- 状态条（直改） -->
    <div v-if="(bars || []).length" class="card" style="max-width:640px; margin:12px auto 0">
      <label style="display:flex; align-items:center; gap:5px; font-size:13px; font-weight:600; color:var(--ink-soft); margin-bottom:6px"><Icon name="sliders" :size="15" /> 状态条（点数字即改）</label>
      <div v-for="b in bars" :key="b.id" class="hud-row">
        <span class="hud-name">{{ b.name }}</span>
        <div class="bar-track" style="flex:1">
          <div class="bar-fill" :style="{ width: Math.min(100, ((barMap[b.name] ?? 0) / b.max) * 100) + '%', background: b.color }"></div>
        </div>
        <input
          v-model.number="barEdit[b.name]"
          type="number" min="0" :max="b.max" style="width:70px"
          @change="onValueChange"
        />
        <span class="hud-val">/{{ b.max }}</span>
      </div>
    </div>

    <!-- 描述（直改） -->
    <div class="card" style="max-width:640px; margin:12px auto 0">
      <label style="display:flex; align-items:center; gap:5px; font-size:13px; font-weight:600; color:var(--ink-soft); margin-bottom:6px"><Icon name="doc" :size="15" /> 描述（点即改）</label>
      <textarea v-model="draft.description" rows="4" @change="onValueChange"></textarea>
    </div>

    <!-- 关系 -->
    <div v-if="relations.length" class="card" style="max-width:640px; margin:12px auto 0">
      <label style="display:flex; align-items:center; gap:5px; font-size:13px; font-weight:600; color:var(--ink-soft); margin-bottom:6px"><Icon name="network" :size="15" /> 关系</label>
      <div v-for="(r, i) in relations" :key="i" class="rel-line">
        {{ r.toChar === character.name ? '←' : '→' }} {{ r.toChar === character.name ? r.fromChar : r.toChar }}
        <span class="list-sub">（{{ r.relType }} {{ r.label || '' }}）</span>
      </div>
    </div>

    <!-- 关联世界书 -->
    <div v-if="relatedEntries.length" class="card" style="max-width:640px; margin:12px auto 0">
      <label style="display:flex; align-items:center; gap:5px; font-size:13px; font-weight:600; color:var(--ink-soft); margin-bottom:6px"><Icon name="library" :size="15" /> 关联世界书</label>
      <div v-for="(e, i) in relatedEntries" :key="i" class="entry-item" style="padding:6px 2px">
        <span class="entry-tag" :class="e.key === '常驻' ? 'tag-constant' : 'tag-trigger'">{{ e.key === '常驻' ? '常驻' : e.key.slice(0, 8) }}</span>
        <div class="list-sub" style="white-space:pre-wrap; flex:1">{{ e.content.slice(0, 60) }}{{ e.content.length > 60 ? '…' : '' }}</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'CharacterDetail' }
</script>
