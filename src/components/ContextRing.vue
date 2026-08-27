<script setup lang="ts">
/**
 * 上下文状态小圆环：显示当前流未压缩历史占预算的比例。
 * 绿 <60% · 琥珀 60-85% · 红 ≥85% · 灰 = 未启用预算或空历史。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 0..1+（超出按满格显示） */
  pct: number
  size?: number
  /** 环心显示百分比数字 */
  showPct?: boolean
}>(), { size: 22, showPct: true })

const sw = 3
const r = computed(() => (props.size - sw - 1) / 2)
const circ = computed(() => 2 * Math.PI * r.value)
const clamped = computed(() => Math.max(0, Math.min(1, props.pct)))
const len = computed(() => circ.value * clamped.value)
const color = computed(() => {
  if (props.pct <= 0.001) return 'var(--line)'
  if (props.pct >= 0.85) return 'var(--danger)'
  if (props.pct >= 0.6) return 'var(--warn)'
  return 'var(--ok)'
})
const label = computed(() => {
  const p = Math.round(props.pct * 100)
  if (p <= 0) return ''
  return p >= 100 ? '满' : String(p)
})
</script>

<template>
  <span class="ctx-ring" :title="`上下文 ${Math.round(pct * 100)}%（未压缩历史 / 预算）`">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle :cx="size / 2" :cy="size / 2" :r="r" fill="none" stroke="var(--line)" :stroke-width="sw" />
      <circle
        :cx="size / 2" :cy="size / 2" :r="r" fill="none"
        :stroke="color" :stroke-width="sw"
        :stroke-dasharray="`${len} ${circ - len}`"
        stroke-linecap="round"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        style="transition: stroke-dasharray .25s, stroke .25s"
      />
    </svg>
    <span v-if="showPct && label" class="ctx-ring-num" :style="{ fontSize: Math.round(size * 0.42) + 'px' }">{{ label }}</span>
  </span>
</template>

<style scoped>
.ctx-ring {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: default;
}
.ctx-ring svg { display: block; }
.ctx-ring-num {
  position: absolute;
  line-height: 1;
  color: var(--ink-soft);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
