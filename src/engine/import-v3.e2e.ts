/**
 * v3.5 导入管线纯函数测试：ST 原文清洗 / 人物名提取 / kind 分类。
 *   npx tsx src/engine/import-v3.e2e.ts
 */
import { cleanImportedContent, guessCharacterName, guessKindFromComment, guessHookFromEntry } from '../stores/data'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('【cleanImportedContent ST 清洗】')
check('宏标记剥离', cleanImportedContent('{{char}}你好{{getvar::x}}') === '你好', JSON.stringify(cleanImportedContent('{{char}}你好{{getvar::x}}')))
check('宏多行剥离', !cleanImportedContent('开头\n{{description: 一段很长的宏标记}}\n结尾').includes('{{'), JSON.stringify(cleanImportedContent('开头\n{{description: 一段很长的宏标记}}\n结尾')))
check('HTML 标签剥离（含闭合）', cleanImportedContent('<b>粗体</b> 与 <i>斜体</i>') === '粗体 与 斜体', JSON.stringify(cleanImportedContent('<b>粗体</b> 与 <i>斜体</i>')))
// 真实斗罗 ST 锚点标签（样本诊断确认）：
check('斗罗锚点标签剥离', cleanImportedContent('<faction_武魂殿>\n势力档案_武魂殿') === '势力档案_武魂殿', JSON.stringify(cleanImportedContent('<faction_武魂殿>\n势力档案_武魂殿')))
check('规则/世界观标签剥离', !cleanImportedContent('<rule_经济系统>价格体系\n<worldview_detail_天斗帝国>天斗帝国坐落北方').includes('<'), JSON.stringify(cleanImportedContent('<rule_经济系统>价格体系\n<worldview_detail_天斗帝国>天斗帝国坐落北方')))
check('{{user}} 宏剥离', !cleanImportedContent('{{user}}登场。').includes('{{'), JSON.stringify(cleanImportedContent('{{user}}登场。')))
check('注释剥离', !cleanImportedContent('正文<!-- 注释 -->继续').includes('<!--'))
check('--- 分隔线删除', cleanImportedContent('---\n【等级划分】\n---\n内容').trim() === '【等级划分】\n\n内容', JSON.stringify(cleanImportedContent('---\n【等级划分】\n---\n内容')))
check('CRLF 归一', cleanImportedContent('甲\r\n乙') === '甲\n乙')
check('连续空行压缩', !cleanImportedContent('甲\n\n\n\n\n乙').includes('\n\n\n'), JSON.stringify(cleanImportedContent('甲\n\n\n\n\n乙')))
check('中文正文完整保留', cleanImportedContent('前置条件: 本剧本为《斗罗大陆》同名网络小说同人世界观').includes('《斗罗大陆》'))
check('空串安全', cleanImportedContent('') === '' && cleanImportedContent(undefined as any) === '')

console.log('【guessCharacterName 人物名提取】')
check('hook 优先', guessCharacterName({ comment: '👤斗一：唐三' }, '', '唐三') === '唐三')
check('comment 冒号提取', guessCharacterName({ comment: '👤斗三：唐舞桐' }, '', undefined) === '唐舞桐')
check('key 兜底', guessCharacterName({ comment: '' }, '张三,阿三', undefined) === '张三')
check('comment 去 emoji 提取', guessCharacterName({ comment: '👤唐三' }, '', undefined) === '唐三', guessCharacterName({ comment: '👤唐三' }, '', undefined))
check('空输入安全', guessCharacterName({ comment: '' }, '', undefined) === undefined)

console.log('【guessKindFromComment / hook】')
check('人物分类', guessKindFromComment('👤斗三：唐舞桐') === 'character')
check('地点分类', guessKindFromComment('🗺️斗一：世界格局') === 'location')
check('规则分类', guessKindFromComment('🧬通用：核心设定') === 'note' || guessKindFromComment('🧬通用：核心设定') === 'rule')
check('hook 提取', guessHookFromEntry({ comment: '👤斗三：唐舞桐' }, 'character') === '唐舞桐')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
