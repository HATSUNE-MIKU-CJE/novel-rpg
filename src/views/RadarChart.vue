<script setup lang="ts">
import { computed } from 'vue'

interface Attr { label: string; value: number }
const props = defineProps<{ attrs: Attr[]; size?: number }>()

const S = computed(() => props.size ?? 220)
const CX = computed(() => S.value / 2)
const CY = computed(() => S.value / 2)
const R = computed(() => S.value / 2 - 42)

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
const dataPoints = computed(() => ringPoints(n.value, 1))
const polyPoints = computed(() => {
  const pts: string[] = []
  props.attrs.forEach((a, i) => {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / n.value
    const ratio = Math.max(0.05, Math.min(1, (a.value || 0) / 10))
    pts.push(`${CX.value + Math.cos(ang) * R.value * ratio},${CY.value + Math.sin(ang) * R.value * ratio}`)
  })
  return pts.join(' ')
})

/** 标签坐标（顶点外侧） */
function labelPos(i: number): { x: number; y: number; anchor: string } {
  const ang = -Math.PI / 2 + (i * Math.PI * 2) / n.value
  const lx = CX.value + Math.cos(ang) * (R.value + 22)
  const ly = CY.value + Math.sin(ang) * (R.value + 22)
  const cos = Math.cos(ang)
  return { x: lx, y: ly, anchor: Math.abs(cos) < 0.35 ? 'middle' : cos > 0 ? 'start' : 'end' }
}
</script>

<template>
  <div v-if="n >= 3" style="display:flex; justify-content:center">
    <svg :viewBox="`0 0 ${S} ${S}`" :style="{ width: '100%', maxWidth: '300px', height: 'auto' }">
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
      <circle
        v-for="i in n" :key="'d' + i"
        :cx="CX + Math.cos(-Math.PI/2 + (i-1)*Math.PI*2/n) * R * Math.max(0.05, Math.min(1, (attrs[i-1]?.value ?? 0) / 10))"
        :cy="CY + Math.sin(-Math.PI/2 + (i-1)*Math.PI*2/n) * R * Math.max(0.05, Math.min(1, (attrs[i-1]?.value ?? 0) / 10))"
        r="3" fill="var(--accent)"
      />
      <!-- 标签 -->
      <text
        v-for="(a, i) in attrs" :key="'l' + i"
        :x="labelPos(i).x" :y="labelPos(i).y" :text-anchor="labelPos(i).anchor"
        font-size="11" fill="var(--ink)"
        style="dominant-baseline:middle"
      >{{ a.label }} {{ a.value }}</text>
    </svg>
  </div>
  <div v-else class="list-sub" style="text-align:center; padding:6px 0">
    <span v-for="(a, i) in attrs" :key="i" class="entry-tag tag-constant" style="margin:0 4px">{{ a.label }} {{ a.value }}</span>
  </div>
</template>

<script lang="ts">
export default { name: 'RadarChart' }
</script>
