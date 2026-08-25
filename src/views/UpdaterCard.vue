<script setup lang="ts">
import { ref, computed } from 'vue'
import { checkForUpdate, downloadApk, isNative, compareVersions, UPDATE_REPO, type UpdateInfo } from '../engine/updater'

const toast = ref('')
let t: number | undefined
function showToast(m: string) { toast.value = m; clearTimeout(t); t = window.setTimeout(() => toast.value = '', 2200) }

const checking = ref(false)
const downloading = ref(false)
const downloadPercent = ref(0)
const info = ref<UpdateInfo | null>(null)
const error = ref('')

const APP_VERSION = '1.1.1'
const REPO = UPDATE_REPO

/** 检查更新（手动触发） */
async function check() {
  if (checking.value) return
  checking.value = true
  error.value = ''
  try {
    info.value = await checkForUpdate(REPO, APP_VERSION)
    if (!info.value.hasUpdate) {
      showToast(`已是最新版本（v${APP_VERSION}）`)
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    checking.value = false
  }
}

/** 下载 + 拉起安装 */
async function install() {
  if (!info.value?.apkUrl || downloading.value) return
  downloading.value = true
  downloadPercent.value = 0
  try {
    const res = await downloadApk(info.value.apkUrl, info.value.latestVersion)
    if (isNative()) {
      // 原生：调用 InstallApk 插件拉起系统安装界面
      const { registerPlugin } = await import('@capacitor/core')
      const InstallApk = registerPlugin('InstallApk')
      await (InstallApk as any).install({ fileName: res.name })
      showToast('已拉起安装器')
    } else {
      // Web：跳转浏览器下载
      window.open(info.value.apkUrl, '_blank')
      showToast('已打开下载页')
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    downloading.value = false
  }
}

// 进度模拟（fetch 无流式进度，按时间估算）
function startPercentTimer() {
  let p = 0
  downloadPercent.value = 0
  const timer = setInterval(() => {
    p = Math.min(p + Math.random() * 8, 95)
    downloadPercent.value = Math.round(p)
  }, 300)
  return timer
}

const dialogVisible = computed(() => !!info.value && info.value.hasUpdate)

defineExpose({ check })
</script>

<template>
  <div>
    <!-- 检查按钮 -->
    <div class="card">
      <div style="display:flex; align-items:center;">
        <b style="flex:1">🔔 版本更新</b>
        <button class="btn btn-soft btn-sm" :disabled="checking" @click="check">
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
      </div>
      <div class="list-sub" style="margin-top:6px">
        当前版本 v{{ APP_VERSION }} · 更新源：GitHub Releases（{{ REPO }}）
      </div>
      <div v-if="error" class="msg-error" style="margin-top:8px">⚠️ {{ error }}</div>
      <div v-if="downloading" style="margin-top:8px">
        <div class="progress-bar"><div class="progress-fill" :style="{ width: downloadPercent + '%' }"></div></div>
        <div class="list-sub" style="margin-top:4px">下载中… {{ downloadPercent }}%</div>
      </div>
    </div>

    <!-- 更新弹层 -->
    <div v-if="dialogVisible" class="modal-mask" @click.self="info = null">
      <div class="modal-sheet">
        <div class="modal-title">🎆 发现新版本</div>
        <div style="text-align:center; margin-bottom:12px">
          <span style="font-size:28px">v{{ info!.latestVersion }}</span>
          <div class="list-sub" style="margin-top:2px">当前 v{{ info!.currentVersion }}</div>
        </div>
        <div v-if="info!.releaseNotes" class="release-notes">{{ info!.releaseNotes }}</div>
        <div style="display:flex; gap:10px; margin-top:14px">
          <button class="btn btn-ghost" style="flex:1" @click="info = null">稍后</button>
          <button class="btn btn-primary" style="flex:2" :disabled="downloading || !info!.apkUrl" @click="install">
            {{ info!.apkUrl ? (downloading ? '下载中…' : '下载并安装') : '无安装包（请去 GitHub 下载）' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.release-notes {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 13px;
  color: var(--ink);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.progress-bar {
  height: 6px; background: var(--bg-deep); border-radius: 3px; overflow: hidden;
}
.progress-fill {
  height: 100%; background: var(--accent); border-radius: 3px;
  transition: width .3s;
}
</style>

<script lang="ts">
export default { name: 'UpdaterCard' }
</script>
