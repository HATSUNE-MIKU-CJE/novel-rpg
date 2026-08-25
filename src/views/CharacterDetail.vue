<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { db } from '../db'
import RadarChart from './RadarChart.vue'
import type { Character } from '../types'

const props = defineProps<{ character: Character }>()
const emit = defineEmits<{ close: []; saved: [Character] }>()

interface AttrRow { label: string; value: number }

const editing = ref(false)
const draft = ref({ name: '', identity: '', description: '', attrs: [] as AttrRow[] })

function parseAttrs(json?: string): AttrRow[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as AttrRow[]
    return Array.isArray(arr) ? arr.filter((a) => a?.label) : []
  } catch { return [] }
}

function load() {
  const c = props.character
  draft.value = {
    name: c.name,
    identity: c.identity ?? '',
    description: c.description ?? '',
    attrs: parseAttrs(c.attributesJson),
  }
}
watch(() => props.character, load, { immediate: true })

const attrs = computed(() => draft.value.attrs)

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

/** 关联条目：笔记簿/绑定世界书中 key 含角色名、或 content 含角色名的条目 */
const relatedEntries = ref<Array<{ key: string; content: string; status?: string }>>([])
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
    const hit = new Map<string, { key: string; content: string; status?: string }>()
    for (const wid of wbIds) {
      for (const e of ds.entriesOf(wid)) {
        if (!e.enabled || !e.content.trim() || e.status === 'rejected') continue
        const keys = (e.key || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
        if (keys.some((k) => k.includes(c.name)) || e.content.includes(c.name)) {
          hit.set(String(e.id), { key: e.key || '常驻', content: e.content, status: e.status })
        }
      }
    }
    relatedEntries.value = [...hit.values()].slice(0, 8)
  },
  { immediate: true },
)

function addAttr() {
  draft.value.attrs.push({ label: '', value: 5 })
}
function delAttr(i: number) {
  draft.value.attrs.splice(i, 1)
}

async function save() {
  const c = props.character
  const attrsJson = JSON.stringify(draft.value.attrs.filter((a) => a.label.trim()))
  const updated: Character = {
    ...c,
    identity: draft.value.identity.trim(),
    description: draft.value.description.trim(),
    attributesJson: attrsJson,
    updatedAt: Date.now(),
  }
  await db.characters.put(JSON.parse(JSON.stringify(updated)))
  editing.value = false
  emit('saved', updated)
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet char-detail">
      <div style="display:flex; align-items:center; gap:12px">
        <div class="char-avatar" style="width:52px; height:52px; font-size:23px; margin:0">
          {{ character.name.slice(0, 1) }}
        </div>
        <div style="flex:1; min-width:0">
          <div class="modal-title" style="text-align:left; margin-bottom:2px">{{ character.name }}</div>
          <div class="list-sub">{{ character.identity || '身份未知' }} · {{ character.source === 'ai' ? 'AI 提取' : '手动' }}</div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="emit('close')">×</button>
      </div>

      <!-- 属性雷达 -->
      <div v-if="attrs.length" class="field" style="margin-top:12px">
        <label>🧭 面板属性 <span v-if="editing" class="list-sub">（点击数值编辑）</span></label>
        <RadarChart :attrs="attrs" />
      </div>
      <div v-else-if="!editing" class="list-sub" style="margin-top:12px">
        暂未提取到属性 —— 点下方「编辑」可手动添加
      </div>

      <!-- 属性编辑 -->
      <div v-if="editing" class="field" style="margin-top:10px">
        <div v-for="(a, i) in draft.attrs" :key="i" class="attr-edit-row">
          <input v-model="a.label" placeholder="属性名" style="flex:1" />
          <input v-model.number="a.value" type="number" min="0" max="10" style="width:64px" />
          <button class="btn btn-ghost btn-sm" @click="delAttr(i)">✗</button>
        </div>
        <button class="btn btn-soft btn-sm" style="margin-top:6px" @click="addAttr">＋ 属性</button>
      </div>

      <!-- 描述 -->
      <div class="field" style="margin-top:10px">
        <label>📝 描述</label>
        <textarea v-if="editing" v-model="draft.description" rows="4"></textarea>
        <div v-else class="char-desc">{{ character.description || '暂无描述' }}</div>
      </div>

      <!-- 关系 -->
      <div v-if="relations.length" class="field">
        <label>🕸 关系</label>
        <div v-for="(r, i) in relations" :key="i" class="rel-line">
          {{ r.toChar === character.name ? '←' : '→' }} {{ r.toChar === character.name ? r.fromChar : r.toChar }}
          <span class="list-sub">（{{ r.relType }} {{ r.label || '' }}）</span>
        </div>
      </div>

      <!-- 关联条目 -->
      <div v-if="relatedEntries.length" class="field">
        <label>📚 关联世界书</label>
        <div v-for="(e, i) in relatedEntries" :key="i" class="entry-item" style="padding:6px 2px">
          <span class="entry-tag" :class="e.key === '常驻' ? 'tag-constant' : 'tag-trigger'">{{ e.key === '常驻' ? '常驻' : e.key.slice(0, 8) }}</span>
          <div class="list-sub" style="white-space:pre-wrap; flex:1">{{ e.content.slice(0, 60) }}{{ e.content.length > 60 ? '…' : '' }}</div>
        </div>
      </div>

      <div style="display:flex; gap:10px; margin-top:8px">
        <template v-if="editing">
          <button class="btn btn-ghost" style="flex:1" @click="editing = false">取消</button>
          <button class="btn btn-primary" style="flex:2" @click="save">保存</button>
        </template>
        <button v-else class="btn btn-warm btn-block" @click="editing = true">✏️ 编辑角色卡</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'CharacterDetail' }
</script>
