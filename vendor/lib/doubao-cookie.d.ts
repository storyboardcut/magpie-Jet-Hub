/**
 * 豆包 cookie 导入的**文本归一化**（2026-11-26）。
 *
 * ## 为什么单独成模块
 *
 * 用户实际会粘进来的形态至少三种，任何一种处理不好都是「导入失败但不知道为什么」：
 *
 * 1. `sessionid=…; ttwid=…`（DevTools 里 Headers → Cookie 那一行）；
 * 2. `Cookie: sessionid=…; ttwid=…`（带前缀，常被一起复制）；
 * 3. **整段 cURL**（`Copy as cURL` 最省事：Chrome 新版会把 `cookie` 头折叠，
 *    很多人干脆复制 cURL）—— 里面 cookie 在 `-H 'cookie: …'` 或 `-b …` 里。
 *
 * ⚠️ 只做「取出看起来像 cookie 的部分」，**不校验语义**：`sessionid` 在不在、
 *    值对不对由调用方（`jet-hub-rpc.ts` 的 `mode: 'cookie'` 分支）判。
 *
 * @module src/doubao-cookie
 */
/** 把任意形态的粘贴内容归一成 `a=1; b=2`（取不出任何 pair 时返回空串）。 */
export declare function normalizePastedCookie(raw: unknown): string;
//# sourceMappingURL=doubao-cookie.d.ts.map