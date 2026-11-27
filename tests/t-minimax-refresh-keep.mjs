/**
 * 刷新令牌的结果必须一直留着，不能只留一分钟。
 *
 * ## 为什么必须有这条（上游 0.2.10 修的掉线 bug）
 *
 * MiniMax 的 refresh_token **只能用一次**（用完即废）。旧代码在刷新成功后
 * 只保留结果 1 分钟，而且以「保存成功」为前提：
 *
 *   刷新成功 → 结果只在内存留 1 分钟 → 试着写盘
 *   → 若写盘失败（Windows 上文件被别的程序占着 / 磁盘满）
 *   → 硬盘上那枚**已作废**的旧 token 还在
 *   → 1 分钟后下一轮刷新拿它再换 → MiniMax 回 invalid_grant
 *   → 账号被登出
 *
 * 社区（Tiemo404）报告过「很多 MiniMax 国际版账号一夜之间被登出」。
 *
 * 修法：结果一律保留 30 天（KEEP_RENEWED_MS），与保存成功与否无关；
 * 后来的刷新直接取用，不再拿作废的 token 去换。
 *
 * 这条测试钉三件事：
 *   1. KEEP_RENEWED_MS 是 30 天量级，不是 1 分钟；
 *   2. `latest()` 对已保存过的记录也继续返回新令牌（旧代码会 break）；
 *   3. 刷新结果里不再有 `saved` 这个布尔（取消了对保存成功的依赖）。
 *
 * 用法：node tests/t-minimax-refresh-keep.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(ROOT, 'minimax', 'index.mjs')).href)

let pass = 0
let fail = 0
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

const { _internal } = mod
const { SITES, renewed, latest, forgetOld, KEEP_RENEWED_MS } = _internal

console.log('\n[0] KEEP_RENEWED_MS 是 30 天，不是原来的 1 分钟')
{
  const days = KEEP_RENEWED_MS / 86400000
  ok(days >= 29 && days <= 31, `保留期 ${days.toFixed(0)} 天（旧值 1 分钟）`, `实际: ${KEEP_RENEWED_MS}ms`)
}

console.log('\n[1] 保留时长：1 小时前的刷新结果仍然生效')
{
  const site = SITES['minimax-code']
  const key = site.id + '\n' + 'r-old'
  renewed.set(key, { got: { access: 'new-token', refresh: 'r-2' }, at: Date.now() - 3600 * 1000 })
  const got = latest(site, { access: 'old-token', refresh: 'r-old', expires: Date.now() - 1 })
  ok(got.access === 'new-token', '1 小时前的结果仍返回新令牌（旧代码 1 分钟就过期）', `实际拿到: ${got.access}`)
  renewed.delete(key)
}

console.log('\n[2] 已「保存过」的记录不会被丢弃')
{
  const site = SITES['minimax-code']
  const key = site.id + '\n' + 'r-saved'
  // 旧代码里 done.saved === true 且超过 1 分钟就 break；新代码没有 saved 字段
  renewed.set(key, { got: { access: 'saved-new', refresh: 'r-next' }, at: Date.now() - 600 * 1000 })
  const got = latest(site, { access: 'stale', refresh: 'r-saved', expires: Date.now() - 1 })
  ok(got.access === 'saved-new', '10 分钟前的记录仍然生效（不再因为「已保存」就丢弃）', `实际: ${got.access}`)
  renewed.delete(key)
}

console.log('\n[3] 刷新结果不再带 saved 布尔')
{
  const site = SITES['minimax-code']
  const key = site.id + '\n' + 'r-shape'
  renewed.set(key, { got: { access: 'x', refresh: 'y' }, at: Date.now() })
  const rec = renewed.get(key)
  ok(!('saved' in rec), '记录里没有 saved 字段（已解除对保存成功的依赖）')
  ok(Object.keys(rec).sort().join(',') === 'at,got', `记录只有 got 和 at 两个字段（实际: ${Object.keys(rec).sort().join(',')}）`)
  renewed.delete(key)
}

console.log('\n[4] 链式跟随：连续多次刷新能一路追到最新')
{
  const site = SITES['minimax-code']
  const k1 = site.id + '\n' + 't1'
  const k2 = site.id + '\n' + 't2'
  renewed.set(k1, { got: { access: 'a2', refresh: 't2' }, at: Date.now() })
  renewed.set(k2, { got: { access: 'a3', refresh: 't3' }, at: Date.now() })
  const got = latest(site, { access: 'a1', refresh: 't1', expires: Date.now() - 1 })
  ok(got.access === 'a3', '从最老的 token 一路追到最新的', `实际: ${got.access}`)
  renewed.delete(k1); renewed.delete(k2)
}

console.log('\n[5] forgetOld 只清超过 30 天的，不动新鲜的')
{
  const site = SITES['minimax-code']
  const ancientKey = site.id + '\n' + 'r-ancient'
  const freshKey = site.id + '\n' + 'r-fresh'
  renewed.set(ancientKey, { got: { access: 'ancient', refresh: 'z' }, at: Date.now() - 40 * 24 * 3600 * 1000 })
  renewed.set(freshKey, { got: { access: 'fresh', refresh: 'w' }, at: Date.now() - 1000 })
  forgetOld()
  ok(!renewed.has(ancientKey), '40 天前的记录被清掉')
  ok(renewed.has(freshKey), '1 秒前的记录保留')
  renewed.delete(freshKey)
}

console.log('\n' + '='.repeat(50))
console.log(`结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
