<script setup lang="ts">
/**
 * v2.0 操作确认卡：交流栏消息内嵌、面板审计区共用。
 * 展示一条 AI 操作（新增/修改/删除…）的标题与内容预览，就地确认/退回。
 */
import { computed } from 'vue'
import { opTitle, opGroupLabel, type OpBlock } from '../engine/ops'
import type { Op, Entry } from '../types'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  op: Op
  /** 目标条目（entry.upsert/delete/disable 时由父组件查好传入；null=新条目） */
  target?: Entry | null
  /** 紧凑模式（消息内嵌） */
  compact?: boolean
}>(), { target: null, compact: false })

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'reject'): void
}>()

const p = computed<OpBlock>(() => { try { return JSON.parse(props.op.payload) as OpBlock } catch { return { op: props.op.kind } } })
const groupLabel = computed(() => opGroupLabel(props.op.kind))
const title = computed(() => opTitle(p.value))
const isDel = computed(() => props.op.kind === 'entry.delete')
const isMod = computed(() => props.op.kind === 'entry.upsert' && !!props.target)
const before = computed(() => props.target?.content ?? '')
const after = computed(() => p.value.content ?? '')
const preview = computed(() => {
  if (isMod.value) return ''
  const s = p.value.content ?? p.value.description ?? ''
  return `${s.slice(0, 90)}${s.length > 90 ? '…' : ''}`
})
</script>

<template>
  <div class="op-card" :class="{ 'op-done': op.status === 'done', 'op-rejected': op.status === 'rejected', compact }"
    :data-op-id="op.id">
    <div class="op-head">
      <span class="op-tag" :class="`op-tag-${isDel ? 'del' : (isMod ? 'mod' : 'new')}`">{{ groupLabel }}</span>
      <span class="op-title">{{ title }}</span>
      <span v-if="op.src === 'extract'" class="op-src">整理提取</span>
      <span v-else class="op-src">AI 操作</span>
    </div>
    <!-- diff 预览 -->
    <div v-if="isMod && before.trim()" class="op-diff">
      <div class="op-before">{{ before.slice(0, 120) }}{{ before.length > 120 ? '…' : '' }}</div>
      <div class="op-arrow">→</div>
      <div class="op-after">{{ after.slice(0, 120) }}{{ after.length > 120 ? '…' : '' }}</div>
    </div>
    <div v-else-if="isDel && before.trim()" class="op-diff">
      <div class="op-before">{{ before.slice(0, 120) }}{{ before.length > 120 ? '…' : '' }}</div>
      <div class="op-arrow">删除</div>
    </div>
    <div v-else-if="preview" class="op-diff">
      <div class="op-after">{{ preview }}</div>
    </div>
    <!-- 状态操作 -->
    <div v-if="op.status === 'pending'" class="op-actions">
      <button class="btn btn-primary btn-sm" style="flex:2; padding:2px 8px" @click="emit('confirm')"><Icon name="check" :size="12" /> 确认</button>
      <button class="btn btn-ghost btn-sm" style="flex:1; padding:2px 8px" @click="emit('reject')"><Icon name="xmark" :size="12" /> 退回</button>
    </div>
    <div v-else class="op-status">
      <template v-if="op.status === 'done'"><Icon name="check" :size="12" /> 已生效</template>
      <template v-else><Icon name="xmark" :size="12" /> 已退回，未生效</template>
    </div>
  </div>
</template>

<style scoped>
.op-card {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: var(--card-soft);
  margin-top: 6px;
  font-size: 12.5px;
}
.op-card.compact { padding: 7px 9px; }
.op-card.op-done { border-left-color: var(--ok); opacity: .82; }
.op-card.op-rejected { border-left-color: var(--danger); opacity: .6; }
.op-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.op-tag {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600;
  padding: 1px 6px; border-radius: 6px;
  background: var(--accent-soft); color: var(--accent-deep);
}
.op-tag-mod { background: var(--warm-soft); color: var(--warm); }
.op-tag-del { background: #f3e2e0; color: var(--danger); }
.op-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--ink); }
.op-src { flex-shrink: 0; font-size: 10px; color: var(--ink-soft); }
.op-diff { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.op-before { color: var(--danger); text-decoration: line-through; word-break: break-all; }
.op-after { color: var(--ink); word-break: break-all; }
.op-arrow { color: var(--ink-soft); font-size: 10.5px; }
.op-actions { display: flex; gap: 8px; margin-top: 8px; }
.op-actions :deep(.btn) { font-size: 12px; }
.op-status { margin-top: 6px; color: var(--ink-soft); font-size: 11.5px; display: flex; align-items: center; gap: 4px; }
</style>
