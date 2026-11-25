// 直连层：把 OpenAI 协议的请求在**进程内**交给本体的 `ctx.llm`。
//
// ## 为什么不走内嵌 HTTP 网关
//
// 本体（deepseek-harness-codearts）自己也开一个 OpenAI 兼容网关
// （`vendor/lib/openai-gateway/`），但那层网关的全部工作只是：
//
//   HTTP 请求 → 解析 body → `ctx.llm.stream(generate)` → 转回 SSE / JSON
//
// 插件在本进程里已经握着同一个 `ctx.llm`
// （`container._start()` 里 `ctx.plugin(本体)` 之后就有）。再走一遍
// `fetch(http://127.0.0.1:1839x/v1/...)` 只是把同一份数据序列化、过一遍
// 回环 socket、再反序列化回来 —— 多一个端口、多一个随机 apiKey、
// 多一处 40 秒就绪轮询，换不来任何能力。
//
// 直连之后：不占端口、不需要 apiKey、不需要轮询网关存活，
// 本体的模型路由 / 思考档位归一化 / 输出预算钳制 / 工具调用解析
// 全部照旧 —— 因为用的就是本体自己那几个模块，一行都没有重写。
//
// ## 复用的是本体原件（不是复制品）
//
// `parseModelRoute` / `toGenerateOptions` / `toOpenAiSse` /
// `collectOpenAiCompletion` / `collectGatewayModels` 全部直接 import 自
// `vendor/lib/openai-gateway/*`。vendor 是本体原样拷贝，跟着上游升级即可，
// 这里不维护任何一份平行实现。
import {
  parseModelRoute,
  toGenerateOptions,
  normalizeReasoningEffort,
  normalizeMaxTokens,
} from '../vendor/lib/openai-gateway/messages.js'
import {
  toOpenAiSse,
  collectOpenAiCompletion,
  failureToOpenAiError,
} from '../vendor/lib/openai-gateway/stream.js'
import { markGatewayChannel } from '../vendor/lib/openai-gateway/channel.js'
import {
  collectGatewayModels,
  toOpenAiModels,
} from '../vendor/lib/openai-gateway/models.js'
import { effortView } from '../vendor/lib/openai-gateway/effort-view.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'access-control-allow-origin': '*',
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
}

/** 组一个 JSON `Response`（OpenAI 错误形状与模型目录都用它）。 */
export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * 把任意抛错转成 OpenAI 错误响应。
 *
 * `failureToOpenAiError` 已经把「模型不存在」归一成 404、「凭据缺失」归一成
 * 未授权等，所以这里不自己猜状态码 —— 猜了就会把「换个模型名」显示成「上游故障」。
 */
export function errorResponse(error) {
  const converted = failureToOpenAiError(error)
  return jsonResponse(converted.status, converted.body)
}

/**
 * 一个模型在 OpenAI 客户端里能填的**规范档位**（`low` / `high` / `xhigh` …）。
 *
 * 为什么需要翻一遍：magpie 侧的推理强度下拉只认插件给的档位列表，而本体声明的
 * 是各家私有档位名（AStudio 的 `none`/`high`、CodeArts 的 `off`/`on`）。
 * `effortView` 已经把私有名翻成 8 个规范名（`openai_efforts`），请求填规范名
 * 之后由本体网关再翻回真实档位 —— 所以这里直接复用它，插件不再维护第二份映射。
 *
 * 模型没声明档位时返回空数组（**不是** `undefined`）：调用方据此决定根本不发
 * `variants`，与「不声明即未知」的口径一致。
 */
/**
 * 中文档位名 → 规范名。上游 `effortView` 只认**英文 id**（`low` / `high` …），
 * 而豆包（doubao）的适配器声明的是「数字 id + 中文名」（`{id:'3',name:'低'}`）。
 *
 * 实测（2026-11-25）：把豆包那份原样喂给 `effortView` 会得到 `openai_efforts: []`
 * —— 于是模型列表右侧既没有「思考档位」下拉、`variants` 也不存在，而那个模型
 * 其实**能调档位**（上游请求体里就有 `reasoning_effort: '4'`）。
 *
 * 这里在**自己的代码里**先翻译一道，`vendor/` 不动（它是上游构建产物，改一个字节
 * 校验就红）。
 *
 * ⚠️ 只影响「翻译这一层」，真实下发仍用上游的**数字 id** —— `effortView` 会把
 * 原始 `efforts[]` 原样带回（它只是附加 `canonical` 字段），请求侧走的是
 * `normalizeReasoningEffort` / 本体网关，仍然按 id 匹配。
 */
const CN_EFFORT_NAME = new Map([
  ['最低', 'minimal'],
  ['低', 'low'],
  ['中', 'medium'],
  ['中等', 'medium'],
  ['高', 'high'],
  ['极高', 'xhigh'],
  ['更高', 'xhigh'],
  ['最高', 'max'],
  ['最大', 'max'],
  ['关', 'none'],
  ['关闭', 'none'],
  ['不思考', 'none'],
])

/** 把一个档位 id 换成 `effortView` 认得的英文规范名；认不出就原样返回。 */
function canonicalEffortId(id, name) {
  const byName = CN_EFFORT_NAME.get(String(name ?? '').trim())
  if (byName !== undefined) return byName
  const raw = String(id ?? '')
  // 已经是英文规范名（`low` / `xhigh` …）就原样
  if (/^[a-z][a-z0-9_-]*$/i.test(raw)) return raw
  return raw
}

/**
 * 把上游的 `reasoning.efforts` 归一成 `effortView` 能翻的形态。
 *
 * 只动 `id` 字段；`name` 保留原文（中文名在 magpie 的下拉里显示得更好）。
 */
function effortsForView(efforts) {
  if (!Array.isArray(efforts)) return efforts
  return efforts.map((e) => {
    if (e === null || typeof e !== 'object') return e
    const id = e.id ?? e.key
    const mapped = canonicalEffortId(id, e.name)
    return mapped === id ? e : { ...e, id: mapped }
  })
}

/**
 * 模型声明的推理档位，翻成 magpie 认的规范名。
 *
 * 为什么需要翻一遍：magpie 侧的推理强度下拉只认插件给的档位列表，而本体声明的
 * 是各家私有档位名（AStudio 的 `none`/`high`、CodeArts 的 `off`/`on`、豆包的
 * `3`/`4`/`5` + 中文名）。
 * `effortView` 已经把私有名翻成 8 个规范名（`openai_efforts`），请求填规范名
 * 之后由本体网关再翻回真实档位 —— 所以这里直接复用它，插件不再维护第二份映射。
 *
 * 模型没声明档位时返回空数组（**不是** `undefined`）：调用方据此决定根本不发
 * `variants`，与「不声明即未知」的口径一致。
 */
export function openAiEfforts(info) {
  const view = effortView(
    effortsForView(info?.reasoning?.efforts),
    canonicalEffortId(info?.reasoning?.defaultEffort, undefined),
  )
  return Array.isArray(view?.openai_efforts)
    ? view.openai_efforts.filter((e) => typeof e === 'string' && e !== '')
    : []
}

/** 本体 `ctx.llm` 是否已经可用（`_start()` 的轮询判据）。 */
export function llmReady(llm) {
  return llm !== undefined && llm !== null && typeof llm.stream === 'function' && typeof llm.listModels === 'function'
}

/**
 * 一整个 `POST /v1/chat/completions`，进程内完成。
 *
 * @param {object} llm     本体 `ctx.llm`（LlmRuntime）
 * @param {object} body    OpenAI 请求体，`model` 必须已带 provider 前缀
 * @param {AbortSignal} [signal]
 * @param {object} [attachments] 附件服务（`src/attachments.mjs`），入站图片落盘用；缺省＝不支持图片
 * @returns {Promise<Response>} 流式时是 `text/event-stream`，否则是 `application/json`
 */
export async function chatCompletion(llm, body, signal, attachments) {
  if (!llmReady(llm)) throw new Error('magpie-jet-hub: 本体 llm 服务未就绪，无法直连')

  const route = parseModelRoute(body?.model)
  const modelInfo = await llm.resolveModelInfo(route.provider, route.model, signal)

  // 档位与输出预算的归一化与本体网关**同源同口径**：客户端给通用名（low/max…）
  // 而模型用私有 id（light/xhigh…）时按强度就近下发，不回 400。
  const reasoningEffort = normalizeReasoningEffort(
    body.reasoning_effort,
    modelInfo,
    route.provider,
    route.model,
    () => {},
  )
  const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens
  const maxTokens = typeof requestedMaxTokens === 'number'
    ? normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
    : undefined

  // 第 5 个参数是图片桥（`{ bridge, limits }`）。有附件服务就把入站的
  // `image_url` 落盘成 DSH 的 `ImageBlock`；没有则传空对象 —— 纯文本照常，
  // 收到图片时由本体按「未装载附件服务」如实报错，不静默丢图（静默丢图会让
  // 用户以为模型看到了图，而答案其实是基于文本生成的）。
  //
  // ⚠️ 必须把 `limits` 一起给：本体用 `images.limits ?? DEFAULT_IMAGE_LIMITS`
  // 做入站校验，而插件落盘时按自己的 `imageLimits` 再校验一次 —— 两份表要是
  // 不是一个来源，就会出现「本体放过、插件拒绝」这种自相矛盾的报错。
  const images = attachments?.saveImage === undefined
    ? {}
    : { bridge: { saveImage: (input) => attachments.saveImage(input) }, limits: attachments.imageLimits }
  const generate = await toGenerateOptions(body, signal, reasoningEffort, maxTokens, images)
  const fullId = `${route.provider}/${route.model}`
  const stream = llm.stream(markGatewayChannel(generate))

  if (body.stream === true) {
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          // `toOpenAiSse` 的四个出口都会发 `[DONE]`（上游错误 / 缺 finish /
          // 正常结束 / catch），所以这里**不再**补发 —— 补了客户端会收到两条。
          for await (const event of toOpenAiSse(stream, undefined, fullId)) {
            controller.enqueue(encoder.encode(event))
          }
        } catch (error) {
          // 生成器自身异常（不是上游 chunk 里的错误）：补一条错误帧再收尾，
          // 否则客户端收到的是**没有终止帧的半截 SSE**。
          const converted = failureToOpenAiError(error)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: converted.body.error })}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        }
        controller.close()
      },
    })
    return new Response(readable, { status: 200, headers: SSE_HEADERS })
  }

  try {
    const result = await collectOpenAiCompletion(stream, undefined, fullId)
    return jsonResponse(200, result)
  } catch (error) {
    // 上游「模型不存在」在这里已经是 404（本体 stream.js 里归一化过），
    // 原样透出状态码，客户端才能区分「换个模型名」与「上游故障」。
    const converted = failureToOpenAiError(error)
    return jsonResponse(converted.status, converted.body)
  }
}

/**
 * `GET /v1/models`，直接从 `ctx.llm` 采集，不经过任何 HTTP 网关。
 *
 * 除了 id / name，还要把**能力**一并带出来 —— 上游 `listModels` 只给 id、name
 * 与 `inputModalities`，**上下文窗口和输出预算只在 `resolveModelInfo` 里**：
 *
 * | 字段 | 来源 | 实测（2026-10-29） |
 * |---|---|---|
 * | `context_window` | `context.contextWindow` | trae 1000000 / astudio 1048576 |
 * | `max_tokens` | `defaultMaxTokens` | trae 64000 / astudio 100000 |
 * | `input` | `inputModalities`（缺了用 resolve 的） | 46/53 有 |
 * | `reasoning` | `reasoning.efforts` + `defaultEffort` | 48/53 有 |
 *
 * ⚠️ 不补 `context_window` 的后果是**调用方只能按 128K 猜**：magpie 的模型列表
 * 里 53 个模型全显示 128K，而真窗口是 1M —— 用户 2026-10-29 报的就是这个。
 *
 * ⚠️ 这里没有直接调 vendor 的 `collectGatewayEffortViews`：它内部已经逐个
 * `resolveModelInfo`，但只留下档位视图、把同一个结果里的 context 与 maxTokens
 * 丢了；再调一次就是同一件事算两遍。所以这里自己走一遍，逻辑与它一致
 * （逐个 catch，单个模型失败只让它自己少字段）。
 */
export async function modelsPayload(llm) {
  if (!llmReady(llm)) throw new Error('magpie-jet-hub: 本体 llm 服务未就绪，无法读取模型目录')
  // 采集器逐个 provider 兜错（未登录的跳过），承诺永不抛出。
  const groups = await collectGatewayModels(llm, () => {})

  // 每个模型一次 resolveModelInfo：读的是适配器已缓存的目录，不额外发网络请求。
  const infos = new Map()
  if (typeof llm?.resolveModelInfo === 'function') {
    await Promise.all(
      groups.flatMap(({ provider, models }) =>
        (models ?? []).map(async (model) => {
          try {
            const info = await llm.resolveModelInfo(provider, model.id)
            if (info !== undefined && info !== null) infos.set(`${provider}/${model.id}`, info)
          } catch {
            // 单个模型解析失败：它自己不带档位与窗口，目录照常返回
          }
        }),
      ),
    )
  }

  const effortViews = new Map()
  for (const [id, info] of infos) {
    // ⚠️ 与 `openAiEfforts()` 同一道翻译：豆包那种「数字 id + 中文名」不翻就
    // 得到空表，模型行上既没有档位下拉也没有 variants（2026-11-25）。
    const view = effortView(
      effortsForView(info?.reasoning?.efforts),
      canonicalEffortId(info?.reasoning?.defaultEffort, undefined),
    )
    if (view !== undefined) effortViews.set(id, view)
  }

  const data = toOpenAiModels(groups, effortViews)
  for (const row of data) {
    const info = infos.get(row.id)
    if (info === undefined) continue
    const window = info?.context?.contextWindow
    if (typeof window === 'number' && window > 0) row.context_window = window
    const maxTokens = info?.defaultMaxTokens
    if (typeof maxTokens === 'number' && maxTokens > 0) row.max_tokens = maxTokens
    // listModels 没声明模态时用 resolve 的那份（两处口径不同，取更全的）
    if (!Array.isArray(row.input) && Array.isArray(info?.inputModalities) && info.inputModalities.length > 0) {
      row.input = [...info.inputModalities]
    }
  }
  return { object: 'list', data }
}
