import { type AccioRegion } from './accio-product.js';
/** 凭据结构。 */
export interface AccioCredential {
    /**
     * ⚠️ **必须是这个名字**：`AccountPool.findAccountIdByCredential` 对非 codearts 的
     * provider 一律取 `access_token` 作身份标识。上游是不透明 32 字符串（非 JWT）。
     */
    access_token: string;
    refresh_token: string;
    /**
     * ⚠️ **毫秒**。
     *
     * ⚠️⚠️ 上游 `expiresAt` 是**秒**（官方客户端自己也做 `1e3 *`）。若忘了归一化，
     * `new Date(1794407698)` = **1970 年** ⇒ 判定「早已过期」⇒ 每个请求都触发续期
     * ⇒ 并发下反复消费 `refresh_token` ⇒ `invalid_grant` ⇒ **账号被标死**。
     * 这与 codearts 的「续期单向门」事故同型，且更隐蔽（错的是**时间量纲**）。
     * ⇒ 归一化只在 `accio-oauth.ts` 的兑换/续期返回处做**一次**。
     */
    expires_at: number;
    /** 兑换时下发。⚠️ 实测**不必需**，但保留零成本、删除是单向下注。 */
    sgcookie?: string;
    /** 登录时选的区域 —— 续期与推理要按它选登录域。 */
    region: AccioRegion;
    user_id?: string;
    accio_id?: string;
    nickname?: string;
    /**
     * ★★★ **当前所在空间的团队 id**（issue #177，2026-11-27）。
     *
     * 由 `POST /api/auth/userinfo` 的 `activeTeam.teamId` 得到（该字段一直就在响应里，
     * 本仓此前从未解析）。**有值 ⇒ 所有 accio 请求必须带 `x-team-id`**，否则上游按
     * 个人空间返回额度 / 用个人额度推理。
     *
     * ⚠️ `undefined` / `null` 都表示**个人空间**，两者语义相同（不要只判一种）。
     * ⚠️ 故意**不写进 `access_token` 之类的必填位**：旧凭据没有这个字段也必须能继续用
     *    （向后兼容），缺省即个人空间 —— 与改动前行为逐字节相同。
     */
    teamId?: string;
    /** 团队展示名（仅展示用，请求不需要）。 */
    teamName?: string;
    /**
     * ★ 服务端按账号下发的区域（`userinfo` 的 `routeRegion`），用于 `x-accio-route-region`。
     * 与本文件上面那个 `region`（**登录时选的域**）是两回事，别合并。
     */
    routeRegion?: string;
}
/**
 * 秒→毫秒归一化。**所有**写入 `expires_at` 的地方都必须经过它。
 *
 * @param raw 上游 `expiresAt`（**秒**）或已是毫秒的值。
 * ⚠️ `> 1e12` 视为已是毫秒（防御性：容忍上游某天改单位）。
 */
export declare function accioExpiresAtMs(raw: unknown): number | undefined;
/** 凭据的过期时刻（毫秒）；读不到返回 `undefined`（**不伪装成 0**）。 */
export declare function accioCredentialExpiresAtMs(credential: AccioCredential): number | undefined;
/** 是否已过期。读不到过期时间时视为**未过期**（让适配器按需续期兜底）。 */
export declare function isAccioExpired(credential: AccioCredential): boolean;
/** 是否可续期 —— ⚠️ 只要求 `refresh_token` 非空（不读池里的 `refreshable`）。 */
export declare function isAccioRefreshable(credential: AccioCredential): boolean;
/** 一次请求的 id（也用于 `sg_k` 与 `message_id` 的派生）。 */
export declare function accioRequestId(): string;
/** `sg_k` = md5(requestId) 的 hex。 */
export declare function accioSgK(requestId: string): string;
/**
 * `message_id` —— ⚠️ **必填**，缺它上游回 400（与其它字段无关）。
 *
 * 掺入随机量：同一 `requestId` 连续两次不能相同（上游可能按它去重）。
 */
export declare function accioMessageId(requestId: string): string;
/**
 * camelCase → snake_case（递归），与官方客户端的 `Vn()` 同口径。
 *
 * ⚠️ `undefined` 的键**整个丢掉**：保留会让 JSON 里出现 `null`，
 * 而上游对 `system_instruction: null` 之类的处理与「键不存在」不同。
 */
export declare function accioToSnake(value: unknown): unknown;
/** 一次 LLM 请求的输入。 */
export interface BuildAccioBodyOptions {
    model: string;
    accessToken: string;
    contents: readonly unknown[];
    systemInstruction?: string;
    tools?: readonly unknown[];
    temperature?: number;
    maxOutputTokens?: number;
    utdid: string;
    requestId: string;
}
/**
 * 构造请求体（已 snake_case 化）。
 *
 * ⚠️ 四处硬约束（逐条实测 / 逐字逆向）：
 * 1. `empid` / `tenant` / `iai_tag` **必须空串**（真实值会被拒）；
 * 2. `message_id` **必填**；
 * 3. `token` 必须在 **body**（放 `Authorization` 头恒流内 402）；
 * 4. ⚠️⚠️ **`system_instruction` 是「字符串」，不是 `{parts:[{text}]}` 对象**。
 *    本函数初版照 Gemini 的 `systemInstruction.parts` 形态产出**对象**，
 *    实测**恒回 `HTTP 200` + 流内 `400`**（Task 6 真机验证）。
 *    **权威证据**（官方 proto，`gateway-worker.js`）：
 *    `systemInstruction: gt(e.systemInstruction) ? globalThis.String(e.systemInstruction) : …`
 *    —— 两处都用 `String()` 归一；诊断路径的判据同样是
 *    `typeof t.system_instruction === 'string'`。
 *    ⇒ Accio 与 Gemini 在这一格上**不同形**，别照搬 Gemini。
 */
export declare function buildAccioBody(options: BuildAccioBodyOptions): Record<string, unknown>;
/** 请求头。⚠️ **不带** SecurityGuard 的 `pctb-x-*`（实测不必需）。 */
export declare function accioHeaders(options: {
    utdid: string;
    sgcookie?: string;
    /**
     * ★★★ **当前空间的团队 id**（issue #177，2026-11-27）。
     *
     * ## 少了它会发生什么
     *
     * 官方客户端 `yo()` 把这个值作为 `x-team-id` **注入所有出站请求**。不带它的请求
     * 会被上游当成「默认/个人空间」⇒ 团队账号查到的额度是**个人那份**（用户实测：
     * 团队订阅 8000，插件只看到 520），推理也用不到团队额度。
     *
     * ⚠️ **空串必须不发这个头**（不是发空值）：官方拦截器里
     * `t && !e.headers['x-team-id'] && delete e.headers['x-team-id']` —— 它自己也会把
     * 空值删掉。这里照抄该语义。
     *
     * ## ⚠️⚠️ **实测更正（2026-11-27，issue #177 作者）**
     *
     * 上面那段「不带它 ⇒ 团队额度看不到」是**我的推测，已被实测推翻**：
     *
     * > 「**加 `x-team-id` 无效** —— 插件侧仍是个人 FREE/101/520。」
     * >
     * > 「根因定稿：**空间是服务端会话状态**（`POST /space/switch` 切换，本机网关
     * >  `localhost:4097`），额度/推理请求按当前空间返回；Jet Hub 只走公开网关 + query
     * > token，**没有 space 概念**，所以永远落在个人空间。」
     *
     * ⇒ **这个头本身发得是对的**（官方确实对所有非 publicCatalog 请求注入它），
     *   但**它决定不了额度所属空间** —— 空间是会话态，不是请求头。
     *   **保留它**的理由：对齐官方请求形状、无害；
     *   **不保留**的理由：它不解决团队额度。
     *
     * ⇒ **团队额度做不到**，除非改走本机网关 + `POST /space/switch`（架构级改动，未做）。
     */
    teamId?: string;
    /**
     * ★ 服务端按账号下发的区域（本仓 `AccioUserInfo.routeRegion` 已有）。
     * 官方同样由 `yo()` 注入成 `x-accio-route-region`；缺它可能导致目录/路由走错区。
     */
    routeRegion?: string;
    /**
     * ★ 登录域（`'cn'` / `'global'`）。用于决定是否发 `x-package-region: GLOBAL`。
     * ⚠️ 与上面 `routeRegion`（**服务端下发**的区域）是两回事，别合并。
     */
    region?: 'cn' | 'global';
}): Record<string, string>;
//# sourceMappingURL=accio.d.ts.map