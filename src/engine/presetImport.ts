/**
 * ST 预设导入器：解析 SillyTavern 预设 JSON → 内部 Preset 结构。
 *
 * 拣取：prompts[]（name/role/content/enabled）与顶层采样参数。
 * 忽略：prompt_order、extensions、wi_format 等 ST 专属字段。
 */

export interface PresetPromptBlock {
  name: string
  role: 'system' | 'user' | 'assistant'
  content: string
  enabled: boolean
}

export interface ImportedPreset {
  name: string
  sourceName: string
  prompts: PresetPromptBlock[]
  params: {
    temperature?: number
    topP?: number
    frequencyPenalty?: number
    presencePenalty?: number
    maxTokens?: number
    useSysprompt?: boolean
  }
}

export function parseStPresetJson(raw: string, sourceName = '未知预设.json'): ImportedPreset {
  const data = JSON.parse(raw)
  if (!data || typeof data !== 'object') {
    throw new Error('预设文件不是 JSON 对象')
  }

  const prompts: PresetPromptBlock[] = []
  if (Array.isArray(data.prompts)) {
    for (const p of data.prompts) {
      if (!p || typeof p !== 'object') continue
      const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system'
      prompts.push({
        name: String(p.name ?? ''),
        role,
        // ST 独有宏兼容：charIfNotGroup → char；groupChar 等单体化处理
        content: String(p.content ?? '')
          .replace(/\{\{\s*charIfNotGroup\s*\}\}/g, '{{char}}')
          .replace(/\{\{\s*charIfGroup\s*\}\}/g, '{{group}}')
          .replace(/\{\{\s*group[Gg]roup\s*\}\}/g, '{{group}}'),
        enabled: !!p.enabled,
      })
    }
  }

  // 顶层采样参数（ST 字段格式）
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) ? n : undefined
  }

  return {
    name: String(data.name || sourceName.replace(/\.json$/i, '')),
    sourceName,
    prompts,
    params: {
      temperature: num(data.temperature),
      topP: num(data.top_p),
      frequencyPenalty: num(data.frequency_penalty),
      presencePenalty: num(data.presence_penalty),
      maxTokens: num(data.openai_max_tokens),
      useSysprompt: data.use_sysprompt === undefined ? undefined : data.use_sysprompt === 'True' || data.use_sysprompt === true,
    },
  }
}
