/**
 * MiniMax 多媒体工具 —— 用本插件**已有账号**（Jet Hub 账号池里的 minimax /
 * minimaxintl）提供图像 / 视频 / 语音 / 音乐 / 多模态理解能力。
 *
 * ## 为什么是这一份而不是装第二个插件
 *
 * 上游 `@magpie-community/opencode-minimax-auth` 自带一套「自己登录、自己存令牌」
 * 的账号体系，与 Jet Hub 的账号池是两套。用户要求「不装第二个插件、用已有账号」，
 * 所以这里只取它的**工具实现**（原样搬运在 `minimax/`，见其 ORIGIN.md），
 * 把「令牌从哪来」换成本插件的容器：
 *
 * ```
 * 上游：magpie 的 plugin-auth.json 里自己存的 OAuth 令牌
 * 这里：container 的凭据解析（DSH 的 ~/.dsh/.credentials.yaml）
 * ```
 *
 * ## 令牌刷新冲突（必须知道）
 *
 * MiniMax 的 refresh_token 是**一次性**的：谁先刷成功，另一份就作废。DSH 本体
 * 与这里的容器各持一份凭据副本，都可能去续期 —— 这是本插件已知限制里
 * 「STS5.1806 the refresh token has been used」的同款成因。
 *
 * 所以本模块**只读不刷**：令牌没过期就直接用；过期了返回可读错误，让用户去
 * DSH 里重新登录那个账号。这样不会与 DSH 抢刷新，也不会把用户登出。
 *
 * @module src/minimax-tools.mjs
 */
import { _internal } from '../minimax/index.mjs'

/** 上游把站点表挂在 `_internal` 上（不是顶层导出）—— 取一次复用。 */
const { SITES } = _internal
import { createConnectorTools, compactToolsOn } from '../minimax/connector-tools.mjs'
import { createWebTools } from '../minimax/web-tools.mjs'

/** 本插件 provider id → MiniMax 站点 id。 */
const SITE_OF_PROVIDER = {
  minimax: 'minimax-code',
  minimaxintl: 'minimax-code-global',
}

/** 站点 id → 本插件 provider id（反向查）。 */
const PROVIDER_OF_SITE = Object.fromEntries(
  Object.entries(SITE_OF_PROVIDER).map(([provider, site]) => [site, provider]),
)

/** 令牌过期前这么多毫秒就当作已过期（给网络与时钟漂移留余量）。 */
const EXPIRY_SKEW_MS = 60_000

/**
 * 从 DSH 凭据值里取 access_token，并判断是否可用。
 *
 * DSH 存的形状（实测）：
 * `{"access_token":"…","refresh_token":"…","token_type":"Bearer","expires_at":"1794445858889",…}`
 * ⚠️ `expires_at` 是**字符串**形式的毫秒时间戳，不是数字 —— 两种都接。
 *
 * @param {unknown} raw 凭据文件里那条 ref 的值（JSON 字符串或已解析对象）
 * @returns {{ ok: true, access: string } | { ok: false, reason: string }}
 */
export function accessFromCredential(raw) {
  let obj
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { ok: false, reason: '账号凭据不是合法 JSON' }
  }
  const access = typeof obj?.access_token === 'string' ? obj.access_token : ''
  if (access === '') return { ok: false, reason: '账号凭据里没有 access_token' }
  const expRaw = obj?.expires_at
  const exp = typeof expRaw === 'number' ? expRaw : Number(expRaw)
  if (Number.isFinite(exp) && exp > 0 && Date.now() + EXPIRY_SKEW_MS >= exp) {
    return {
      ok: false,
      reason: '账号的 access_token 已过期 —— 本插件刻意不刷新它（refresh_token 一次性，'
        + '与 DSH 抢刷新会把账号登出）。请到 DSH 的 Jet Hub 里重新登录该账号。',
    }
  }
  return { ok: true, access }
}

/**
 * 给一个 MiniMax 站点建工具集合（与上游 `MiniMaxCodeToolsPlugin` 同形）。
 *
 * @param {(provider: string) => Promise<{ access: string } | { error: string }>} tokenOf
 *   按本插件 provider id（`minimax` / `minimaxintl`）取 access_token；
 *   取不到时返回 `{ error: '<可读原因>' }`。
 * @param {{ compactTools?: boolean }} [options]
 * @returns {{ tool: Record<string, unknown> }}
 */
export function minimaxTools(tokenOf, options = {}) {
  const compact = { compactTools: compactToolsOn(options) }

  /**
   * 上游的传输函数是**每站点一个**（`makeTokenRequest(site, access, renew)`），
   * 而 magpie 的工具集合是**每插件一份**、工具自己带站点参数。
   * 所以这里按站点懒建并缓存：第一次调用某站点的工具时取令牌、建传输函数。
   */
  const perSite = new Map()
  const request = async (siteId, path, body, opts = {}) => {
    const site = SITES[siteId]
    if (!site) throw new Error(`未知的 MiniMax 站点：${siteId}`)
    const provider = PROVIDER_OF_SITE[siteId]
    let transport = perSite.get(siteId)
    if (transport === undefined) {
      const got = await tokenOf(provider)
      if (got.error !== undefined) throw new Error(got.error)
      // ⚠️ 第三参 `renewAccess` 刻意不传：本模块不刷新令牌（理由见文件头）。
      // 传了就等于允许它在 401 时自己续期，会与 DSH 抢那枚一次性 refresh_token。
      transport = _internal.makeTokenRequest(site, got.access)
      perSite.set(siteId, transport)
    }
    return transport(siteId, path, body, opts)
  }

  return {
    tool: {
      ...createConnectorTools(request, compact).tool,
      ...createWebTools(request),
    },
  }
}

/** 这家 provider 是不是 MiniMax（决定要不要给它挂工具）。 */
export function isMinimaxProvider(dshProvider) {
  return Object.prototype.hasOwnProperty.call(SITE_OF_PROVIDER, dshProvider)
}

/**
 * 把上游 `mediaConfigModels()` 的简写补齐成 **magpie 供应商编辑器要的完整形状**。
 *
 * 上游那份是给 OpenCode 用的：`limit: {context:0, output:0}` 没写 `capabilities`
 * 也没写输入模态。magpie 侧会读 `capabilities.input` 决定「能不能发图/收视频」，
 * `tests/t-plugin.mjs` 也有断言盯着（缺了好几条能力列会是空的）。
 *
 * @param {Record<string, object>} models `mediaConfigModels()` 的产物
 */
export function toMagpieMediaModels(models) {
  const out = {}
  for (const [id, m] of Object.entries(models)) {
    const isImage = Array.isArray(m?.modalities?.output) && m.modalities.output.includes('image')
    // ⚠️ 先解构掉 `cost`（上游给了全 0 的 `emptyCost`）。**不发 cost 字段**
    // （2026-11-24 t-model-prices 抓到的）：magpie 的判据是
    // `Cost == nil || (Input <= 0 && Output <= 0)`，发一个全 0 的对象等于
    // 「确认免费」，会把「不知道」说成 0。图像/视频按次计费、不是按 token，
    // 本来就没有 token 单价 —— 不发，让它落回 magpie 自己的兜底链。
    const { cost: _droppedCost, ...rest } = m ?? {}
    out[id] = {
      ...rest,
      // 媒体模型没有对话上下文（不是在聊天里用的），给 0 而不是缺字段。
      limit: { context: 0, output: 0 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: true,
        toolcall: false,
        // 输入：文字 + 图（做视频时首帧就是图）。
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        // 输出：图像模型出图，视频模型出视频，都不出文字。
        output: { text: false, image: isImage, audio: false, video: !isImage, pdf: false },
        interleaved: false,
      },
    }
  }
  return out
}

/**
 * 建一个**媒体请求**传输函数（给 `handleMediaFetch` 用）。
 *
 * 与 `minimaxTools` 里那个的区别：这里**不绑定站点**，每次调用现取令牌。
 * 上游 `handleMediaFetch` 每次请求都会传 `siteId`，所以令牌要按站点取，
 * 不能像工具那样缓存一个 transport 到底。
 *
 * @param {() => Promise<string>} accessOf 取当前账号 access_token（失败抛错）
 */
export function makeMediaTransport(accessOf) {
  const perCall = new Map()
  return async function request(siteId, path, body, opts = {}) {
    const site = SITES[siteId]
    if (!site) throw new Error(`未知的 MiniMax 站点：${siteId}`)
    let transport = perCall.get(siteId)
    if (transport === undefined) {
      transport = _internal.makeTokenRequest(site, await accessOf())
      perCall.set(siteId, transport)
    }
    return transport(siteId, path, body, opts)
  }
}

export { SITE_OF_PROVIDER, PROVIDER_OF_SITE, SITES }
