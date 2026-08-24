/**
 * 世界书格式规范导出。
 * 生成：字段说明 markdown + JSON Schema + 示例文件，供用户手写世界书后导入。
 */

export const WORLD_SPEC_VERSION = 1

export const formatSpecMarkdown = `# 世界书格式规范 v${WORLD_SPEC_VERSION}

本规范定义 NovelRPG 的世界书（Worldbook）交换格式。手写世界书请按此格式组织 JSON 文件，
然后在 App 面板「世界书 → ＋ 新建 → 导入」中导入。

## 顶层结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| version | number | ✅ | 固定 ${WORLD_SPEC_VERSION} |
| worldbook | object | ✅ | 世界书元信息 |
| worldbook.name | string | ✅ | 世界书名称 |
| worldbook.description | string | - | 一句话描述 |
| entries | array | - | 世界条目（每条 = 触发词 + 内容） |
| characters | array | - | 角色卡（可选，导入后进角色面板） |
| relations | array | - | 关系（可选，导入后进关系图） |

## 条目字段（核心）

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| key | string[] | - | 触发词（多个用数组，或逗号分隔字符串）；空/缺省 = 常驻条目，始终注入对话 |
| content | string | ✅ | 条目正文，一句话到一段话 |
| enabled | boolean | - | 默认 true；false = 导入后停用 |

> 兼容 SillyTavern world_info.json：导入时自动识别 \`entries[].keys\`、\`constant\` 等字段。
> \`constant=true\` → 常驻条目；\`priority\`/\`depth\` 等字段忽略。

## 角色与关系（可选）

\`\`\`json
{
  "characters": [
    {"name": "麦格尼·铜须", "identity": "铁炉堡国王", "description": "矮人联军的领袖，性格固执但护短。"}
  ],
  "relations": [
    {"from": "麦格尼·铜须", "to": "吉安娜", "relType": "同盟", "label": "临时结盟"}
  ]
}
\`\`\`

## 完整示例

\`\`\`json
{
  "version": ${WORLD_SPEC_VERSION},
  "worldbook": {"name": "艾泽拉斯的密辛", "description": "艾泽拉斯世界观设定集"},
  "entries": [
    {"key": ["铁炉堡", "矮人"], "content": "铁炉堡是矮人王国的都城，建在活火山内部。"},
    {"key": "吉安娜", "content": "库尔提拉斯公主，塞拉摩的统治者，与部落若即若离。"},
    {"content": "王族徽记是锤子与铁砧的交叉图案。"}
  ],
  "characters": [
    {"name": "麦格尼·铜须", "identity": "铁炉堡国王", "description": "矮人联军的领袖。"}
  ],
  "relations": [
    {"from": "麦格尼·铜须", "to": "吉安娜", "relType": "同盟"}
  ]
}
\`\`\`

## 导入行为说明

- 条目全部以 \`source=imported\` 标记，可正常参与注入
- 角色/关系导入后进本存档（导入时若有打开的存档）或全局角色区
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
          "key": { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
          "content": { "type": "string" },
          "enabled": { "type": "boolean" }
        }
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
  }
}`
