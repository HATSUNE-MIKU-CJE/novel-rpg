/**
 * 更新检查引擎：GitHub Releases 作为更新源（带多镜像容错 + 超时 + 友好错误）。
 *
 * 检查：GET https://api.github.com/repos/{owner}/{repo}/releases/latest
 * 比对：semver 数字比较 + 本地版本（package version）
 * 下载：CapacitorHttp/CORS 直连 → Blob → Filesystem（Cache 目录）
 */

import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { httpFetch } from './http'

/** GitHub 仓库（更新源） */
export const UPDATE_REPO = 'HATSUNE-MIKU-CJE/novel-rpg'

export interface UpdateInfo {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string
  releaseName?: string
  releaseNotes?: string
  apkUrl?: string        // APK 资产下载地址
  publishedAt?: string
}

const OWNER_REPO_RE = /^([^/]+)\/([^/]+)$/

/** APK 直链：优先 browser_download_url（可匿名下载）；无则用 API url 转换 */
function assetDownloadUrl(asset: any): string {
  if (asset.browser_download_url) return String(asset.browser_download_url)
  return String(asset.url ?? '')
    .replace(/^https:\/\/api\.github\.com\/repos\//, 'https://github.com/')
    .replace(/\/releases\/assets\//, '/releases/download/') + `/${asset.name}`
}

/** 版本号比较：'1.0.1' > '1.0.0'；支持三段数字 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 可用的检查源（按顺序尝试） */
function checkSources(repo: string): string[] {
  return [
    `https://api.github.com/repos/${repo}/releases/latest`,
    `https://ghproxy.com/https://api.github.com/repos/${repo}/releases/latest`,
    `https://gh-proxy.com/https://api.github.com/repos/${repo}/releases/latest`,
  ]
}

/** 带超时的 httpFetch */
async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs = 12000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await httpFetch(url, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检查最新版本（多源容错）。
 * 主源失败时依次尝试镜像；全部失败抛友好错误。
 */
export async function checkForUpdate(
  repo = UPDATE_REPO,
  currentVersion = '3.5.0',
): Promise<UpdateInfo> {
  const m = repo.match(OWNER_REPO_RE)
  if (!m) throw new Error('仓库格式错误：应为 owner/repo')

  let lastErr = ''
  for (const url of checkSources(repo)) {
    try {
      const resp = await fetchWithTimeout(url, { Accept: 'application/vnd.github+json' })
      if (resp.status === 404) {
        return { hasUpdate: false, latestVersion: currentVersion, currentVersion }
      }
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`
        continue
      }
      const data = await resp.json()
      const latestVersion = String(data.tag_name ?? '').replace(/^v/, '')
      const assets: any[] = Array.isArray(data.assets) ? data.assets : []
      const apkAsset = assets.find((a) => String(a.name ?? '').endsWith('.apk'))
      return {
        hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
        latestVersion,
        currentVersion,
        releaseName: data.name ?? '',
        releaseNotes: String(data.body ?? '').slice(0, 2000),
        apkUrl: apkAsset ? assetDownloadUrl(apkAsset) : undefined,
        publishedAt: data.published_at ?? '',
      }
    } catch (e: any) {
      lastErr = e?.name === 'AbortError' ? '超时' : (e?.message || String(e))
      // 源不可用，尝试下一个
    }
  }
  throw new Error(`无法连接更新源（${lastErr || '网络错误'}）\n请检查网络（GitHub 需可访问）或稍后重试`)
}

/** 应用内下载 APK → 本地 Cache 文件，返回本地 uri（原生拉起用） */
export async function downloadApk(url: string, version: string): Promise<{ uri: string; name: string }> {
  // 下载保持标准 fetch：GitHub 资产直链浏览器可过；原生走 CapacitorHttp 大文件不稳
  const resp = await fetchWithTimeout(url, {}, 300000)
  if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`)
  const blob = await resp.blob()
  const name = `novel-rpg-${version}.apk`
  const base64 = await blobToBase64(blob)

  const result = await Filesystem.writeFile({
    path: name,
    data: base64,
    directory: Directory.Cache,
    encoding: Encoding.UTF8, // base64 字符串（写入时插件按 base64 解码）
  })
  return { uri: result.uri, name }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 是否为原生平台（下载与安装仅原生可用；浏览器只提示跳转） */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}
