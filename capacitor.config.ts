import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.miku.novelrpg',
  appName: '梦旅',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
}

export default config
