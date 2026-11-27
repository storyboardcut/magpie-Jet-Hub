/**
 * ★★★ **凭据 JSON 的容错解析**（issue #182 第六节，2026-11-27 实测）。
 *
 * ## 缺陷
 *
 * 报障者的 accio 账号昵称是 `"Maxi\nPan"` —— **凭据文件里存的是一个裸换行**（不是 `\n` 转义）。
 * `JSON.parse` 对此抛：
 *
 * ```
 * SyntaxError: Bad control character in string literal in JSON at position …
 * ```
 *
 * 而解析点在 `try` 里（`account-pool.ts:3586`）⇒ **整个账号被跳过**
 * ⇒ 表面症状是「那个账号不见了」，与「没登录」「凭据失效」**同形**。
 *
 * ⚠️ 他实测：**团队账号恰好是这一条** ⇒ 一度读不到任何团队数据。
 *
 * ## 修法
 *
 * 裸控制字符（`U+0000`–`U+001F`）在 JSON **字符串字面量内本来就是非法的** ——
 * 它们**不可能**出现在结构位置（`{}` `[]` `,` `:` 之间）。
 * ⇒ 全局把它们转成 `\uXXXX` **不改变任何合法输入的语义**，只把非法输入救回来。
 *
 * ⚠️ **不要改成**「先 `replace` 掉换行」（那会**静默改写数据**：`"a\nb"` 变成 `"ab"`）。
 *    转义成 `\u000a` 后解析出来的字符串仍是 `a\nb`（两个字符），**语义不变**。
 */
/**
 * 解析凭据 JSON；对**裸控制字符**做一次转义重试。
 *
 * @throws 两次都失败时抛**原始**错误（保留调用方原有的「跳过这个账号」语义）。
 */
export declare function parseCredentialJson<T>(raw: string): T;
//# sourceMappingURL=credential-json.d.ts.map