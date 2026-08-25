/**
 * 文件导出/分享工具：
 * - 原生（Capacitor）：Filesystem 写给 Cache → Share 拉起系统分享（可存文件/发出去）
 * - Web：Blob + a.click() 下载
 */
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export async function exportFile(fileName: string, content: string, mime = 'application/json'): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    // 浏览器下载
    const blob = new Blob([content], { type: mime })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    return true
  }

  // 原生：写 Cache + 分享
  try {
    const base64 = btoa(unescape(encodeURIComponent(content)))
    const res = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    await Share.share({
      title: fileName,
      url: res.uri,
      dialogTitle: `导出 ${fileName}`,
    })
    return true
  } catch (e: any) {
    // 用户取消分享或失败
    if (e?.message?.includes('canceled') || e?.code === 'CANCELED') return true
    throw e
  }
}
