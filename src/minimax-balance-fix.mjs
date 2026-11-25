/**
 * 修正 MiniMax 的**积分分页截断**（2026-11-25 实机查明）。
 *
 * ## 缺陷
 *
 * 上游 `vendor/lib/minimax-credits.js` 带的是 `?page_size=1000（上游旧值）`（issue #141 的
 * 修法，2026-11-23）。但**上游实际上限是 100** —— 传 1000 直接
 * `HTTP 400 UNEXPECTED_ERROR`，代码随后**回退到裸请求**，而裸请求**默认只回
 * 最近 20 个积分包**。
 *
 * 于是：签到成功、界面「积分没变化」，而真实余额少算一截 —— 用户每天签到新增
 * 一个包，最老的一个被挤出 20 条窗口，被挤出的额度从总额里消失。
 *
 * ## 实测（2026-11-25，真实账号 MiniMax650329，`total_count = 29`）
 *
 * | 请求 | HTTP | `details` 条数 | Σ `remaining_amount` |
 * |---|---|---|---|
 * | 裸请求（无参数） | 200 | **20** | **11600.00** |
 * | `?page_size=50` | 200 | 29 | 15488.10 |
 * | `?page_size=100` | 200 | 29 | **15488.10** |
 * | `?page_size=120` / `150` / `1000` | **400** | 0 | — |
 *
 * 差额 **3888.10** 就是被挤出的 9 个包的剩余额度。
 *
 * ## 为什么在插件侧补而不是改 vendor
 *
 * 用户明确要求「一步到位，后续不要有这个情况」：
 *
 * - 改 `vendor/` 会变成第 14 个补丁，上游每次跟进都要重打、校验脚本要改；
 * - 这里**不改上游任何字节**，只在结果出来后**把被截断的部分补回来**。
 *
 * ## 做法
 *
 * `patchMiniMaxBalance(container)` 包住容器的 `rpc()`：`credits.balances` 且
 * provider 属于 MiniMax 两家时，用**正确分页**直接打上游 `credit/details`，
 * 用完整明细**覆盖**那次调用返回的 `balance`。失败静默保留上游结果（不比修复前差）。
 *
 * @module src/minimax-balance-fix.mjs
 */

/** 上游 `page_size` 的**实测上限**（120 就 400；100 稳定通）。 */
const SAFE_PAGE_SIZE = 100

/** 受影响的 provider（两站 host 不同，靠 product 常量区分）。 */
const MINIMAX_PROVIDERS = new Set(['minimax', 'minimaxintl'])

/**
 * 给容器打补丁：MiniMax 两家的 `credits.balances` 结果用完整明细覆盖。
 *
 * 幂等（重复调用不会套两层）。
 *
 * @param {object} container `JetHubContainer` 实例
 * @returns {void}
 */
export function patchMiniMaxBalance(container) {
  if (container === null || typeof container !== 'object') return
  if (container.__minimaxBalancePatched === true) return
  const original = container.rpc
  if (typeof original !== 'function') return

  container.rpc = async function patchedRpc(method, payload, ...rest) {
    const result = await original.call(this, method, payload, ...rest)
    try {
      if (method !== 'credits.balances') return result
      const provider = String(payload?.provider ?? '')
      if (!MINIMAX_PROVIDERS.has(provider)) return result
      const fixed = await fixBalances(this, provider, result)
      return fixed ?? result
    } catch {
      // 补不回来就用上游的结果（至少是修复前的行为）
      return result
    }
  }
  container.__minimaxBalancePatched = true
}

/**
 * 用完整分页重查每个账号的余额，覆盖 `result.accounts[].balance`。
 *
 * @param {object} container
 * @param {string} provider
 * @param {object} result 上游 `credits.balances` 的原始回包
 * @returns {Promise<object | undefined>} 改好的回包；一个都没查到就 `undefined`
 */
async function fixBalances(container, provider, result) {
  const accounts = Array.isArray(result?.accounts) ? result.accounts : []
  if (accounts.length === 0) return undefined

  const host = await baseUrlOf(provider)
  if (host === undefined) return undefined

  let changed = false
  for (const row of accounts) {
    const id = String(row?.accountId ?? '')
    if (id === '') continue
    const accessToken = accessTokenOf(container, provider, id)
    if (accessToken === undefined) continue
    const full = await fetchFullDetails(host, accessToken)
    if (full === undefined) continue
    row.balance = full
    changed = true
  }
  return changed ? result : undefined
}

/**
 * 该 provider 的 `credit/details` 完整地址。
 *
 * @returns {Promise<string | undefined>}
 */
async function baseUrlOf(provider) {
  try {
    const paths = await import('../vendor/lib/minimax-product.js')
    const product = provider === 'minimaxintl'
      ? await import('../vendor/lib/minimaxintl-product.js')
      : await import('../vendor/lib/minimax-product.js')
    const target = provider === 'minimaxintl' ? product.MINIMAX_INTL : product.MINIMAX
    if (target?.apiHost === undefined) return undefined
    return target.apiHost + paths.MINIMAX_CREDIT_DETAILS_PATH
  } catch {
    return undefined
  }
}

/**
 * 从容器里取某账号的 `access_token`。
 *
 * 走容器**已有的** `credentialTextOf(provider)`（它已经处理了「容器没起来时
 * 直接读账号池文件」那条兜底），再按 `accountId` 挑出对应那一条。
 *
 * @returns {string | undefined}
 */
function accessTokenOf(container, provider, accountId) {
  try {
    const accounts = container?.seam?.pool?.readAccounts?.() ?? container?._readAccountsFromState?.() ?? []
    const row = accounts.find((a) => a?.id === accountId && a?.provider === provider)
    if (row === undefined) return undefined
    // `credentialTextOf` 取的是「该 provider 第一条 enabled 账号」；这里的
    // accountId 可能不是第一条（一个 provider 多号），所以直接按 ref 找。
    const text = readRefText(container, row.credentialRef)
    if (text === undefined) return undefined
    const parsed = JSON.parse(text)
    return typeof parsed?.access_token === 'string' ? parsed.access_token : undefined
  } catch {
    return undefined
  }
}

/** 按 ref 读凭据原文（复用容器的 credentialFile() + parseRefs）。 */
function readRefText(container, ref) {
  try {
    // 动态 import 会在首次调用时加载，之后走缓存
    const key = '__credRefsCache'
    if (container[key] === undefined) {
      container[key] = { file: undefined, refs: undefined }
    }
    if (typeof container.credentialFile !== 'function') return undefined
    const file = container.credentialFile()
    const cache = container[key]
    if (cache.file !== file || cache.refs === undefined) {
      // 用容器自己的解析器：`parseRefs` 在同一模块里，走一次就够
      // （这里用 require 是同步取，避免把 fixBalances 变成两次 await）
      const fs = require('node:fs')
      const text = fs.readFileSync(file, 'utf8')
      const refs = new Map()
      // 与 `credentials.mjs` 的 parseRefs 同口径的极简版：单行 `  REF: 'JSON'`
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^ {2}([A-Za-z0-9_]+):\s*'(.*)'\s*$/)
        if (m !== null) refs.set(m[1], m[2].replace(/''/g, "'"))
      }
      cache.file = file
      cache.refs = refs
    }
    const raw = cache.refs.get(ref)
    return raw === undefined || raw === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/**
 * 用 `page_size=100` 拉完整明细，拼成与上游同形状的 `balance`。
 *
 * @returns {Promise<object | undefined>}
 */
async function fetchFullDetails(baseUrl, accessToken) {
  try {
    const res = await fetch(`${baseUrl}?page_size=${SAFE_PAGE_SIZE}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return undefined
    const json = JSON.parse(await res.text())
    const details = Array.isArray(json?.details) ? json.details : undefined
    if (details === undefined) return undefined
    const packages = details.map((d) => ({
      name: typeof d?.credit_package_name === 'string' ? d.credit_package_name : '积分包',
      unit: 'credit',
      total: Number(d?.total_amount) || 0,
      remaining: Number(d?.remaining_amount) || 0,
      used: (Number(d?.total_amount) || 0) - (Number(d?.remaining_amount) || 0),
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: typeof d?.expired_time === 'number' ? new Date(d.expired_time * 1000).toISOString() : '',
    }))
    const total = packages.reduce((n, p) => n + p.remaining, 0)
    return { total, packages, expiredTotal: 0 }
  } catch {
    return undefined
  }
}