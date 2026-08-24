/**
 * dream_plot XML 输出解析：把预设约定的 XML 回复拆成 UI 展示结构。
 *
 * 结构：
 *  <dream_plot>
 *    <dream_body>正文</dream_body>
 *    <dream_after_format>后置格式（含 <dream_done/> 或无内容）</dream_after_format>
 *    <dream_scene><date/><time/><location/></dream_scene>   <!-- 场景信息（可能位于 after_format 内） -->
 *    <dream_option>选项</dream_option>                      <!-- 可能多个 -->
 *  </dream_plot>
 */

export interface SceneInfo {
  date?: string
  time?: string
  location?: string
}

export interface ParsedDream {
  body: string           // 正文（dream_body 内的文本，无标签）
  scene?: SceneInfo
  options: string[]      // 选项列表
  afterFormat: string    // 后置格式化内容（不含 dream_done）
  raw: string
  isDreamPlot: boolean   // 是否为合法的 dream_plot 输出
}

const TAG_RE = /<\/?[a-zA-Z][^>]*>/g

function textOf(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function allTextOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim())
  return out
}

export function parseDreamPlot(raw: string): ParsedDream {
  const trimmed = raw.trim()
  const isDreamPlot = /^<dream_plot[\s>]/i.test(trimmed)

  const body = textOf(trimmed, 'dream_body') || trimmed
  // 场景块与选项已单独提取为卡片，afterFormat 里剥除整块
  const afterFormatRaw = textOf(trimmed, 'dream_after_format')
    .replace(/<dream_scene[\s\S]*?<\/dream_scene>/gi, '')
    .replace(/<dream_option[\s\S]*?<\/dream_option>/gi, '')
  const sceneDate = textOf(afterFormatRaw, 'date') || textOf(trimmed, 'date')
  const sceneTime = textOf(afterFormatRaw, 'time') || textOf(trimmed, 'time')
  const sceneLoc = textOf(afterFormatRaw, 'location') || textOf(trimmed, 'location')

  const scene: SceneInfo | undefined =
    sceneDate || sceneTime || sceneLoc
      ? { date: sceneDate, time: sceneTime, location: sceneLoc }
      : undefined

  const options = allTextOf(trimmed, 'dream_option').filter(Boolean)

  return {
    body,
    scene,
    options,
    afterFormat: afterFormatRaw.replace(/<dream_done\s*\/?>/gi, '').replace(TAG_RE, '').trim(),
    raw: trimmed,
    isDreamPlot,
  }
}
