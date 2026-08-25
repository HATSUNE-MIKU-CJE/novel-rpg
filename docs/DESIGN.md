# 设计文档：小说跑团（NovelRPG）

> 手机端 AI 视觉小说 / 跑团工具。AI 推进故事，并自动把故事中的新事实沉淀进「世界书」；
> 支持多存档、角色面板、关系图；API 自由配置（OpenAI 兼容）。

- 形态：Capacitor APK（手机本地安装，数据存本地 SQLite，无需服务器）
- 风格：轻色调卡牌风
- 生态兼容：SillyTavern 世界书 / 角色卡格式

---

## 1. 核心概念

| 概念 | 说明 |
|------|------|
| 存档 Campaign | 一段故事的容器 = 对话历史 + 绑定的世界书 + 角色 + 关系 |
| 世界书 Worldbook | 一组「世界条目（entry）」，是世界的记忆 |
| 条目 Entry | 触发词 key + 内容 content + 类型 + 优先级 + 深度 |
| 角色 Character | 身份卡（姓名/身份/属性/状态/头像），AI 提取自动生长，可手工改 |
| 关系 Relation | 角色之间的有向边（亲缘/敌友/恋人/…） |

**闭环**：对话 → AI 提取事实 → 写入世界书 → 后续对话注入世界书 → 更一致的故事。

---

## 2. 功能需求

### 2.1 对话（主界面）
- 聊天流 UI，多轮对话，AI 扮演角色/旁白推进故事
- 系统提示词可配置：世界观、叙事风格、人称、回复格式（对话/旁白/动作）
- 世界书注入：常驻条目始终注入；触发条目按触发词匹配注入（命中即注入，无深度/优先级概念）
- 每轮对话可选触发上下文压缩（长对话时）
- 快捷操作：整理世界书、打开面板、切换存档

### 2.2 世界书（极简版）
- 条目只有三个核心字段：**触发词 key（可空）+ 内容 content + 来源**（手动 / AI）
- 条目仅两种类型：
  - **常驻条目**（蓝灯）：无触发词，永远注入对话，适合世界根基设定
  - **触发条目**（绿灯）：有触发词，对话中出现关键词时才注入，适合人物/地点设定
- **AI 自动写入**：定期整理（默认每 5 轮）+ 手动「整理」按钮；产出进「自动笔记簿」
- 导入 / 导出：SillyTavern 格式（JSON）+ 自定义规范
- 搜索、来源标记（manual / ai）

> 明确砍掉：优先级、注入深度、条目排序、动态宏、绿灯缓存、向量化检索、蓝灯/绿灯的中间状态。——这些是 SillyTavern 世界书体系的复杂机制，本 App 用「常驻/触发」两态即可覆盖游玩需求。

### 2.3 存档
- 多存档：新建 / 重命名 / 删除 / 切换
- 每存档绑定多本世界书，绑定方式二选一：
  - **引用**（ref）：改一处，其他存档同见（保持一致）
  - **拷贝**（copy）：独立演化（不同副本）
- 每存档通常自动带一本专属「自动笔记簿」（AI 写入的默认目标）

### 2.4 面板
- **角色面板**：角色列表 → 详情卡（头像、身份、属性自定字段、状态、来源）
- **关系图**：节点=角色，边=关系，可缩放查看，点节点查看卡片
- **世界书面板**：条目列表、审阅自动条目（接受 / 编辑 / 拒绝 / 迁移到正式世界书）

### 2.5 设置
- **API 配置**：多个配置项，每项 = baseURL + apiKey + model（+ 可选自定义请求头/参数）；可切换主用；apiKey 仅存手机本地
- 模型参数：温度、max tokens、top_p
- 自动整理开关 + 频率（每 N 轮）
- 数据管理：整库导出 / 导入（备份），清空某存档
- **导出「世界书格式规范」**：README + JSON Schema + 示例，方便手写世界书后导入

---

## 3. 数据模型（SQLite）

```sql
-- API 配置（可多条，一条默认）
api_configs(id, name, base_url, api_key, model, headers_json, temperature, max_tokens, top_p, is_default, created_at)

-- 世界书（global = 全局共享；campaign = 存档专属）
worldbooks(id, name, description, scope, created_at, updated_at)

-- 世界书条目（极简：触发词 + 内容 + 来源；常驻=key 空）
entries(id, worldbook_id, key,          -- 触发词（空 = 常驻）
        content, enabled,
        source,        -- manual | ai | imported
        status,        -- ai 条目：pending | accepted | rejected
        created_at, updated_at)

-- 存档
campaigns(id, name, system_prompt, narrative_style, auto_interval, -- 每 N 轮自动整理
          preset_json,   -- 当前使用的预设快照（prompts 数组 + 参数）
          vars_json,     -- 会话变量（sleep_var_* 等宏变量），存档级
          created_at, updated_at, last_active)

-- 预设（导入的 ST 预设，可复用）
presets(id, name, source_name, prompts_json, params_json, created_at)

-- 存档 × 世界书 绑定（mode: ref | copy）
campaign_bindings(id, campaign_id, worldbook_id, mode, created_at)

-- 对话消息
messages(id, campaign_id, role, content, seq, created_at,
         parsed_json,            -- assistant：dream_plot 解析结果
         usage_json)             -- assistant：{prompt_tokens, completion_tokens, total_tokens}

-- 角色
characters(id, campaign_id, name, avatar, identity, attributes_json, status_json,
           description, source,  -- manual | ai
           created_at, updated_at)

-- 关系
relations(id, campaign_id, from_char, to_char, rel_type, label, description, created_at)
```

---

## 4. AI 自动写世界书机制（核心）

**触发**：每 N 轮用户消息（默认 5，可配置 / 关闭）+ 手动「整理」按钮。

**流程**：
1. 取最近 N~2N 轮对话（避免整库全文，省 token）
2. 低温度调用一次「事实提取」：输出严格 JSON
   ```json
   {
     "characters": [{"name","identity","attributes":{},"description"}],
     "relations":  [{"from","to","rel_type","label"}],
     "facts":      [{"key":["关键词"],"content":"一条事实"}]
   }
   ```
3. **增量合并**：已有实体（按名字匹配）只更新描述，不重复建新条目
4. 结果写入存档专属「自动笔记簿」，条目 `source=auto, status=pending`
5. 用户在面板审阅：接受（迁移/复制到正式世界书）/ 编辑/拒绝

**提取 Prompt 设计要点**：
- 输出仅 JSON，禁止多余文字
- 一条事实一记，不写大段落
- 「已存在的不重复创建，仅更新」——把已有实体名列表塞进 prompt 做参考
- 提取器与主对话尽量用同一 API 配置（或单独提取配置）

---

## 5. 世界书格式规范（自定 + SillyTavern 兼容）

### 自定义规范（JSON）
```json
{
  "version": 1,
  "worldbook": {"name": "艾泽拉斯的密辛", "description": "..."},
  "entries": [
    {"key": ["铁炉堡"], "content": "...", "enabled": true}
  ],
  "characters": [
    {"name": "麦格尼·铜须", "identity": "铁炉堡国王", "attributes": {...}, "description": "..."}
  ],
  "relations": [
    {"from": "麦格尼·铜须", "to": "吉安娜·普罗德摩尔", "rel_type": "同盟", "label": "盟友"}
  ]
}
```

> 条目极简：`key`（触发词，空/缺省 = 常驻）+ `content` + `enabled`。导入时遇到
> SillyTavern 的 `constant` / `priority` / `depth` 等字段：**读取，但仅映射**：
> `constant=true` → key 置空（常驻）；`priority`/`depth` 直接忽略。

### 导入兼容
- 识别 SillyTavern `world_info.json` / lorebook JSON（`entries[].keys`、`constant`、`content`、`priority`、`depth`）→ 自动转换映射（key = keys 合并；constant=true → 常驻）
- 识别本自定义规范 → 直接导入（无 entries 时按 characters/relations 生成角色卡和关系）
- 角色卡（ST char card：`name`/`description`/`personality`/`first_mes` 等）→ 生成角色 + 种子对话

### 导出
- 世界书 → 自定义规范 JSON（`worldbook` / `entries` / `characters` / `relations` 全量）
- 世界书 → SillyTavern 兼容 JSON（子集，补 `constant`/`priority`/`depth` 默认值）
- **规格文档**：App 内置「世界书格式规范」页 = 字段表 + JSON Schema + 一份示例文件，可整页分享/保存成 md/json

---

## 6. 预设引擎（梦鲸思客预设支持）★核心

用户使用「梦鲸思客 V4」SillyTavern 预设（`梦鲸思客V4-0731.json`），App 必须能导入并执行该预设。
**裁剪原则**：SillyTavern 所依赖的复杂注入机制（深度注入、绿灯缓存、动态宏、排序）全部砍掉，
但预设**自身的运行必须完整**——它的玩法核心（XML 输出协议、变量系统、文风选择）依赖以下引擎。

### 6.1 预设 JSON 解析（导入器）
读取 ST 预设 JSON，拣取：
- `prompts[]`：顺序化提示词块（`name` / `role` / `content` / `enabled`）
- 顶层参数：`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`max_tokens`、`use_sysprompt`
- 忽略：`prompt_order`、`extensions`、`wi_format` 等 ST 专属字段

导入后按 `prompts` 原始顺序渲染（不再使用 ST 的 injection_depth/排序表）。

### 6.2 宏系统（必须有，预设命脉）
实现一套与 ST 兼容的最小宏引擎：
- `{{setvar::name::value}}` / `{{addvar::name::value}}` / `{{getvar::name}}` —— 会话变量（存档级）
- `{{getglobalvar::name}}` / `{{setglobalvar::name::value}}` —— 全局变量（应用级）
- `{{lastUserMessage}}` / `{{char}}` / `{{user}}` / `{{group}}` —— 内置变量
- `{{压缩相邻消息::lora_key}}` / `{{压缩相邻消息::lora_constant}}` —— 世界书注入点（见 6.3）
- 变量值可含任意文本（XML、协议文本），宏可嵌套

### 6.3 世界书注入（绿灯/蓝灯语义的极简版）
预设中的两个注入点：
- `{{压缩相邻消息::lora_constant}}`（`常驻蓝灯设定`）→ **常驻条目**（key 为空）合并文本
- `{{压缩相邻消息::lora_key}}`（`绿灯与变量条目`）→ **本轮命中的触发条目**（触发词匹配）合并文本

注：`变量初始化` 等块本身也会用 `{{setvar}}` 初始化变量，引擎按顺序执行即可。
ST 的「压缩相邻消息」扩展负责的复杂逻辑（缓存/去重/绿卡）不实现——本 App 每次请求时
按「当前对话历史 + 当前世界书」实时计算命中条目，简单直接。

### 6.4 XML 输出协议解析（DREAM_PLOT）
预设约定模型回复为 `<dream_plot>` 根节点，内含：
- `<dream_body>`：正文（UI 展示，加粗/卡片化）
- `<dream_after_format>`：后置格式（状态栏等；无内容时是 `<dream_done/>`）
- `<dream_scene>`：场景信息栏（日期/时间/地点）→ 渲染为剧情信息卡
- `<dream_option>`：可选分支选项按钮
- `<dream_discuss>`：思客说书（共创讨论）→ 折叠卡

App 端解析器：提取 body 作为主文本渲染，其余节点转 UI 卡片，标签本身不展示。

### 6.5 输出清洗
- 正则脚本：删除 `<dream_after_thinking>`、隐藏 `<dream_body>`/`<dream_after_format>` 标签（等同预设附带的 regex_scripts）
- 失败兜底：模型未按 XML 输出时，直接按普通文本展示（不报错）

### 6.6 引擎能力边界（明确裁剪）
| ST 机制 | 本 App |
|---------|--------|
| injection_depth / 顺序表 | 砍：按 prompts 数组顺序 |
| 压缩相邻消息扩展（缓存/绿卡/聚合） | 砍：实时命中即注 |
| 世界书优先级/深度 | 砍：常驻/触发两态 |
| 动态宏 / getwi / EJS | 砍 |
| 角色卡字段兼容 | 保留（name/desc/personality/first_mes/mes_example） |
| 思考链标记（think 标签） | 保留：按预设配置展示/剥离 |

---

## 6A. 内置预设（梦鲸思客精简版）★用户要求 v2

不依赖外部 JSON 导入——App **内置**一份裁剪后的梦鲸思客预设（基于 V4-0731，去掉 ST 专属槽位
与空块），并做成**可视化配置面板**，用户在预设页直接拨开关。

### 6A.1 内置方式
- 预设以模块分组形式内置（代码内一份「分组定义 + 提示词模板常量」，不塞整包 JSON）
- 用户建存档时默认即带「梦鲸思客·精简」预设，可另选「简易叙事」（兜底）或无预设

### 6A.2 配置开关（单选组 / 多选组）
从原预设提取的分组（默认值与交互照搬 V4 的用户习惯）：

| 分组 | 类型 | 选项 | 默认 |
|------|------|------|------|
| 📚 主要文风 | 单选 | 无文风 / 新实验文风 / **梦白话文风** / 萌系轻小说 / 自定义 | 梦白话 |
| ✨ 次要文风 | 多选 | 保持信息差 / 色色防回避 / 色色软强化 / 禁止霸总 / NSFW-感官刺激 / NSFW-古风 | 信息差+防回避 |
| 🫵 角色设定 | 单选 | **用户是 user** / 用户是 char / 上帝视角 / 自定义角色 | 用户是user |
| 🥷 人称设定 | 单选 | 第一人称 / 第二人称 / **第三人称** | 第三人称 |
| 🔫 抢话设定 | 单选 | **转述不抢话** / 深度扮演 / 转述抢话 / 严禁抢话 / 大纲 | 不抢话 |
| ▶️ 叙事者 | 单选 | **平衡叙事** / 波谲云诡 / 现实难度 / 性压抑者 / 自定义 | 平衡 |
| 🖌️ 字数要求 | 单选 | 1000字 / 2500字 / **动态字数长** / 动态字数短 / 自定义 | 动态长 |
| 🚫 模型禁词 | 单选 | **DeepSeek禁词** / Glm/Gemini禁词 / 自定义 / 关闭 | DeepSeek禁词 |
| 🔗 渠道适配 | 单选 | **DeepSeek官方** / 硅基流动 / KimiK3思考 / 关闭 | DeepSeek官方 |
| 🧠 思考强度 | 单选 | **普通思考** / 超短思考 / 雷霆大思考 / 超级雷霆大 | 普通 |
| ⚙️ 其他协议 | 多选 | 梦境场景信息(常开) / 八股超杀 / 梦境选项-正常 / 梦境选项-NSFW / 思客说书 / 思客大调查 / 梦鲸摘要 | 场景信息 |
| ✍️ 输出模式 | 单选 | **写作模式** / 大总结 / 聊天 / 创作 | 写作 |

### 6A.3 配置的存储与生效
- 配置存存档级（每存档独立），含：分组选择 + 自定义文风/字数/禁词文本
- 渲染时按分组映射替换模板中的 `{{setvar}}` 初始化值（无需启用/禁用块，分组模板即渲染源）
- 后续导入外部 ST 预设仍支持（走 6 章导入器，无开关面板，仅原始 JSON）

### 6A.4 选项描述与自定义参数（v2.1 优化）★用户要求

现状问题：56 个选项只有名字没有说明；自定义项（自定义文风/字数/禁词/角色/叙事者）虽是
占位符却**无编辑入口**，等于摆设。

**交互模型（选项两态）**：
- 折叠态：一行 = 选项名 + 一句话描述（每个选项必备 `desc`）
- 展开态：点按展开 ▼ = 详细说明（`detail`：效果、适用场景、何时选它）+ 可配置参数区（如有）
- 展开态高亮框（accent-soft 底）；「恢复默认」小按钮在组标题右侧

**v2.1 宝宝化（已完成 ✅）**：
- 叙事者用作者预埋的「色号人格」：⚪中庸之白 / 🔵狂澜之青 / 🔴深暗之红 / 🟡色色之黄（原档位名对照显示）
- 思考强度宝宝化：轻快（~400）/ 标准（~2000）/ 深度（ultra）/ 极致（max），描述说清质量-成本权衡
- 渠道适配默认「自动」：按模型名判断思考标记（deepseek-* / kimi-* / 其他），手动档收进「高级选项」折叠区
- 动态字数短修正为原文「500 到 1200 字」

**可编辑项（custom 参数）筛选**：

| 参数 | 字段 | 门槛 | 说明 |
|------|------|------|------|
| 自定义文风 | 文本域 | ★低 | 完整文风指令，选中「自定义文风」时生效 |
| 自定义字数 | 数字/区间 | ★低 | 如 1500 或「800-1500」，替代固定档位 |
| 自定义禁词 | 每行一词 | ★低 | 追加到默认禁词后 |
| 自定义角色 | 一行 | ★低 | 用户扮演角色名/身份 |
| 自定义叙事者 | 文本域 | ★★中 | 叙事者思维链（预设作者向） |
| 自定义缝合处 | 文本域 | ★★中 | 设定区尾部私有扩充指令 |
| 思考预算微调 | 数字 | ★★中 | 普通思考的 2000 预算可改（档位二选一） |

**只描述不编辑**：预置文风包/叙事者包/思考档位/协议类——展开给详细描述，不给编辑框，
避免预设面板退化成配置面板。

**渲染注入**：自定义值不再走 `{{getglobalvar::dream_custom_xxx}}` 占位（宏引擎里是死的），
改为**生成变量初始化链时直接内联**用户输入（如 `setvar::sleep_var_zishu::输出约 1500 字`）；
用户输入中 `{{` 转义防宏注入。自定义项选中且未配置时，面板给出引导文案与状态徽标。

---

## 6B. 内置 API 节点 ★用户要求 v2

默认预置两个节点（安装即用，key 用户自填）：

| 节点 | baseURL | 默认模型 | 模型列表 |
|------|---------|---------|---------|
| DeepSeek 官方 | `https://api.deepseek.com/v1` | deepseek-chat | deepseek-chat / deepseek-reasoner |
| opencode-go 网关 | `https://opencode.ai/zen/go/v1` | deepseek-v4-flash | minimax-m3 / qwen3.7-max / qwen3.7-plus / deepseek-v4-flash / deepseek-v4-pro / kimi-k3 / minimax-m2.7 / grok-4.5 |

- 首次启动自动种入这两条配置（`isDefault` 标记 opencode-go），key 留空占位
- 模型选择为下拉（可手输任意值——自建 vLLM/转发站场景）
- 「设为默认」逻辑不变；节点可增删改

---

## 6C. Token 花费统计 ★用户要求 v2

### 6C.1 数据
- `chat/completions` 响应带 `usage`：`prompt_tokens` / `completion_tokens` / `total_tokens`
- DeepSeek 官方额外字段：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- 每条 assistant 消息落库时附加 `usageJson`

### 6C.2 展示
- 每轮助手消息下方小字：`↑ 3.2k ↓ 1.1k 共 4.3k token`
- 存档页/会话页顶部累计：本存档总 token、总轮数、平均每轮
- 设置页全局累计：所有存档合计

### 6C.3 金额折算（仅 DeepSeek 官方节点）★按官网实时价格
价格表内置（来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ，2026-08 抓取）：

| 模型 | 输入·缓存命中 空闲/高峰 | 输入·未命中 空闲/高峰 | 输出 空闲/高峰 |（元/百万token）|
|------|------|------|------|
| deepseek-v4-flash | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |
| deepseek-v4-pro | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |
| deepseek-v4-flash-vision-exp | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |

- **峰谷判定**：高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00；其余为空闲（空闲=高峰×0.5）
- **计费模型**：金额 = hitT/1M×命中空闲/高峰价 + missT/1M×未命中价 + outT/1M×输出价（按请求时刻判定峰谷；DeepSeek 是「请求发起时」计价）
- 模型匹配：按 apiConfig.model 精确匹配；未知模型 → 仅显示 token 不折算，UI 提示「该模型无内置价格」
- 价格表版本随官方变动更新（文档注明抓取日期）；opencode-go 等其他节点不做金额折算

---

## 6D. 输出 token 上限 ★用户要求 v2

- 设置页「每次输出上限」：数字输入，**无硬性上限**（对应预设 openai_max_tokens=30000 改为用户可调）
- 上限语义：
  - 填 `0` = 不设限（请求体不带 max_tokens 字段，交给模型默认/8192）
  - 填任意值 = 透传 max_tokens
- 默认值 4000（当前 API 配置项中的 maxTokens 字段复用）

---

## 6E. 功能扩展候选（用户说「可以搞多」，按价值排序）

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 对话搜索 | 全存档消息全文检索（含世界书） | P1 |
| 上下文压缩（长对话） | 超长时自动/手动摘要旧轮次，替换历史，省 token | P1 |
| 会话变量查看器 | 查看/编辑 sleep_var_*（调试预设用） | P2 |
| 消息重发 | 对某条助手消息「重新生成」（删掉该轮重发） | P2 |
| 快捷填充 | 预设输出模式切换按钮（写作/大总结/聊天/创作）挂聊天页顶部 | P2 |
| 存档导出 | 存档全量（消息+世界书+变量）导出 JSON/markdown | P2 |
| 主题切换 | 浅色纸感 / 深色梦境 | P3 |
| 世界书条目引用统计 | 展示条目被注入次数 | P3 |
| 预设配置共享 | 一键复制配置 JSON，发给朋友 | P3 |
| 语音朗读（TTS） | 可选的剧情朗读 | 待定 |



---

## 7. 界面结构（轻色调卡牌风）

```
┌─────────────────────────────┐
│  Tab1 对话                    │
│  ┌───────────────────────┐  │
│  │ 存档选择器（横滑卡片）     │  │
│  ├───────────────────────┤  │
│  │ 聊天流（气泡/剧情旁白卡）  │  │
│  │   …                     │  │
│  ├───────────────────────┤  │
│  │ 输入框 + 快捷操作(整理)   │  │
│  └───────────────────────┘  │
├─────────────────────────────┤
│  Tab2 面板                   │
│  角色卡组 / 关系图 / 世界书列表│
├─────────────────────────────┤
│  Tab3 设置                   │
│  API配置 / 模型参数 / 自动整理 │
│  数据管理 / 格式规范导出       │
└─────────────────────────────┘
```

- 浅色底（#f7f5f2 纸感），卡牌圆角 + 柔和阴影
- 角色卡带头像占位（可后续接图片/AI 立绘）
- 关系图：SVG 力导向或 cytoscape，支持缩放、点节点看卡

---

## 8. 技术方案

| 层 | 选型 |
|----|------|
| 应用壳 | Capacitor 5（Android），Web 前端打包进 APK |
| 前端 | Vue 3 + TypeScript + Vite + Pinia |
| UI | 自绘轻量组件（卡牌风）或 Vant 基础组件 |
| 存储 | SQLite（@capacitor-community/sqlite），结构化 + 可导出 .db |
| HTTP | 原生 fetch（Capacitor 无 CORS 限制，key 仅本地） |
| 关系图 | cytoscape.js 或自绘 SVG |
| 构建 | gradle 命令行打包 APK（本机装 Android SDK；也可托管 GitHub Actions 构建） |

风险与对策：
- **构建环境**：本机需 Java + Android SDK（约 2~3 GB）；若本机不便，用 GitHub Actions 免费构建，出 APK 产物
- **token 成本**：自动整理是额外调用，默认间隔 5 轮 + 可关闭；提取用低温度小参数
- **模型不守 JSON**：提取调用加 response_format（可用时）或强 prompt + 解析兜底，解析失败则该轮跳过并在 UI 提示

---

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M1 骨架 | 脚手架 + SQLite schema + API 配置页 + 基础对话打通 + 宏引擎 | ✅已完成 |
| M2 预设引擎 | ST 预设导入 + prompts 顺序渲染 + XML 输出解析 + 世界书极简注入 | ✅已完成 |
| M3 内置化 | 内置梦鲸思客精简预设 + 分组开关面板 + 内置默认节点 + token 统计 + 输出上限自由调 + 上下文压缩 + 对话搜索 + 重发/模式切换 + 宝宝化 v2.1 | ✅已完成 |
| M4 自动写 | 事实提取 + 自动笔记簿 + 审阅面板 | ✅已完成 |
| M5 面板增强 | 关系图可视化（力导向 SVG）+ 存档×世界书绑定管理 + 格式规范导出 + 变量查看器 + 导入世界书 | ✅已完成 |
| M6 打磨 | 主题切换（深色梦境）+ 备份导入/导出 + Capacitor 接入 + APK 构建 | ✅已完成（APK：梦旅-v1.0.apk，4.2MB） |
| v1.2 双流 | 交流/游戏双对话流 + 开始游戏向导（设定卡+开场白）+ 双向同步按钮 + 模式废弃（聊天/创作并入交流栏、总结成游戏栏按钮）+ 角色详情弹层（属性雷达图）+ 角色卡注入开关 + 滚动容器重构 + 旧档迁移 | ✅已完成 |
| v1.3 属性与面板 | 存档级属性体系（维度+境界，AI 按维度强制提取、交流栏建议一键应用）+ 面板四栏重构（角色/关系/世界/配置，顶端存档切换）+ 世界 tab（分类板块 + 临时区确认写回）+ 角色全屏页（六维雷达+境界+关系+条目）+ 交流栏轻度引导 | ✅已完成 |

---

## 10. 待定/可扩展

- 头像：本地图片 vs AI 生成立绘（后续）
- 多 API 配置自动切换（主用挂了用备用）
- 语音朗读（TTS）—— 视觉小说沉浸感，需求后再加
- 时间线/事件日志面板
- 世界书条目「被引用计数」—— 便于清理无用条目
