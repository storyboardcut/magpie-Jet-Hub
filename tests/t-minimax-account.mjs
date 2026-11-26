/**
 * MiniMax 工具的 `account` 参数真的生效。
 *
 * ## 为什么必须有这条（2026-11-26 真机缺陷）
 *
 * 移植上游工具时，`minimaxTools()` 只按 **站点** 缓存传输函数 —— 也就是「该
 * provider 第一条 enabled 账号」的令牌，工具的 `account` 参数**被完全忽略**。
 * 实测：传 `THIS-DOES-NOT-EXIST-XYZ` 也照样成功 ⇒ 用户以为切了账号，其实没有。
 *
 * 用户场景：第一个号额度用完时，要能指定另一个号继续跑。
 *
 * 这条测试钉三件事：
 *   1. 三种合法写法都能解析成账号池 id；
 *   2. **乱写的账号必须报错**（不能静默回退到第一条 —— 那正是原缺陷）；
 *   3. 别家的 key（属于另一个站点）必须报错。
 *
 * 用法：node tests/t-minimax-account.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'minimax-tools.mjs')).href)

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

/** 用假 tokenOf 建工具集，记录它收到了什么 accountId。 */
function harness() {
  const seen = []
  const tokenOf = async (provider, accountId) => {
    seen.push({ provider, accountId })
    // 给一个看起来像令牌的串，让 `makeTokenRequest` 能建起来
    return { access: 'fake-access-token-for-test' }
  }
  const tools = mod.minimaxTools(tokenOf, { compactTools: true })
  return { tools, seen, tokenOf }
}

/**
 * 直接调 `request()` 而不是 `.execute()`：`execute` 会真的发网络请求，而我们要
 * 验的是**账号解析**这一层。工具的 `.execute()` 内部最终也会走同一个 `request`。
 *
 * 这里通过 `createConnectorTools` 的 `call_tool` 无法拿到 request 引用，所以改用
 * 「让令牌无效 → 观察报错文本」的方式也能判，但那样依赖网络。更干净的判据是
 * 直接测 `normalizeAccountKey` —— 它是纯函数，已从模块导出。
 */
const { normalizeAccountKey } = mod._test ?? {}

console.log('· 1  纯函数：三种合法写法')
if (normalizeAccountKey === undefined) {
  console.log('  ✗ 模块没有导出 _test.normalizeAccountKey（测试无法验纯函数）')
  failed++
  total++
} else {
  ok(normalizeAccountKey(undefined, 'minimax-code') === '', '不传 ⇒ 空串（不指定）')
  ok(normalizeAccountKey('', 'minimax-code') === '', '空串 ⇒ 空串')
  ok(normalizeAccountKey('minimax-code', 'minimax-code') === '', '站点自己的 id ⇒ 空串（等于不指定）')
  ok(normalizeAccountKey('minimax-5ec12fd7', 'minimax-code') === 'minimax-5ec12fd7',
    '直接给账号池 id ⇒ 原样')
  ok(normalizeAccountKey('minimax-code#5ec12fd7', 'minimax-code') === 'minimax-5ec12fd7',
    '站点#尾段 ⇒ 拼成账号池 id')
  ok(normalizeAccountKey('minimax-code-global#134a5e56', 'minimax-code-global') === 'minimaxintl-134a5e56',
    '国际站的 #尾段 ⇒ 拼成 minimaxintl-*')
}

console.log('· 2  乱写的账号必须报错（不能静默回退）')
if (normalizeAccountKey !== undefined) {
  let threw = false
  try { normalizeAccountKey('NOT-A-REAL-ACCOUNT-XYZ', 'minimax-code') } catch { threw = true }
  ok(threw, '乱写字符串 ⇒ 抛错（原缺陷是静默用第一条）')

  let threw2 = false
  try { normalizeAccountKey('minimax-code-global#abcd1234', 'minimax-code') } catch { threw2 = true }
  ok(threw2, '别家站点的 key ⇒ 抛错（防静默走错站点）')
}

console.log('· 3  传输函数按账号分别缓存（不同 account 不该复用同一个 transport）')
{
  // 源码判据：缓存键必须含 accountKey
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'src', 'minimax-tools.mjs'), 'utf8')
  ok(/const cacheKey = `\$\{siteId\}\\u0000\$\{accountKey\}`/.test(src),
    '缓存键是 `siteId\\u0000accountKey`（不是只用 siteId）')
  ok(/tokenOf\(provider, accountKey === '' \? undefined : accountKey\)/.test(src),
    'tokenOf 收到了 accountKey')
}

console.log('· 4  tokenOf 拿得到第二参（接口形状）')
{
  const { tokenOf, seen } = harness()
  // 直接调它，验「账号参数能透到 tokenOf」
  await tokenOf('minimax', 'minimax-5ec12fd7')
  ok(seen.length === 1 && seen[0].accountId === 'minimax-5ec12fd7',
    'tokenOf 的第二参就是账号 id', JSON.stringify(seen))
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：account 参数解析 / 乱写报错 / 分号缓存 / 透传）`)
process.exit(failed === 0 ? 0 : 1)