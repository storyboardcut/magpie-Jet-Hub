/**
 * 豆包（Doubao）`a_bogus` 签名 —— 跑**仓库内置**的官方 bdms SDK。
 *
 * ## 背景
 *
 * 签到的 `POST /alice/ug/campaign/landing/checkin` 必须带 query `a_bogus`，它由页面里的
 * `window.bdms.frontierSign(...)` 生成。原实现为此必须起一个 Chromium（CDP 路径），
 * 从而把「签到」绑死在「运行环境里有浏览器」上。
 *
 * bdms 本身并不需要真浏览器：它是一坨自包含的 rspack chunk（163KB），只用到
 * `document` / `navigator` / `location` / `performance` / `XMLHttpRequest`（风控埋点，
 * 签名不依赖）。⇒ 在 `node:vm` 里造一个最小环境就能跑起来，零浏览器、零额外依赖。
 *
 * ## ⚠️ 安全口径（2026-11-26 复审后重写）
 *
 * 1. **SDK 随包内置，运行时零下载零网络**。早年实现是「运行时从豆包 CDN 拉 163KB JS
 *    再在主进程 `node:vm` 里执行」——那等于把 `hub` 主进程（它持有全部 provider 的
 *    凭据）的执行权交给外部 CDN，且没有任何完整性校验。现在源码就在
 *    `src/assets/doubao-bdms-sdk.<hash>.js`，进 git 可审、离线可用。
 * 2. **sha256 钉扎**。内置文件在装载前必须与 {@link DOUBAO_BDMS_SDK_SHA256} 逐字节一致，
 *    不匹配直接抛错（不执行）。升级上游 SDK 时是「改文件 + 改常量」的显式动作。
 * 3. **不往 sandbox 里递任何宿主对象**。`vm` 不是安全边界，而只要有一个宿主函数/对象
 *    进了上下文，就能经 `constructor.constructor` 摸到宿主的 `process`。
 *    ⇒ 这里把 `document` / `navigator` / `atob` / `btoa` / `require('SE')` 的替身
 *    **全部在上下文内部造**，宿主只交出一个字符串（SDK 源码）。
 * 4. **`require` 白名单**。SDK 只 `__webpack_require__("SE")`（拿 process 替身），
 *    其余一律抛错；替身里**故意不带 `versions.node`** ⇒ SDK 判定「非 Node」，
 *    走它自带的纯 JS md5 分支（正是浏览器里的那条腿），也就不需要 `crypto` / `Buffer`。
 *
 * ## 上下文里**没有**的宿主全局（TextDecoder / URL / AbortController …）
 *
 * SDK 源码里出现 `URL` ×42、`TextDecoder` ×2，但**签名路径一次都没走到**（实测
 * `frontierSign` 正常返回 16 字符），所以这里没有照抄一份半吊子的实现 —— 造错的
 * `URL` / `TextDecoder` 会**静默**签出与服务端不一致的指纹，比直接抛错难查得多。
 *
 * 若上游改版后真的走进这些分支，表现是 `ReferenceError: URL is not defined` 之类的
 * **可诊断**抛错（`doubao-signin.ts` 会把它原样写进失败文案）⇒ 那时按报错补实现，
 * 并**同时**加一条「补的实现与 Node 宿主语义一致」的断言。**不会**静默失败。
 *
 * ## 纪律
 *
 * - **失败绝不静默**：文件缺失 / 哈希不符 / SDK 结构变化 / 签名空串，全部抛带原因的
 *   Error，由 `doubao-signin.ts` 原样写进用户的失败文案；
 * - **实例缓存**：初始化要跑 163KB 代码，签到是每天每账号一次 ⇒ 进程内复用同一实例；
 * - **只做签名**，不发任何网络请求（SDK 里那条 `XMLHttpRequest` 是 Slardar 埋点，
 *   沙箱里是空实现）。
 *
 * @module src/doubao-bdms.js
 */
import vm from 'node:vm';
/** 内置 SDK 的 sha256 —— 装载前逐字节校验，**升级 SDK 时必须同步改这里**。 */
export declare const DOUBAO_BDMS_SDK_SHA256 = "4be42e52f0b691d74b14dac00d305e95aadd4f4dba5f305dcbf14ed8ec33b32d";
/**
 * 校验 SDK 源码与钉扎的 sha256 是否一致（导出仅为单测）。
 *
 * @throws 内容被改动 / 文件不是内置那一份。
 */
export declare function verifyDoubaoBdmsSdkSource(source: string): void;
/** 读内置 SDK（同步、零网络），并做完整性校验。 */
export declare function loadDoubaoBdmsSdk(): string;
/**
 * 建一个纯净上下文并跑预置代码（导出仅为单测：用来断言上下文里没有宿主对象）。
 */
export declare function createBdmsContext(): vm.Context;
/**
 * 产出一枚 `a_bogus`（等价于页面里的 `window.bdms.frontierSign({'X-MS-STUB':''})`）。
 *
 * @throws 读不到内置 SDK / 哈希不符 / SDK 结构变化 / 签名空串 —— 调用方把原因写进失败文案。
 */
export declare function signDoubaoBogus(options?: {
    log?: (msg: string) => void;
}): Promise<string>;
/** 清缓存（单测 / 升级内置 SDK 后强制重载用）。 */
export declare function resetDoubaoBdmsSigner(): void;
//# sourceMappingURL=doubao-bdms.d.ts.map