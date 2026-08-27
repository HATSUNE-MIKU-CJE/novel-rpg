<script setup lang="ts">
import { computed } from 'vue'

interface Attr { label: string; value: number }
const props = defineProps<{ attrs: Attr[]; size?: number; max?: number }>()

/** 画布加大：四周留足标签边距，避免长标签/数值被裁切 */
const S = computed(() => props.size ?? 260)
const CX = computed(() => S.value / 2)
const CY = computed(() => S.value / 2)
const R = computed(() => S.value / 2 - 52)
const MAX = computed(() => Math.max(1, props.max ?? 10))

/** n 维正多边形顶点 */
function ringPoints(n: number, ratio: number): string {
  const pts: string[] = []
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / n
    pts.push(`${CX.value + Math.cos(ang) * R.value * ratio},${CY.value + Math.sin(ang) * R.value * ratio}`)
  }
  return pts.join(' ')
}

const n = computed(() => props.attrs.length)

/** 数据面顶点（按 max 归一） */
const polyPoints = computed(() => {
  const pts: string[] = []
  props.attrs.forEach((a, i) => {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / n.value
    const ratio = Math.max(0.05, Math.min(1, (a.value || 0) / MAX.value))
    pts.push(`${CX.value + Math.cos(ang) * R.value * ratio},${CY.value + Math.sin(ang) * R.value * ratio}`)
  })
  return pts.join(' ')
})

/** 数值显示：整数不带小数点，小数保留 1 位 */
function fmtVal(v: number): string {
  return Math.round(v) === v ? String(Math.round(v)) : v.toFixed(1)
}

/** 标签位置（顶点内侧收拢，防溢出） */
function labelPos(i: number): { x: number; y: number; anchor: string } {
  const ang = -Math.PI / 2 + (i * Math.PI * 2) / n.value
  const cos = Math.cos(ang), sin = Math.sin(ang)
  const lx = CX.value + cos * (R.value + 13)
  const ly = CY.value + sin * (R.value + 13)
  const anchor = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end'
  const dy = Math.abs(sin) < 0.3 ? 4 : (Math.abs(cos) < 0.3 ? (sin > 0 ? 14 : -6) : 4)
  return { x: lx + (Math.abs(cos) < 0.3 ? 0 : cos > 0 ? 2 : -2), y: ly + dy, anchor }
}
</script>

<template>
  <div v-if="n >= 3" style="display:flex; justify-content:center">
    <svg :viewBox="`0 0 ${S} ${S}`" :style="{ width: '100%', maxWidth: '320px', height: 'auto' }">
      <!-- 网格环 -->
      <g v-for="r in [0.25, 0.5, 0.75, 1]" :key="r">
        <polygon :points="ringPoints(n, r)" fill="none" stroke="var(--line)" stroke-width="1" />
      </g>
      <!-- 轴线 -->
      <line
        v-for="i in n" :key="'a' + i"
        :x1="CX" :y1="CY"
        :x2="CX + Math.cos(-Math.PI/2 + (i-1)*Math.PI*2/n) * R"
        :y2="CY + Math.sin(-Math.PI/2 + (i-1)*Math.PI*2/n) * R"
        stroke="var(--line)" stroke-width="1"
      />
      <!-- 数据面 -->
      <polygon :points="polyPoints" fill="var(--accent)" fill-opacity="0.22" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />
      <!-- 数据点 -->
      <circle
        v-for="i in n" :key="'d' + i"
        :cx="CX + Math.cos(-Math.PI/2 + (i-1)*Math.PI*2/n) * R * Math.max(0.05, Math.min(1, (attrs[i-1]?.value ?? 0) / MAX))"
        :cy="CY + Math.sin(-Math.PI/2 + (i-1)*Math.PI*2/n) * R * Math.max(0.05, Math.min(1, (attrs[i-1]?.value ?? 0) / MAX))"
        r="3" fill="var(--accent)"
      />
      <!-- 标签：名称 + 数值，一行完整显示 -->
      <text
        v-for="(a, i) in attrs" :key="'l' + i"
        :x="labelPos(i).x" :y="labelPos(i).y" :text-anchor="labelPos(i).anchor"
        font-size="11.5" fill="var(--ink)"
        style="dominant-baseline:middle"
      >{{ a.label }}<tspan fill="var(--ink-soft)"> {{ fmtVal(a.value) }}</tspan></text>
    </svg>
  </div>
  <div v-else class="list-sub" style="text-align:center; padding:6px 0">
    <span v-for="(a, i) in attrs" :key="i" class="entry-tag tag-constant" style="margin:0 4px">{{ a.label }} {{ fmtVal(a.value) }}</span>
  </div>
</template>

<script lang="ts">
export default { name: 'RadarChart' }
</script>
