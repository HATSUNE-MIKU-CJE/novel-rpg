<script setup lang="ts">
import { ref, computed } from 'vue'
import { DREAM_GROUPS, customMapOf, type DreamConfig } from '../engine/dreamPreset'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import Icon from '../components/Icon.vue'

const ds = useDataStore()
const chat = useChatStore()

const cfg = computed<DreamConfig>(() => chat.dreamConfig() ?? { custom: {} })
const currentCampaign = computed(() => chat.currentCampaign)

/** v1.2：输出模式组废弃（写作/交流已分为双栏），不展示 */
const visibleGroups = computed(() => DREAM_GROUPS.filter((g) => g.id !== 'output_mode'))

/** 展开的选项（groupId + optionId），仅一个同时展开 */
const expanded = ref('')

async function persist() {
  const c = currentCampaign.value
  if (!c) return
  c.dreamConfigJson = JSON.stringify(cfg.value)
  await ds.saveCampaign(c)
}

function selectSingle(gid: string, oid: string) {
  cfg.value[gid] = oid
  persist()
}

function toggleMulti(gid: string, oid: string) {
  const arr = (cfg.value[gid] as string[] | undefined) ?? []
  const next = arr.includes(oid) ? arr.filter((x) => x !== oid) : [...arr, oid]
  cfg.value[gid] = next
  persist()
}

function selectedOf(g: { id: string; type: string; defaultSingle?: string; defaultMulti?: string[]; options: any[] }): { single: string | null; multi: string[] } {
  if (g.type === 'single') {
    const v = cfg.value[g.id] as string | undefined
    return { single: v ?? g.defaultSingle ?? g.options[0].id, multi: [] }
  }
  const arr = (cfg.value[g.id] as string[] | undefined) ?? g.defaultMulti ?? []
  return { single: null, multi: arr }
}

function toggleExpand(key: string) {
  expanded.value = expanded.value === key ? '' : key
}

/** 点击选项：选中 + 展开详情（已展开则收起）。多选组只切换选中，详情靠再点 */
function onOptionClick(g: any, o: any) {
  if (g.type === 'single') {
    if (selectedOf(g).single === o.id) {
      toggleExpand(g.id + '/' + o.id)
    } else {
      selectSingle(g.id, o.id)
      if (o.detail || o.custom) expanded.value = g.id + '/' + o.id
    }
  } else {
    toggleMulti(g.id, o.id)
  }
}

/** 自定义参数值双向绑定（编辑草稿，blur 时落盘） */
const customDraft = ref<Record<string, string>>({})
function openCustomDraft(paramId: string) {
  if (!(paramId in customDraft.value)) customDraft.value[paramId] = customMapOf(cfg.value)[paramId] ?? ''
}
function setCustom(paramId: string, v: string) {
  const cm = customMapOf(cfg.value)
  cm[paramId] = v
  cfg.value.custom = cm
  persist()
}

function hasCustomValue(paramId: string): boolean {
  return !!customMapOf(cfg.value)[paramId]?.trim()
}

function resetGroup(gid: string) {
  const g = DREAM_GROUPS.find((x) => x.id === gid)!
  if (g.type === 'single') cfg.value[gid] = g.defaultSingle ?? g.options[0].id
  else cfg.value[gid] = [...(g.defaultMulti ?? [])]
  persist()
}

/** 高级区（渠道手动档）折叠 */
const showAdvanced = ref(false)
const advancedOptions = computed(() => {
  return DREAM_GROUPS.flatMap((g) => g.options.filter((o) => o.advanced).map((o) => ({ g, o })))
})
</script>

<template>
  <div v-if="currentCampaign" class="preset-panel">
    <div class="page-title" style="display:flex; align-items:center; gap:7px"><span style="color:var(--accent-deep); display:flex"><Icon name="sliders" :size="18" /></span>梦鲸思客·精简 · 预设开关</div>
    <div class="list-sub" style="margin: -6px 4px 12px">
      当前存档：{{ currentCampaign.name }} · 修改即时生效（下一轮对话使用）
    </div>

    <div class="card" style="margin-bottom: 12px; border: 1px dashed var(--accent)">
      <div class="list-sub" style="line-height: 1.6">
        v1.2：交流与游戏已分为<strong>双栏</strong>——本页所有开关只作用于「游戏」栏的写作推进；
        「交流」栏独立使用「设计主持」人格（设置 → API 页面无关联）。
      </div>
    </div>

    <!-- 高级区提示（自动渠道默认隐藏） -->
    <div v-if="showAdvanced" class="advanced-box card" style="margin-bottom: 12px">
      <div style="margin-bottom: 8px"><b><Icon name="gear" :size="13" /> 高级选项（渠道手动档）</b></div>
      <div class="list-sub" style="margin-bottom: 10px">
        渠道适配默认「自动」按模型判断思考标记——只有手动档位在这，通常不用动。
      </div>
      <div v-for="ao in advancedOptions" :key="ao.g.id + ao.o.id" class="entry-item" style="padding:6px 4px">
        <span class="entry-tag tag-trigger">{{ ao.g.label }}</span>
        <div style="flex:1">
          <div class="list-title" style="font-size:13px">{{ ao.o.label }}</div>
          <div class="list-sub">{{ ao.o.desc }}</div>
        </div>
        <button
          v-if="selectedOf(ao.g).single === ao.o.id"
          class="btn btn-danger btn-sm"
          @click="selectSingle(ao.g.id, 'auto')"
        >已启用·点关闭</button>
        <button
          v-else
          class="btn btn-soft btn-sm"
          @click="selectSingle(ao.g.id, ao.o.id)"
        >启用</button>
      </div>
    </div>

    <div v-for="g in visibleGroups" :key="g.id" class="card" style="margin-bottom: 12px">
      <div style="display:flex; align-items:center; margin-bottom: 4px">
        <b>{{ g.icon }} {{ g.label }}</b>
        <span class="list-sub" style="margin-left:8px">
          {{ g.type === 'single' ? '单选' : '可多开' }}
        </span>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto" @click="resetGroup(g.id)">恢复默认</button>
      </div>
      <div v-if="g.help" class="group-help">{{ g.help }}</div>

      <div class="opt-group">
        <template v-for="o in g.options" :key="o.id">
          <div
            class="opt-btn opt-row"
            :class="{ 'opt-on': g.type === 'single' ? selectedOf(g).single === o.id : selectedOf(g).multi.includes(o.id) }"
            @click="onOptionClick(g, o)"
          >
            <span v-if="g.type === 'single'" class="opt-dot">{{ selectedOf(g).single === o.id ? '●' : '○' }}</span>
            <span v-else class="opt-dot">{{ selectedOf(g).multi.includes(o.id) ? '☑' : '☐' }}</span>
            <span v-if="o.color" class="opt-color">{{ o.color }}</span>
            <span style="flex:1; min-width:0">
              <span class="opt-label">{{ o.label }}</span>
              <span v-if="o.origin && o.origin !== o.label" class="list-sub opt-origin">（{{ o.origin }}）</span>
              <div class="opt-desc">{{ o.desc }}</div>
            </span>
            <span
              v-if="o.custom && hasCustomValue(o.custom.paramId)"
              class="custom-badge"
            >已设</span>
            <span class="opt-arrow" @click.stop="toggleExpand(g.id + '/' + o.id)">{{ expanded === g.id + '/' + o.id ? '▲' : '▼' }}</span>
          </div>

          <!-- 展开区：详细描述 + 自定义参数 -->
          <div v-if="expanded === g.id + '/' + o.id" class="opt-detail" @click.stop>
            <div v-if="o.detail" class="detail-text">{{ o.detail }}</div>
            <div v-if="o.custom" class="custom-field">
              <label>{{ o.custom.label }}</label>
              <textarea
                v-if="o.custom.kind === 'textarea' || o.custom.kind === 'list'"
                v-model="customDraft[o.custom.paramId]"
                :placeholder="o.custom.placeholder"
                rows="4"
                @focus="openCustomDraft(o.custom.paramId)"
                @blur="setCustom(o.custom.paramId, customDraft[o.custom.paramId] ?? '')"
              ></textarea>
              <input
                v-else
                v-model="customDraft[o.custom.paramId]"
                :placeholder="o.custom.placeholder || o.custom.label"
                @focus="openCustomDraft(o.custom.paramId)"
                @blur="setCustom(o.custom.paramId, customDraft[o.custom.paramId] ?? '')"
              />
              <div v-if="o.custom.hint" class="list-sub">{{ o.custom.hint }}</div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      {{ showAdvanced ? '收起高级选项 ▲' : '展开高级选项 ▼' }}
    </div>
  </div>

  <div v-else class="empty-hint">先打开一个存档，再调预设开关</div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({})
</script>
