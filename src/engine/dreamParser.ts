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
  // 允许杂质前缀（AI 偶发复述提示词/注入内容）：全文含 dream_plot 即视为合法输出
  const isDreamPlot = /<dream_plot[\s>]/i.test(trimmed)

  let body = textOf(trimmed, 'dream_body')
  if (!body) {
    // dream_body 未闭合（AI 坏结构）→ 从 <dream_body 之后取到结尾，剥除一切 XML 标签
    const bm = trimmed.match(/<dream_body[^>]*>([\s\S]*)/i)
    if (bm) {
      body = bm[1]
        .split(/<\/?dream_plot|<\/?dream_after_format|<\/?dream_option/i)[0]
        .replace(/<dream_scene[\s\S]*?<\/dream_scene>/gi, '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .trim()
    }
  }
  if (body) {
    // 统一剥除 body 内的协议标签（AI 偶发把 scene 嵌进 body）
    body = body
      .replace(/<dream_scene[\s\S]*?<\/dream_scene>/gi, '')
      .replace(/<\/?dream_[a-z_]+[^>]*>/gi, '')
      .replace(/<[a-zA-Z][^>]*>/g, '')
      .replace(/\[\[BAR\]\][\s\S]*?\[\/BAR\]/gi, '')
      .trim()
    // v2.1.2：body 内部的规范复述/碎片清洗（AI 把写作规范塞进正文前/后）
    body = stripBodyLeak(body)
  }
  if (!body) body = trimmed
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
    afterFormat: cleanAfterFormat(afterFormatRaw),
    raw: trimmed,
    isDreamPlot,
  }
}

/** v2.1.1：after_format 残留清洗——AI 偶发把写作规范/正文复述/BAR 块塞进后置区：
 * 剥标签去 BAR 后，残留疑似「复述特征」或超长时置空（不显示）。 */
const AFTER_LEAK_RE = /辨视角|遵写规|演叙事|在正文前|须输出|必须先|必输出|禁词|信息差|「不是|“不是|收集物资|当前状态|前尘已定|梦境将演/
function cleanAfterFormat(raw: string): string {
  const t = raw
    .replace(/<dream_done\s*\/?>/gi, '')
    .replace(/\[\[BAR\]\][\s\S]*?\[\/BAR\]/gi, '')
    .replace(TAG_RE, '')
    .trim()
  if (!t) return ''
  // 超长：合法后置格式（选项/简短状态）通常很短；长文本大概率是复述/正文镜像
  if (t.length > 280) return ''
  if (AFTER_LEAK_RE.test(t)) return ''
  return t
}

// v2.1.2：body 内「写作规范复述」锚点（出现即视为复述区起点）
const LEAK_ANCHOR_RE = /(正文前需要|在正文前|辨视角|遵写规|演叙事|前尘已定|梦境将演|其中可包含|当前收集物资|当前状态[:：]|字数约|人称第三|信息差[:：]|文风[:：]|转述不抢话|制造挑战|事件推进链|禁词|破折号|，其中可包含)/
/** 开头碎片行：孤立反引号+mumble 单字/短词（AI 输出 markdown 或复述残留） */
const LEAK_HEAD_LINE_RE = /^[`'"“”‘’]\s*[\u4e00-\u9fa5]{0,8}\s*[`'"“”‘’]?\s*[。.]?\s*$/

/** v2.1.2：内容疑似「写作规范/设定指南」文本（AI 会反复复述它；供面板诊断提示） */
export function looksLikeSpecText(content?: string): boolean {
  if (!content) return false
  return LEAK_ANCHOR_RE.test(content)
}

/**
 * 清洗 body 内部复述：
 *  - 开头连续碎片行（≤3 行：含锚点关键词或孤立反引号碎片）→ 剥离
 *  - 正文之后的锚点（「二、辨视角」「当前状态」等）→ 截断
 */
function stripBodyLeak(body: string): string {
  const lines = body.split('\n')
  let start = 0
  while (start < Math.min(3, lines.length)) {
    const t = lines[start].trim()
    if (!t) { start++; continue }
    if (LEAK_ANCHOR_RE.test(t) || LEAK_HEAD_LINE_RE.test(t)) start++
    else break
  }
  let rest = start > 0 ? lines.slice(start).join('\n') : body
  // 中部锚点截断（只处理正文后的长复述；容忍「二、」「（一）」等汉字数字前缀）
  const m = rest.match(/[\s\n]+(?:(?:[\d一二三四五六七八九十]+)[、.．]\s*)?(正文前需要|在正文前|辨视角|遵写规|演叙事|前尘已定|梦境将演|其中可包含|当前收集物资|当前状态[:：])/)
  if (m && m.index !== undefined) rest = rest.slice(0, m.index).trim()
  return rest.trim()
}
