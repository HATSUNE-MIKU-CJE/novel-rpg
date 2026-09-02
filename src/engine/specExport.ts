/**
 * 世界书格式规范导出（v2）。
 * 生成：字段说明 markdown + JSON Schema + 示例文件，供用户手写 / 交给其他 AI 编写世界书。
 * v3.5：从 v1（仅 key/content/enabled + 老式 characters）升级为 v2 八类卡体系：
 *   kind + payload（各卡结构化载荷）+ hook + timeline + isMain，导入即入卡体系。
 */

export const WORLD_SPEC_VERSION = 2

export const formatSpecMarkdown = `# 世界书格式规范 v${WORLD_SPEC_VERSION}

本规范定义 NovelRPG 的世界书（Worldbook）交换格式。手写或交给其他 AI 编写世界书时，
请按此格式组织 JSON 文件，然后在 App 面板「世界书 → ＋ 新建 → 导入」中导入。
导入后：人物卡进「角色」tab（可设主角），地点/物品/事件/规则/势力/时期卡进「世界」tab，
备注类条目按触发词注入对话；所有条目均可继续在 App 内编辑。

## 顶层结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| version | number | ✅ | 固定 ${WORLD_SPEC_VERSION} |
| worldbook | object | ✅ | 世界书元信息 |
| worldbook.name | string | ✅ | 世界书名称 |
| worldbook.description | string | - | 一句话描述 |
| entries | array | - | 世界条目（核心：每条 = 一张卡/设定） |
| characters | array | - | 旧版角色卡（v1 兼容；导入时自动转成人物卡条目） |
| relations | array | - | 关系（可选，导入后进关系图） |

## 条目字段（核心）

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| kind | string | - | 卡类型：character / location / item / event / rule / faction / timeline / note；缺省 = note |
| key | string \| string[] | - | 触发词（数组或逗号分隔字符串）；空/缺省 = 常驻条目，始终注入 |
| content | string | ✅ | 正文/详情（触发时注入的完整段落；note 类即条目正文） |
| hook | string | - | 常驻精要一行（推荐人物/地理卡：每轮必读的一句话） |
| payload | object | - | 结构化载荷（字段随 kind，见下） |
| timeline | string | - | 时期标签（如「斗一」「神界传说」）；非当前时期自动封存不注入 |
| isMain | 0 \| 1 | - | 主角标记（仅人物卡）；1 = 存档主角，hook 必带 |
| enabled | boolean | - | 默认 true；false = 导入后停用 |

> 兼容 SillyTavern world_info.json：导入时自动识别 \`entries[].keys\`、\`constant\` 等字段；
> \`constant=true\` → 常驻条目；\`priority\`/\`depth\` 等字段忽略。

## 各类型卡的 payload 字段

### 👤 人物卡（kind=character）★最重要

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 人名（卡面标题；缺省时自动从 hook/key 补） |
| identity | string | 身份/称号，如「史莱克学院学员」 |
| realm | string | 境界/段位（自由文本） |
| attributes | array | 角色属性 [{ "label": "智力", "value": 8 }]，value 0-100 |
| behavior | string | 行为逻辑/底线（触发详情） |
| barValues | object | 状态条数值 {"血条": 62} |
| status | object | 状态卡当前值 {"体力": "60%", "收集物资": ["旧魔法书"]} |

### 📍 地理卡（kind=location）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 地名 |
| region | string | 所属区域 |
| danger | number | 危险度 0-100（0=安全） |
| features | string | 地貌/特色 |
| residents | string | 居民/势力 |

### 💎 物品卡（kind=item）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 物品名 |
| category | string | 类别（武器/灵药/装备…） |
| effect | string | 效果/用途 |
| holder | string | 持有者 |
| state | string | 状态（破损/封印/完整…） |

### 📜 事件卡（kind=event）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 事件名 |
| time | string | 时间（如「斗一第 3 年」） |
| place | string | 地点 |
| detail | string | 经过/影响 |

### ⚔ 规则卡（kind=rule）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 规则名（如「魂环获取规则」） |
| scope | string | 适用范围 |
| clauses | string | 条款/内容 |
| consequence | string | 违例后果 |

### 👥 势力卡（kind=faction）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 势力名 |
| members | string | 成员/首脑 |
| goal | string | 目标 |
| territory | string | 地盘 |
| relations | string | 对外关系 |

### 📅 时期卡（kind=timeline）

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | ✅ 时期名 |
| range | string | 起止 |
| overview | string | 概览 |

### 📝 备注（kind=note，缺省）

无 payload；\`content\` 即条目正文。适合一条一句的世界观基点（常驻）或细节补充（触发）。

## 完整示例

\`\`\`json
{
  "version": ${WORLD_SPEC_VERSION},
  "worldbook": { "name": "星海纪 · 第一卷", "description": "示例：星海大陆基础设定" },
  "entries": [
    {
      "kind": "character",
      "key": ["林一", "阿一"],
      "hook": "林一：铁匠学徒，天生怪力",
      "content": "星海城铁匠铺学徒，15 岁。力气大得反常，能徒手拉弯铁条；身份存疑——脖子上有半枚古币吊坠。",
      "payload": {
        "name": "林一",
        "identity": "铁匠学徒",
        "realm": "无",
        "attributes": [ { "label": "力量", "value": 9 }, { "label": "灵性", "value": 4 } ],
        "behavior": "护短，报酬给够什么都肯修；对古币吊坠的来源不愿多谈。"
      },
      "timeline": "第一卷",
      "isMain": 1
    },
    {
      "kind": "character",
      "key": "苏月",
      "hook": "苏月：药庐传人，云游商人",
      "content": "背着药箱云游的青年医师，记性极好。真实身份是药庐这一代的传人，因师门禁令隐姓埋名。",
      "payload": { "name": "苏月", "identity": "药庐传人 · 云游商人", "attributes": [ { "label": "灵性", "value": 8 } ] }
    },
    {
      "kind": "location",
      "key": ["星海城"],
      "hook": "星海城：北境第一大城，魂导器交易中心",
      "content": "北境第一大城，城墙嵌着夜明珠，夜里如星河。城内魂导器铺子林立，黑市与官方集市并立。",
      "payload": { "name": "星海城", "region": "北境", "danger": 20, "features": "明珠城墙 · 双市场格局", "residents": "人类与矮人混居" }
    },
    {
      "kind": "item",
      "key": "古币吊坠",
      "hook": "古币吊坠：林一半枚吊坠，可能是神裔信物",
      "content": "半枚古币吊坠，断口光滑如镜，隐隐发热时附近必有魂力波动。",
      "payload": { "name": "古币吊坠", "category": "信物", "effect": "感应魂力波动", "holder": "林一", "state": "断裂（半枚）" }
    },
    {
      "kind": "rule",
      "key": ["魂力", "觉醒"],
      "content": "魂力觉醒：16 岁前未经仪式觉醒，魂力终其一生无法再激活；觉醒仪式需要最低的魂力亲和度。",
      "payload": { "name": "魂力觉醒规则", "scope": "全大陆", "clauses": "16 岁前需完成觉醒仪式", "consequence": "错过即无法激活魂力" }
    },
    {
      "kind": "event",
      "key": "明珠夜陨",
      "content": "三年前明珠夜，星海城上空一颗火球坠入北境冰原，此后城中魂力波动异常。",
      "payload": { "name": "明珠夜陨", "time": "斗罗历前 3 年", "place": "星海城 · 北境冰原", "detail": "城内开始出现天然觉醒的魂力者" }
    },
    {
      "kind": "faction",
      "key": ["药庐"],
      "content": "隐世医者组织，掌握古药典与灵植栽培术，每代只出一位行走世间的传人。",
      "payload": { "name": "药庐", "members": "苏月（当代传人）", "goal": "守护古药典不外传", "territory": "南岭云雾山", "relations": "与官方魂师殿保持距离" }
    },
    {
      "kind": "timeline",
      "key": ["星海纪"],
      "content": "卷一：铁匠学徒的觉醒。",
      "payload": { "name": "星海纪 · 第一卷", "range": "明珠夜陨后第 3 年", "overview": "林一觉醒魂力，追逐古币吊坠的秘密" }
    },
    {
      "content": "大陆通用货币为「星币」，1 星币 = 10 银角 = 100 铜子。"
    }
  ],
  "relations": [
    { "from": "林一", "to": "苏月", "relType": "同伴", "label": "一起冒险" }
  ]
}
\`\`\`

## 导入行为说明

- 自动识别本规范（v2）/ 旧版（v1：无 kind/payload，characters 数组）/ SillyTavern world_info
- 导入时自动清洗 ST 原文：\`{{宏}}\`、HTML/XML 标签、\`---\` 分隔线会从正文剥离（避免 UI 显示违和的英文结构）
- \`kind=character\` 且 payload 缺 name 时，自动从 hook/key/comment 提取补全
- 人物卡 \`key\` 为空时，自动补人物名作为触发词（避免整张卡常驻全量注入）
- 条目全部以 \`source=imported\` 标记，可正常参与注入与编辑
- \`characters\` 旧字段（v1）导入时自动转成人物卡条目；\`relations\` 进关系图
- 重复导入会创建副本（不自动去重），建议先删除旧版
`

export const formatSpecSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "novel-rpg-worldbook-v${WORLD_SPEC_VERSION}",
  "title": "NovelRPG 世界书格式 v${WORLD_SPEC_VERSION}",
  "type": "object",
  "required": ["version", "worldbook"],
  "properties": {
    "version": { "const": ${WORLD_SPEC_VERSION} },
    "worldbook": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" }
      }
    },
    "entries": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["content"],
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["character", "location", "item", "event", "rule", "faction", "timeline", "note"]
          },
          "key": { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
          "content": { "type": "string" },
          "hook": { "type": "string" },
          "timeline": { "type": "string" },
          "isMain": { "enum": [0, 1] },
          "enabled": { "type": "boolean" },
          "payload": {
            "type": "object",
            "properties": {
              "name": { "type": "string" },
              "identity": { "type": "string" },
              "realm": { "type": "string" },
              "attributes": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["label", "value"],
                  "properties": {
                    "label": { "type": "string" },
                    "value": { "type": "number", "minimum": 0, "maximum": 100 }
                  }
                }
              },
              "behavior": { "type": "string" },
              "barValues": { "type": "object", "additionalProperties": { "type": "number" } },
              "status": { "type": "object", "additionalProperties": { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] } },
              "region": { "type": "string" },
              "danger": { "type": "number", "minimum": 0, "maximum": 100 },
              "features": { "type": "string" },
              "residents": { "type": "string" },
              "category": { "type": "string" },
              "effect": { "type": "string" },
              "holder": { "type": "string" },
              "state": { "type": "string" },
              "time": { "type": "string" },
              "place": { "type": "string" },
              "detail": { "type": "string" },
              "scope": { "type": "string" },
              "clauses": { "type": "string" },
              "consequence": { "type": "string" },
              "members": { "type": "string" },
              "goal": { "type": "string" },
              "territory": { "type": "string" },
              "relations": { "type": "string" },
              "range": { "type": "string" },
              "overview": { "type": "string" }
            },
            "additionalProperties": true
          }
        },
        "additionalProperties": true
      }
    },
    "characters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string" },
          "identity": { "type": "string" },
          "realm": { "type": "string" },
          "attributes": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["label", "value"],
              "properties": { "label": { "type": "string" }, "value": { "type": "number" } }
            }
          },
          "description": { "type": "string" }
        }
      }
    },
    "relations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["from", "to", "relType"],
        "properties": {
          "from": { "type": "string" },
          "to": { "type": "string" },
          "relType": { "type": "string" },
          "label": { "type": "string" }
        }
      }
    }
  },
  "additionalProperties": true
}`
