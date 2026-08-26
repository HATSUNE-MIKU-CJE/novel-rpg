/**
 * 键盘高度管理（v1.4 修复输入框被键盘遮挡）。
 *
 * 原生：@capacitor/keyboard 插件提供精确 keyboardHeight（Capacitor 8 edge-to-edge 下
 *       WebView 不 resize，固定到 body 的 CSS 变量是唯一可靠通道）。
 * Web：visualViewport 差值兜底（浏览器没有该插件事件）。
 *
 * 全局设置 CSS 变量 --kb-h（px），CSS 侧消费：
 *   .tabbar     bottom: var(--kb-h, 0px)      —— 底部导航贴住键盘顶
 *   .chat-layout height 减去 var(--kb-h)      —— 输入框/消息区整体收缩
 */
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'

function apply(px: number) {
  document.documentElement.style.setProperty('--kb-h', `${Math.max(0, Math.round(px))}px`)
}

let inited = false

export async function initKeyboardHeight() {
  if (inited) return
  inited = true

  let nativeOk = false
  if (Capacitor.isNativePlatform()) {
    try {
      await Keyboard.addListener('keyboardWillShow', (info) => apply(info?.keyboardHeight ?? 0))
      await Keyboard.addListener('keyboardWillHide', () => apply(0))
      nativeOk = true
    } catch { /* 插件不可用时回退 Web 逻辑 */ }
  }

  if (!nativeOk) {
    const vv = window.visualViewport
    if (vv) {
      const upd = () => apply(Math.max(0, window.innerHeight - vv.height))
      vv.addEventListener('resize', upd)
      vv.addEventListener('scroll', upd)
      upd()
    }
  }
}
