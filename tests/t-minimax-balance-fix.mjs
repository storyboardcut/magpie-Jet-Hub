/**
 * MiniMax 积分分页截断的插件侧修正。
 *
 * ## 为什么必须有这条
 *
 * 上游 `minimax-credits.js` 带 `?page_size=1000`，而服务端上限是 **100**
 * （实测 120 就 400）。400 之后代码回退成裸请求，裸请求**只回最近 20 个积分包**，
 * 于是每天签到新增的包会把最老的挤出窗口 ⇒ 界面「积分明明签到成功却不涨」。
 *
 * 2026-11-25 真机实测（MiniMax650329，total_count=29）：
 *   裸请求 20 条 = 11600 ／ page_size=100 → 29 条 = 15488.10（差 3888.10）
 *
 * 这条测试钉两件事：
 *   1. `SAFE_PAGE_SIZE` 不超过服务端实测上限（100）；
 *   2. 补丁把 `page_size=100` 写进请求 URL（不是 1000、不是裸请求）；
 *   3. 补丁**幂等**（重复 patch 不会套两层）。
 *
 * 用法：node tests/t-minimax-balance-fix.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(ROOT, 'src', 'minimax-balance-fix.mjs')
const src = fs.readFileSync(SRC, 'utf8')

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

console.log('· 1  SAFE_PAGE_SIZE 不超过服务端实测上限')
{
  const m = src.match(/const SAFE_PAGE_SIZE = (\d+)/)
  ok(m !== null, '源码里有 SAFE_PAGE_SIZE 常量')
  const value = m === null ? NaN : Number(m[1])
  ok(Number.isFinite(value), 'SAFE_PAGE_SIZE 是数字', String(value))
  // 实测：100 通、120 通不了。留出「不能超过 100」这条硬线。
  ok(value > 0 && value <= 100, 'SAFE_PAGE_SIZE ≤ 100（120 起服务端 400）', String(value))
  // 20 是裸请求的默认条数 —— 取 20 等于没修
  ok(value > 20, 'SAFE_PAGE_SIZE > 20（否则与裸请求等价，等于没修）', String(value))
}

console.log('· 2  请求 URL 真的带上了正确分页')
{
  ok(/page_size=\$\{SAFE_PAGE_SIZE\}/.test(src), 'URL 用 SAFE_PAGE_SIZE 拼接', '(没找到 page_size=${SAFE_PAGE_SIZE})')
  // 只查**代码行**里的残留（注释里提到旧值是为了说明缺陷，不算残留）
  const codeOnly = src
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
  ok(!/page_size=1000/.test(codeOnly), '代码里没有残留 page_size=1000', '(注释里提到不算)')
}

console.log('· 3  只对 MiniMax 两家生效')
{
  const m = src.match(/const MINIMAX_PROVIDERS = new Set\(\[([^\]]*)\]\)/)
  ok(m !== null, '有 MINIMAX_PROVIDERS 集合')
  const ids = (m?.[1] ?? '').match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) ?? []
  ok(ids.includes('minimax'), '集合含 minimax（国内站）', ids.join(', '))
  ok(ids.includes('minimaxintl'), '集合含 minimaxintl（国际站）', ids.join(', '))
  ok(ids.length === 2, '集合只有这两家（别家不该被这段逻辑碰到）', ids.join(', '))
}

console.log('· 4  补丁幂等（不套两层 rpc）')
{
  const { patchMiniMaxBalance } = await import(pathToFileURL(SRC).href)
  const fake = {
    __calls: 0,
    async rpc() { this.__calls += 1; return { accounts: [] } },
  }
  const first = fake.rpc
  patchMiniMaxBalance(fake)
  const afterFirst = fake.rpc
  patchMiniMaxBalance(fake)
  const afterSecond = fake.rpc
  ok(afterFirst !== first, '第一次 patch 换掉了 rpc')
  ok(afterSecond === afterFirst, '第二次 patch 不换（幂等）')
  ok(fake.__minimaxBalancePatched === true, '打了标记')
  // 空 accounts ⇒ 不重查、原样返回
  const got = await fake.rpc('credits.balances', { provider: 'minimax' })
  ok(Array.isArray(got?.accounts) && got.accounts.length === 0, '空账号时原样返回')
}

console.log('· 5  非 MiniMax / 非余额方法完全透传')
{
  const { patchMiniMaxBalance } = await import(pathToFileURL(SRC).href)
  const calls = []
  const fake = {
    async rpc(method, payload) {
      calls.push({ method, payload })
      return { ok: true }
    },
  }
  patchMiniMaxBalance(fake)
  const a = await fake.rpc('account.list', { provider: 'minimax' })
  ok(JSON.stringify(a) === '{"ok":true}', 'account.list 原样返回')
  const b = await fake.rpc('credits.balances', { provider: 'codearts' })
  ok(JSON.stringify(b) === '{"ok":true}', '别家 provider 的余额原样返回')
  ok(calls.length === 2, '两次都真的调了原 rpc', String(calls.length))
}

console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（${total} 项：积分分页修正的常量上限 / URL 形态 / 生效范围 / 幂等 / 透传）`)
process.exit(failed === 0 ? 0 : 1)