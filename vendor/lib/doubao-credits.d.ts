/**
 * 豆包（Doubao）积分额度余额与每日签到（薄壳）。
 *
 * ## 余额（2026-11-26 晚修正：POST 之后直接可读，全程无浏览器、无签名）
 *
 * ## 面板「订阅与额度管理」顶部的数字来自
 *
 * - 本文件：**余额**（真实读 commerce `quota/summary`）+ **签到薄壳**（把凭据转给 `doubao-signin.ts`）；
 * - `src/doubao-upstream.ts`：额度/模型/对话三条腿的共享协议；
 * - `src/doubao-signin.ts`：**沙箱签名 + 直连 HTTP**（2026-11-26 起零浏览器；
 *   历史实现曾是 CDP 页面会话驱动，已删除）。
 *
 * ## ⚠️⚠️ 2026-11-26 的两条错误结论（已作废，别再抄）
 *
 * 1. **「commerce 网关校验 `a_bogus`，服务端一律 404」是错的**。
 *    404 的唯一原因是**方法用错**：这些端点全是 `POST`，当时拿 `GET` 打。
 *    实测三条对照（同一 cookie、同一 query）：
 *    - `a_bogus` 随机改 4 个字符 ⇒ **200**
 *    - 整段删掉 `a_bogus` ⇒ **200**
 *    - 换成 `GET` ⇒ **404**
 *    ⇒ **余额这条腿不需要签名**，`bdms` 沙箱只服务签到那条链路。
 * 2. **金额是带千分位的字符串**（`"4,003"`），不是 number；
 *    到期时间是**毫秒**（`1797937149723`），不是秒。
 *    这两点都会静默错位：`Number("4,003")` = NaN ⇒ 卡片显示 0；
 *    秒当毫秒 ⇒ 全部判成 1970 年已过期。
 *
 * ## 签到
 *
 * 签到仍在 `src/doubao-signin.ts`（纯 HTTP + `bdms` 沙箱签名），本文件只做薄壳转发。
 * - **签到端点**：`POST https://www.doubao.com/alice/ug/campaign/landing/checkin`
 *   （公共 query 见 `src/doubao.ts` 的 `doubaoCheckinQuery`），body
 *   `{"scene":"pc_incentive_task_mvp_v3"}`，响应
 *   `{data:{checked_in,checkin_date,continuous_days,idempotent,reward_amount,…},code:0}`。
 * - **鉴权 = cookie**（`sessionid`/`sid_tt`/`ttwid` 等），无 `Authorization`。
 * - **签名 = query 的 `a_bogus`**，由 `window.bdms.frontierSign` 生成
 *   （`bdms` 只在 doubao.com 页面里存在）⇒ **签到必须签名**。
 *   ⚠️ 2026-11-26 起签名在 `node:vm` 沙箱里跑**随包内置**的官方 SDK（零下载、零浏览器）。
 *   纯 Node fetch 产不出合法 `a_bogus`（实测裸 fetch 恒 `710010702 系统错误`）。
 * - **幂等**：`idempotent: true`（重复调用安全，今日已签会回 `checked_in:true`）。
 *
 * ```
 * POST https://www.doubao.com/alice/commerce/sale/subscription/overview/
 *      ?<公共 query>          # 只要 aid/device_platform/version_code 即可
 *      body: {"product_line":"membership"}
 * ```
 *
 * 响应 `data.quota_balance_overview`（实测 2026-11-26，真 cookie）：
 *
 * ```jsonc
 * {
 *   "total_remaining_amount": "4,003",
 *   "summaries": [
 *     { "category": 1, "title": "套餐", "remaining_amount": "2,142" },
 *     { "category": 3, "title": "赠送", "remaining_amount": "1,861" }
 *   ],
 *   "top_items": [ { "display_name": "豆包工作体验套餐", "total_amount": "2,142",
 *                    "used_amount": "0", "used_percent": 0,
 *                    "end_time": 1797937149723, "time_type": 2 }, … ]
 * }
 * ```
 *
 *
 * @module src/doubao-credits.ts
 */
import type { ClaimOutcome, CreditBalance } from './credits.js';
import { type DoubaoCredential } from './doubao.js';
export declare const DOUBAO_HTTP_TIMEOUT_MS = 15000;
/** 额度总览端点（实测自面板真实请求，2026-11-26）。 */
export declare const DOUBAO_OVERVIEW_PATH = "/alice/commerce/sale/subscription/overview/";
/** 请求体：面板固化的 `product_line`（`entry/config` 与 `card/list` 另有各自的 body）。 */
export declare const DOUBAO_OVERVIEW_BODY = "{\"product_line\":\"membership\"}";
/** 上游金额既可能是 `"4,003"`，也可能是纯数字 —— 两种都要吃得下。 */
type DoubaoAmount = string | number | null | undefined;
/** `quota_balance_overview.summaries[]`：按分类聚合的剩余（面板顶部那两行）。 */
interface DoubaoQuotaSummary {
    /** 1 = 套餐，3 = 赠送；缺失时按 `title` 兜底。 */
    category?: number;
    /** 面板上的分类名（「套餐」「赠送」）。 */
    title?: string;
    /** 该分类剩余额度（`"2,142"` 这种带千分位的字符串）。 */
    remaining_amount?: DoubaoAmount;
}
/** `quota_balance_overview.top_items[]`：明细条目（只给前几条，`has_more` 标记截断）。 */
interface DoubaoQuotaTopItem {
    category?: number;
    display_name?: string;
    total_amount?: DoubaoAmount;
    used_amount?: DoubaoAmount;
    used_percent?: number;
    /** 到期时刻（**毫秒**）。 */
    end_time?: number;
    time_type?: number;
}
interface DoubaoQuotaBalanceOverview {
    has_more?: boolean;
    summaries?: DoubaoQuotaSummary[];
    top_items?: DoubaoQuotaTopItem[];
    total_remaining_amount?: DoubaoAmount;
}
/** 分类维度的「总额 + 已用」聚合（`window_limit_section` / `incentive_quota_section` 同构）。 */
interface DoubaoWindowLimit {
    total_amount?: DoubaoAmount;
    used_amount?: DoubaoAmount;
    used_percent?: number;
    /**
     * ★★★ **到期时刻（毫秒）** —— 2026-11-26 双审 P2-1 更正：这个字段**必须在类型里**。
     *
     * 之前的版本把它删了，注释理由是「`top_items` 不带分类归属 ⇒ 拿不到逐笔到期」。
     * 但 `window_limits[]` **正是本文件逐行读的那个数组**（`categoryTotalsOf` 的
     * `for (const limit of group?.window_limits ?? [])`），它**就在分类分组下面**
     * ⇒ 分类归属是有的。master（`6eea0cfa`）原本也用它算 `expiredTime`（`:99`）。
     *
     * ⇒ 删掉它 = **把本来拿得到的真实到期日丢掉**，连带让临期桶退化。
     *   现在的策略：**该分类下所有行都给出同一个 `end_time` ⇒ 用它；否则退回
     *   `expiryUnknown`**（既准确又不撒谎）。
     */
    end_time?: number;
}
interface DoubaoWindowLimitGroup {
    feature_group?: string;
    feature_group_name?: string;
    window_limits?: DoubaoWindowLimit[];
}
interface DoubaoLimitSection {
    window_limit_groups?: DoubaoWindowLimitGroup[];
}
interface DoubaoOverviewPayload {
    quota_balance_overview?: DoubaoQuotaBalanceOverview | null;
    window_limit_section?: DoubaoLimitSection | null;
    incentive_quota_section?: DoubaoLimitSection | null;
}
/**
 * 解析上游金额：`"4,003"` / `"0"` / `4003` ⇒ `number`；认不出 ⇒ `NaN`。
 *
 * ⚠️ 直接 `Number("4,003")` 是 `NaN` —— 卡片会显示 0，看上去像「额度用光了」。
 */
export declare function parseDoubaoAmount(value: DoubaoAmount): number;
export declare function doubaoBalanceFromOverviewPayload(payload: DoubaoOverviewPayload | null | undefined): CreditBalance;
/**
 * 拉取豆包积分额度（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * @param options.fetchImpl 测试注入点（生产路径 = 全局 `fetch`）。
 */
export declare function fetchDoubaoBalanceDetailed(credential: DoubaoCredential, options?: {
    log?: (msg: string) => void;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<{
    balance: CreditBalance | null;
    error?: string;
}>;
/**
 * 执行豆包每日签到领取。
 *
 * 真正的实现是 `src/doubao-signin.ts` 的 `claimDoubaoDaily`：用 `doubao-bdms.ts`
 * 在 Node 沙箱里产 `a_bogus` 后直连签到接口（**全程无浏览器、无兜底**）。
 * 本函数是它的薄壳：把凭据原文与可选注入点转过去，**`ClaimOutcome` 原样上抛**
 * （`failed` 不许被吞成 `inactive`，否则面板会把"签名坏了"显示成"今天没活动"）。
 *
 * ⚠️ 凭据必须带 `cookie`（登录会话）；没有它 ⇒ `inactive`（不发请求）。
 * ⚠️ `options.sign` 只给单测注入用（生产路径不传 ⇒ 走沙箱签名）。
 */
export declare function claimDoubaoDailyCheckin(credential: DoubaoCredential, options?: {
    sign?: () => Promise<string>;
    log?: (message: string) => void;
}): Promise<ClaimOutcome>;
export {};
//# sourceMappingURL=doubao-credits.d.ts.map