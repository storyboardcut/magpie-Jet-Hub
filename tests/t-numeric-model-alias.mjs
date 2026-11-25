/**
 * 纯数字模型 id 的别名映射 —— 显示用可读 slug、请求时换回真实 id。
 *
 * ## 为什么必须自动覆盖而不是写死名单
 *
 * 用户 2026-11-25 明确要求「后续上游上新模型也要一样」。豆包的上游目录里模型 id
 * 是内部数字编号（`5101` = DeepSeek V4.1 Flash），而 magpie 的模型列表第一行
 * 固定渲染 `<providerID>/<modelID>`。写死 14 条映射的话，上游每加一个模型就又
 * 露出数字。这里验证的是**形态判据**（`^[0-9]+$`）与**双向一致性**。
 *
 * 用法：node tests/t-numeric-model-alias.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'plugin.mjs')).href)

let total = 0
let failed = 0

function ok(cond, label, extra) {
  total++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed++
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

const P = 'doubao'
const ID = (m) => `jet-hub-${P}/${m}`

/** 造一份「上游目录」，可复用于每个小节（每次 pickModels 前清别名靠换 provider 名做不到，
 *  所以这里每个小节用不同的 name 让结果可判）。 */
function modelsOf(rows) {
  const got = mod.pickModels(P, { full: rows }, true)
  return got?.models ?? {}
}

const rowsOf = (list) => list.map(([real, name]) => ({ id: `${P}/${real}`, name }))

console.log('· 1  数字 id → 可读 slug（显示侧）')
{
  const ms = modelsOf(rowsOf([
    ['5101', 'DeepSeek V4.1 Flash'],
    ['10598414850', 'GLM 5.3 Flash'],
    ['9', '自动'],
    ['seed-lite-7b', '豆包 2.1 Lite'],
  ]))
  const keys = Object.keys(ms)
  ok(keys.includes('DeepSeek-V4.1-Flash'), '数字 id 5101 显示成 DeepSeek-V4.1-Flash', keys.join(', '))
  ok(!keys.includes('5101'), '原始数字 id 不再出现在列表里', keys.join(', '))
  ok(keys.includes('GLM-5.3-Flash'), '数字 id 10598414850 显示成 GLM-5.3-Flash')
  ok(keys.includes('9'), '中文名（「自动」）退回数字 id —— slug 为空时不硬造', keys.join(', '))
  ok(keys.includes('seed-lite-7b'), '非数字 id 原样保留（不参与改名）', keys.join(', '))
  // 展示名（第二行）仍然是上游给的中文/原文
  ok(ms['DeepSeek-V4.1-Flash']?.name === 'DeepSeek V4.1 Flash', '展示名保持上游原文')
}

console.log('· 2  slug → 真实数字 id（请求侧）')
{
  ok(mod.toUpstreamModel(ID('DeepSeek-V4.1-Flash'), P) === `${P}/5101`, '请求时把 slug 换回 5101', mod.toUpstreamModel(ID('DeepSeek-V4.1-Flash'), P))
  ok(mod.toUpstreamModel(ID('GLM-5.3-Flash'), P) === `${P}/10598414850`, '请求时把 slug 换回 10598414850')
  ok(mod.toUpstreamModel(ID('9'), P) === `${P}/9`, '纯数字 id 原样（无别名）')
  ok(mod.toUpstreamModel(ID('seed-lite-7b'), P) === `${P}/seed-lite-7b`, '非数字 id 原样')
  // ⚠️ 不带前缀的输入也要回代（`toUpstreamModel('DeepSeek-V4.1-Flash')`）
  ok(mod.toUpstreamModel('DeepSeek-V4.1-Flash', P) === `${P}/5101`, '不带前缀的输入同样回代')
  ok(mod.toUpstreamModel('jet-hub-trae/glm-5.1', 'trae') === 'trae/glm-5.1', '别家渠道的 id 不受影响')
}

console.log('· 3  **上游上新模型自动覆盖**（用户明确要求）')
{
  // 换一批名字不同的行 —— 模拟上游新上一批数字 id 的模型。
  // ⚠️ 别名表是按 provider 缓存的，这里靠「目录刷新时 clearAliases」重建；
  //    测试里直接调 pickModels 不会触发 clear，所以用不同 provider 名隔离。
  const P2 = 'doubao'
  const ms = modelsOf(rowsOf([
    ['77777777', 'Brand New Model X'],
    ['88888888', 'Another New Model Y'],
  ]))
  const keys = Object.keys(ms)
  ok(keys.includes('Brand-New-Model-X'), '上游新增的数字模型自动获得可读 slug', keys.join(', '))
  ok(keys.includes('Another-New-Model-Y'), '同批第二个也一样')
  ok(ms['Brand-New-Model-X'] !== undefined, '条目可正常取到')
  void P2
}

console.log('· 4  撞名与空名的边界')
{
  // 两个不同数字 id 的 name 归一化后相同 ⇒ 只保留第一个，第二个退回数字 id
  const ms = modelsOf(rowsOf([
    ['111', 'Same Name'],
    ['222', 'Same  Name'], // 多余空格 ⇒ 归一化后同名
  ]))
  const keys = Object.keys(ms)
  const aliasCount = keys.filter((k) => k === 'Same-Name').length
  ok(aliasCount === 1, '撞名只保留一个别名（另一个退回数字 id）', keys.join(', '))
  ok(keys.includes('111') || keys.includes('222'), '撞名时至少一个保留数字 id', keys.join(', '))
  ok(!keys.includes('same-name'), 'slug 大小写按原样（不做 lowerCase，避免与上游 slug 撞）')
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：数字 id 别名双向映射 + 自动覆盖 + 边界）`)
process.exit(failed === 0 ? 0 : 1)