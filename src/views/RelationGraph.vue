<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { Character, Relation } from '../types'

const props = defineProps<{
  characters: Character[]
  relations: Relation[]
}>()
const emit = defineEmits<{ open: [Character] }>()

const selected = ref<string | null>(null)

interface NodePos { x: number; y: number; vx: number; vy: number }

// ---- 力导向布局（确定性：多轮迭代后稳定） ----
const positions = ref<Record<string, NodePos>>({})
const W = 340, H = 300

function layout() {
  const chars = props.characters
  const pos: Record<string, NodePos> = {}
  if (!chars.length) { positions.value = pos; return }
  const n = chars.length
  chars.forEach((c, i) => {
    const angle = (i / n) * Math.PI * 2
    pos[c.name] = { x: W / 2 + Math.cos(angle) * (W / 4), y: H / 2 + Math.sin(angle) * (H / 4), vx: 0, vy: 0 }
  })
  // 迭代 160 次：引力（向中心）+ 斥力（节点间）+ 弹力（关系边）
  const k = 60 // 斥力系数
  for (let iter = 0; iter < 160; iter++) {
    // 斥力
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[chars[i].name], b = pos[chars[j].name]
        let dx = a.x - b.x, dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5 }
        const d = Math.sqrt(d2)
        const f = (k * k) / d2
        a.vx += (dx / d) * f; a.vy += (dy / d) * f
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
    }
    // 边弹力
    for (const r of props.relations) {
      const a = pos[r.fromChar], b = pos[r.toChar]
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const want = 95
      const f = (d - want) * 0.06
      a.vx += (dx / d) * f * 2; a.vy += (dy / d) * f * 2
      b.vx -= (dx / d) * f * 2; b.vy -= (dy / d) * f * 2
    }
    // 向心力
    for (const c of chars) {
      const p = pos[c.name]
      p.vx += (W / 2 - p.x) * 0.012
      p.vy += (H / 2 - p.y) * 0.012
    }
    // 积分 + 阻尼
    for (const c of chars) {
      const p = pos[c.name]
      p.x += p.vx * 0.35; p.y += p.vy * 0.35
      p.vx *= 0.82; p.vy *= 0.82
    }
  }
  positions.value = pos
}

onMounted(layout)
watch(() => [props.characters, props.relations], layout, { deep: true })

function charOf(name: string): Character | undefined {
  return props.characters.find((c) => c.name === name)
}

const selectedRelations = computed(() => {
  if (!selected.value) return []
  return props.relations.filter(
    (r) => r.fromChar === selected.value || r.toChar === selected.value,
  )
})

function clickNode(c: Character) {
  selected.value = c.name
  emit('open', c)
}
</script>

<template>
  <div class="rel-graph">
    <svg :viewBox="`0 0 ${W} ${H}`" style="width:100%; height:auto" @click="selected = null">
      <!-- 边 -->
      <g v-for="(r, i) in relations" :key="'e' + i">
        <line
          v-if="positions[r.fromChar] && positions[r.toChar]"
          :x1="positions[r.fromChar].x" :y1="positions[r.fromChar].y"
          :x2="positions[r.toChar].x" :y2="positions[r.toChar].y"
          stroke="var(--accent)" stroke-width="1.6" stroke-opacity=".55"
        />
        <text
          v-if="positions[r.fromChar] && positions[r.toChar]"
          :x="(positions[r.fromChar].x + positions[r.toChar].x) / 2"
          :y="(positions[r.fromChar].y + positions[r.toChar].y) / 2 - 4"
          text-anchor="middle" font-size="9.5" fill="var(--ink-soft)"
        >{{ r.relType }}</text>
      </g>
      <!-- 节点 -->
      <g v-for="c in characters" :key="c.name">
        <circle
          v-if="positions[c.name]"
          :cx="positions[c.name].x" :cy="positions[c.name].y"
          r="17"
          :fill="selected === c.name ? 'var(--accent)' : 'var(--accent-soft)'"
          :stroke="selected === c.name ? 'var(--accent-deep)' : 'var(--accent)'"
          stroke-width="1.4"
          style="cursor:pointer"
          @click.stop="clickNode(c)"
        />
        <text
          v-if="positions[c.name]"
          :x="positions[c.name].x" :y="positions[c.name].y + 4"
          text-anchor="middle" font-size="10.5"
          :fill="selected === c.name ? '#fff' : 'var(--accent-deep)'"
          style="pointer-events:none"
        >{{ c.name.slice(0, 4) }}</text>
      </g>
    </svg>

    <div v-if="selectedRelations.length" class="list-sub" style="margin-top:4px">
      点亮的节点已选中 —— 详情见弹层
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'RelationGraph' }
</script>
