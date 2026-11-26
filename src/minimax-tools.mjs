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
 * 把工具收到的 `account` 参数归一成「账号池 id」或空串（=不指定）。
 *
 * 接受的写法（与上游 `createToolRequest` 的 `belongs()` 同口径，另外放宽到
 * 直接给账号池 id）：
 *
 * | 输入 | 结果 | 说明 |
 * |---|---|---|
 * | `undefined` / `''` / 站点自己的 id | `''` | 不指定，取第一条 |
 * | `minimax-code#5ec12fd7` | `minimax-5ec12fd7` | 站点前缀 + `#` + id 尾段 |
 * | `minimax-5ec12fd7` | `minimax-5ec12fd7` | 直接给账号池 id（更明确） |
 * | 别的站点的 key | 抛错 | 防止静默走错站点 |
 *
 * @param {unknown} account 工具参数里的 `account`
 * @param {string} siteId 本次调用选的站点（`minimax-code` / `minimax-code-global`）
 * @returns {string} 账号池 id；空串表示「不指定」
 */
function normalizeAccountKey(account, siteId) {
  if (typeof account !== 'string') return ''
  const raw = account.trim()
  if (raw === '' || raw === siteId) return ''
  // `siteId#尾段`：本体账号池的 id 形如 `minimax-5ec12fd7`，而站点 id 是
  // `minimax-code`。所以 `minimax-code#5ec12fd7` ⇒ `minimax-5ec12fd7`。
  const hash = raw.indexOf('#')
  if (hash > 0) {
    const head = raw.slice(0, hash)
    const tail = raw.slice(hash + 1)
    if (head !== siteId) {
      throw new Error(`account 必须属于所选 MiniMax 站点（${siteId}），收到 ${raw}`)
    }
    if (tail === '') return ''
    // 站点 id 去掉 `-code` 才是本体 provider 前缀（`minimax-code` → `minimax`）
    const providerPrefix = siteId === 'minimax-code-global' ? 'minimaxintl' : 'minimax'
    return `${providerPrefix}-${tail}`
  }
  // 已经是账号池 id 的形态（`minimax-xxxx` / `minimaxintl-xxxx`）
  if (/^minimax(intl)?-[0-9a-z]+$/i.test(raw)) return raw
  // ⚠️ 其它写法**必须报错**，不能静默回退到「不指定」（2026-11-26 实测：
  //    早先返回空串 ⇒ 乱写的账号也照样用第一条账号成功，用户以为切过去了）。
  throw new Error(
    `account 无法识别：${raw}。两种合法写法 —— `
    + `'${siteId}#<账号 id 尾段>'` + '（如 `minimax-code#5ec12fd7`）'
    + ` 或直接给账号池 id（如 \`minimax-5ec12fd7\`）。`,
  )
}

/**
 * 给一个 MiniMax 站点建工具集合（与上游 `MiniMaxCodeToolsPlugin` 同形）。
 *
 * @param {(provider: string, accountId?: string) => Promise<{ access: string } | { error: string }>} tokenOf
 *   按本插件 provider id（`minimax` / `minimaxintl`）取 access_token；
 *   第二参 `accountId` 是**可选的账号池 id**（`minimax-5ec12fd7` 这种），
 *   传了就取那个号的令牌、不传就取该 provider 第一条 enabled 账号。
 *   取不到时返回 `{ error: '<可读原因>' }`。
 * @param {{ compactTools?: boolean }} [options]
 * @returns {{ tool: Record<string, unknown> }}
 */
export function minimaxTools(tokenOf, options = {}) {
  const compact = { compactTools: compactToolsOn(options) }

  /**
   * 上游的传输函数是**每站点一个**（`makeTokenRequest(site, access, renew)`），
   * 而 magpie 的工具集合是**每插件一份**、工具自己带站点参数。
   *
   * ## 账号选择（2026-11-26 修）
   *
   * 早先这里只按 `siteId` 缓存传输函数 —— 也就是「该站点第一条账号的令牌」，
   * 而工具的 `account` 参数**被完全忽略**（实测传 `THIS-DOES-NOT-EXIST-XYZ`
   * 也照样成功）。用户要的是「第一个号额度用完时能指定另一个号继续跑」，
   * 所以缓存键改成 `${siteId}\u0000${accountKey}`，按账号分别建。
   *
   * `account` 的两种写法（与上游 `createToolRequest` 同口径）：
   * - `minimax-code`              ⇒ 不指定账号（取第一条）
   * - `minimax-code#<id尾段>`      ⇒ 指定该站点下 id 以 `<id尾段>` 结尾的账号
   *   也接受直接给账号池 id（`minimax-5ec12fd7`）—— 更明确、不用猜尾段。
   */
  const perSite = new Map()
  const request = async (siteId, path, body, opts = {}) => {
    const site = SITES[siteId]
    if (!site) throw new Error(`未知的 MiniMax 站点：${siteId}`)
    const provider = PROVIDER_OF_SITE[siteId]
    // `account` 可能来自工具的 `account` 参数（`opts.account`）
    const accountKey = normalizeAccountKey(opts?.account, siteId)
    const cacheKey = `${siteId}\u0000${accountKey}`
    let transport = perSite.get(cacheKey)
    if (transport === undefined) {
      const got = await tokenOf(provider, accountKey === '' ? undefined : accountKey)
      if (got.error !== undefined) throw new Error(got.error)
      // ⚠️ 第三参 `renewAccess` 刻意不传：本模块不刷新令牌（理由见文件头）。
      // 传了就等于允许它在 401 时自己续期，会与 DSH 抢那枚一次性 refresh_token。
      transport = _internal.makeTokenRequest(site, got.access)
      perSite.set(cacheKey, transport)
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
export function toMagpieMediaModels(models, site) {
  const out = {}
  for (const [id, m] of Object.entries(models)) {
    const isImage = Array.isArray(m?.modalities?.output) && m.modalities.output.includes('image')
    // ⚠️ 解构掉 `cost`（上游给了全 0 的 `emptyCost`）。**不发 cost 字段**：
    // magpie 的判据是 `Cost == nil || (Input <= 0 && Output <= 0)`，发一个全 0
    // 的对象等于「确认免费」，会把「不知道」说成 0。图像/视频按次计费、不是
    // 按 token，本来就没有 token 单价 —— 不发，让它落回 magpie 自己的兜底链。
    // （2026-11-24 t-model-prices 抓到的「编数字」）
    const { cost: _droppedCost, ...rest } = m ?? {}
    out[id] = {
      ...rest,
      // ⚠️ **`api` 必须给**：magpie 的「测试模型」按 `api.npm` 选协议。不给就
      // 落到默认 chat 协议，把视频模型当聊天模型发 ⇒
      // `HTTP 400 invalid params, unknown model 'MiniMax-Hailuo-2.3'`。
      // 与上游 mediaModelOf 同款：图像 openai-compatible（当抽屉走 images API），
      // 视频 anthropic（只认 output.video，走 videos API）。
      api: {
        id,
        url: `${site?.llm ?? ''}/mavis/api/v1/llm/v1`,
        npm: isImage ? '@ai-sdk/openai-compatible' : '@ai-sdk/anthropic',
      },
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

/**
 * 测试用出口（`index.mjs` 的导出契约只允许插件工厂，所以这里挂在 `_test` 上）。
 * 生产代码不读它。
 */
export const _test = { normalizeAccountKey, slugOfNameForTest: undefined }
