import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.miku.novelrpg',
  appName: '梦旅',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      /**
       * 原生 HTTP 转发：WebView 内 fetch 改走原生请求（无 CORS 限制）。
       * opencode-go 等服务端网关未配置 CORS 头，WebView 浏览器 fetch 会被拦截
       * （failed to fetch），开启后任意 OpenAI 兼容节点都能直连。
       */
      enabled: true,
    },
  },
  android: {
    allowMixedContent: false,
  },
}

export default config
