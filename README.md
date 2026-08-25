# 梦旅 · NovelRPG

手机端 AI 视觉小说 / 跑团小工具。AI 推进故事，并自动把新事实沉淀进「世界书」。

- **形态**：Capacitor APK（Android，数据全本地）
- **双对话流（v1.2）**：💬 交流栏（与 AI 商定设定/闲聊）与 🎮 游戏栏（跑团剧情）分栏共存；先交流再「🚀 开始游戏」（设定卡确认 + AI 开场白），两侧「↻」同步按钮双向提炼
- **预设**：内置「梦鲸思客·精简」（宝宝化开关面板，12 组配置可调、7 处自定义），兼容导入 SillyTavern 预设与世界书
- **节点**：内置 DeepSeek 官方 + opencode-go 网关，OpenAI 兼容格式自由配
- **统计**：每轮 token + 金额（DeepSeek 官方按真实价格表 + 峰谷时段折算）
- **自动写世界书**：每 N 轮自动提取 / 手动整理 → 待审阅 → 接受后注入对话；角色卡含属性雷达图（AI 提取 + 手动编辑，可开关注入）
- **上下文**：1M 预算 + 80% 自动压缩（可手动）；📜 章节回顾卡

## 开发

```bash
npm install
npm run dev        # 浏览器 http://localhost:5173
npm run build      # web 产物 → dist/
npx cap sync android   # 同步到 Android 工程
```

## 构建 APK（本机）

需要 JDK 21 + Android SDK。本项目使用的免 root 方案：

```bash
# JDK（已配置在 /tmp/jdk21-final，cacerts 已生成）
export JAVA_HOME=/tmp/jdk21-final
export ANDROID_HOME=$HOME/android-sdk
export PATH=$JAVA_HOME/bin:$PATH
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions（`.github/workflows/build-apk.yml`）也可构建（tag `v*` 或手动触发）。

## 测试

```bash
npx tsx src/engine/selftest.ts       # 宏引擎/解析器
npx tsx src/engine/selftest2.ts      # 价格/预设宝宝化
npx tsx src/engine/pipeline.e2e.ts   # 渲染链 mock e2e
npx tsx src/engine/extractor.e2e.ts  # 事实提取 e2e
npx tsx src/e2e/uitest.ts            # 浏览器端到端（需 dev server）
```

## 目录

```
src/engine/   宏引擎/预设/解析/定价/提取
src/stores/   Pinia（data/chat）
src/views/    对话/面板/设置/预设开关/关系图
src/db.ts     Dexie schema
docs/         设计文档与截图
```
