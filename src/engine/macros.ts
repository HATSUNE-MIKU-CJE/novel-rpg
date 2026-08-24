/**
 * 宏引擎：SillyTavern 兼容的最小实现。
 *
 * 支持的宏（梦鲸思客预设实际用到的）：
 *  - {{setvar::name::value}}         会话变量（存档级）
 *  - {{addvar::name::value}}         追加会话变量（value 拼接到现有值后）
 *  - {{getvar::name}}                读会话变量
 *  - {{setglobalvar::name::value}}   全局变量（应用级）
 *  - {{getglobalvar::name}}          读全局变量
 *  - {{lastUserMessage}}             用户最后一条消息
 *  - {{char}} / {{user}} / {{group}} 内置占位符
 *  - {{压缩相邻消息::lora_constant}}  常驻世界书条目注入点
 *  - {{压缩相邻消息::lora_key}}      本轮命中触发条目注入点
 *  - {{// ...}}                      注释（预处理时删除）
 *
 * 宏可嵌套（如 {{setvar::x::[{{getvar::y}}]}}）。
 * 扫描核心用「深度计数」找到配对闭合的 '}}'，确保内层宏不被误切。
 */

export interface MacroCtx {
  /** 存档级变量（sleep_var_* 等），写入后立即持久化 */
  getVar: (name: string) => string | undefined
  setVar: (name: string, value: string) => void
  addVar: (name: string, value: string) => void
  /** 应用级全局变量 */
  getGlobalVar: (name: string) => string | undefined
  setGlobalVar: (name: string, value: string) => void
  /** 内置占位符 */
  lastUserMessage: string
  charName: string
  userName: string
  groupName?: string
  /** 世界书注入点 */
  worldbookConstant: string
  worldbookKeyed: string
}

export interface MacroResult {
  text: string
}

/** 从 index 起找 {{ 配对的 }}，返回 [完整文本, 内层文本, 结束位置]；找不到返回 null */
function findMacro(text: string, start: number): [string, string, number] | null {
  if (text[start] !== '{' || text[start + 1] !== '{') return null
  let depth = 0
  let i = start
  while (i < text.length - 1) {
    const two = text.slice(i, i + 2)
    if (two === '{{') { depth++; i += 2; continue }
    if (two === '}}') {
      depth--
      i += 2
      if (depth === 0) {
        return [text.slice(start, i), text.slice(start + 2, i - 2), i]
      }
      continue
    }
    i++
  }
  return null
}

function stripComments(text: string): string {
  // {{// 说明 }} 注释块
  return text.replace(/\{\{\s*\/\/[\s\S]*?\}\}/g, '')
}

function parseNameValue(inner: string): [string, string] | null {
  const m = inner.match(/^\s*([^:]+?)\s*::\s*([\s\S]*)$/)
  if (!m) return null
  return [m[1].trim(), m[2]]
}

/**
 * 展开文本中的宏。rounds: 递归展开轮数上限（防循环引用）。
 * 每轮：setvar/addvar 先赋值（值内宏先展开），再处理其他宏。
 */
export function expandMacros(input: string, ctx: MacroCtx, rounds = 8): MacroResult {
  let text = stripComments(input)

  for (let r = 0; r < rounds; r++) {
    let changed = false
    let out = ''

    let i = 0
    while (i < text.length) {
      if (text[i] === '{' && text[i + 1] === '{') {
        const found = findMacro(text, i)
        if (!found) { out += text[i]; i++; continue }
        const [, inner, end] = found
        const head = inner.match(/^\s*([A-Za-z\u4e00-\u9fff_]+)/)?.[1] ?? ''

        // --- 赋值类宏：先展开值内的嵌套宏，再执行副作用，输出空 ---
        const body = inner.replace(/^\s*[A-Za-z\u4e00-\u9fff_]+\s*::\s*/, '') // 剥掉宏名段
        if (head === 'setvar' || head === 'addvar') {
          const pv = parseNameValue(body)
          if (pv) {
            const value = expandMacros(pv[1], ctx, rounds - 1).text
            if (head === 'setvar') ctx.setVar(pv[0], value)
            else ctx.addVar(pv[0], value)
            changed = true
            i = end
            continue
          }
        }
        if (head === 'setglobalvar') {
          const pv = parseNameValue(body)
          if (pv) {
            const value = expandMacros(pv[1], ctx, rounds - 1).text
            ctx.setGlobalVar(pv[0], value)
            changed = true
            i = end
            continue
          }
        }

        // --- 读取类宏 ---
        if (head === 'getvar' || head === 'getglobalvar') {
          const cleanName = body.trim()
          const v = head === 'getvar' ? ctx.getVar(cleanName) : ctx.getGlobalVar(cleanName)
          if (v !== undefined) { out += v; changed = true; i = end; continue }
          // 未定义：原样保留
          out += text.slice(i, end)
          i = end
          continue
        }

        // --- 世界书注入点 ---
        if (head === '压缩相邻消息') {
          const which = inner.replace(/^\S+\s*::\s*/, '').trim()
          if (which === 'lora_constant') { out += ctx.worldbookConstant; changed = true; i = end; continue }
          if (which === 'lora_key') { out += ctx.worldbookKeyed; changed = true; i = end; continue }
          if (which.startsWith('lora_') || which.endsWith('_dx')) { changed = true; i = end; continue }
          out += text.slice(i, end); i = end; continue
        }

        // --- 内置占位符 ---
        const builtinMap: Record<string, string> = {
          lastUserMessage: ctx.lastUserMessage,
          char: ctx.charName,
          user: ctx.userName,
          group: ctx.groupName ?? '',
        }
        const innerHead = inner.trim()
        if (builtinMap[innerHead] !== undefined) {
          out += builtinMap[innerHead]
          changed = true
          i = end
          continue
        }

        // 未知宏：原样保留
        out += text.slice(i, end)
        i = end
        continue
      }
      out += text[i]
      i++
    }

    text = out
    if (!changed) break
  }

  return { text }
}
