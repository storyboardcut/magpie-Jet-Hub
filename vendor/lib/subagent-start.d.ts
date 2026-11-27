/**
 * **子代理起点分配**（从 `credential-resolver.ts` 提取，2026-11-25）。
 *
 * ## 为什么单独成模块
 *
 * 本仓有两类 provider：
 *
 * | 类型 | 选号实现 | 子代理支持 |
 * |---|---|---|
 * | **走 resolver**（buddy / qoder / trae / trae …）| `createCredentialResolver` | ✅ 自动拥有 |
 * | **自建选号**（codearts / officeace / …）| 各自的 `resolveCredential` / factory | ❌ **拿不到** |
 *
 * 这些逻辑原先**内联在 `credential-resolver.ts`** 里（约 50 处调用点），
 * 自建选号的 provider 想支持子代理只能**手抄一份** —— 而本仓已有记录：
 * 同一语义两套实现必然漂移（上游为这套逻辑改过 **6 轮审计**）。
 *
 * ⇒ 提取成**纯函数 + 依赖注入**，两类 provider 共用同一份判据。
 *
 * ## 语义（三级优先级，与上游 `credential-resolver` 逐字同构）
 *
 * | 级 | 来源 | 含义 | `fixed` 模式下 |
 * |---|---|---|---|
 * | ① | `userPickedAccountId` | 用户在该子代理页面手动选的 | **仍生效**（最具体）|
 * | ② | `pinnedAccountId` | 系统拉起时固定 / 重算的 | **跳过**（旧策略的结果）|
 * | ③ | 策略现算 | `fixed` 位次 / `sequence` / `reverse` / `hash` | **必须走到** |
 *
 * ⚠️ **`fixed` 模式必须跳过 ②**：若该子代理早先落下了 pin（比如之前用
 * `sequence`，用户后来改成 `fixed`），② 会命中 ⇒ ③ 的 `fixed` 分支
 * **永远走不到** ⇒ 用户改位次无效，而界面显示的是新位次 ⇒ 界面与实效不一致。
 *
 * ## 纯函数纪律
 *
 * 本模块**不做任何 IO**：
 * - 所有池读取通过注入的 `pool` 回调；
 * - 不读 `Date.now()`（调用方传入）；
 * - 不写盘（`pinSubagentAccount` / `recordSubagentStart` 由调用方执行）。
 *
 * @module src/subagent-start
 */
import { isSubagentSession } from './subagent-rotation.js';
import type { SubagentAssignment } from './subagent-rotation.js';
import type { SubagentRotationSetting } from './jet-hub-store.js';
import type { RotationStartTier } from './jet-hub-store.js';
import type { BuddySelectorLike } from './buddy-balance-selector.js';
import { BUDDY_BALANCE_TIER, buddyBalanceTier } from './buddy-balance-rank.js';
/** 策略模式（与 `SubagentRotationSetting.startMode` 同值域，但显式列出便于阅读）。 */
export type SubagentStartMode = 'follow' | 'sequence' | 'reverse' | 'hash' | 'fixed';
/**
 * 子代理起点分配所需的**池读能力**（注入，便于单测替身）。
 *
 * ⚠️ **全部可选**：缺省时退化为主代理行为（既有语义），
 * 这是「单测替身与结构 stub 不实现时必须走既有路径」的兑现。
 */
export interface SubagentStartPoolLike {
    subagentRotationFor?(provider: string): SubagentRotationSetting | undefined;
    subagentAssignmentOf?(provider: string, sessionId: string | undefined): SubagentAssignment | undefined;
    preferredRotationFor?(provider: string, sessionId: string): string | undefined;
    listAccountsByProvider(provider: string): ReadonlyArray<{
        id: string;
        enabled: boolean;
    }>;
    /**
     * ⚠️ **登记起点分配**（2026-11-25 加，修 Bug 1）。
     *
     * `decideSubagentStart` 靠 `subagentAssignmentOf` 拿 `slot` 算错开位次，
     * 而那张表只有本方法会写。**自建选号的 provider（codearts / officeace）
     * 原先完全没有调它** ⇒ 分配表恒空 ⇒ `slot` 恒 0 ⇒ 全撞号。
     *
     * ⚠️ 可选：单测替身不实现时 `registerSubagentStartIfNeeded` 静默跳过
     *    （行为与改动前一致）。
     */
    recordSubagentStart?(provider: string, sessionId: string, parentSessionId: string, now: number): Promise<number>;
}
/** 起点分配的结果。 */
export interface SubagentStartDecision {
    /**
     * 决策出来的起点账号 id。
     *
     * ⚠️ `undefined` ⇒ **保持调用方原有的起点**（主代理行为逐字节不变）。
     */
    startId?: string;
    /**
     * ★ **是否「绝对第一」**（无视档位变化，恒排第一）。
     *
     * 只有两种情形为 `true`：
     * - 子代理的起点的**所有权属于子代理**（pin / userPicked / 策略现算）；
     * - `fixed` 模式（用户明确要求「该号烧完才切」）。
     */
    pinnedFirst: boolean;
    /**
     * 起点是否由**子代理**决定（而非主代理）。
     *
     * 调用方据此决定「不传档位快照」—— 因为那份快照属于主代理的起点。
     */
    ownedBySubagent: boolean;
    /**
     * 选完账号后**是否重新 pin**。
     *
     * ⚠️ `fixed` 模式**不 pin**：位次是用户设的，pin 会让下次「位次变了也不生效」
     * （与「`fixed` 跳过 ②」同一个理由）。
     */
    shouldPin: boolean;
    /** 决策来源（供诊断 / 日志，不影响选号）。 */
    decidedBy: 'user-pick' | 'pin' | 'fixed-position' | 'strategy' | 'follow' | 'none';
}
/**
 * 该子代理是否**该登记起点**（`subagent/start` 首次到达时）。
 *
 * ## 判据三条同时成立
 *
 * 1. 配了子代理设置且**已启用**（`subagentSettingActive`）；
 * 2. 该会话**确实是子代理**（父会话可解析）；
 * 3. 尚未登记过（`recordSubagentStart` 内部幂等，这里只做「要不要调」的判断）。
 *
 * ⚠️ 为什么单独抽出来：`credential-resolver` 里这条判据曾经**绑在
 * 「免费模型 / 主代理有起点」两个额外条件里**（上游 `cde3201c` 修的真缺陷：
 * 两条静默失效）。自建选号的 provider 若手抄，必然重现。
 */
export declare function shouldRegisterSubagentStart(setting: SubagentRotationSetting | undefined, sessionId: string | undefined, parentSessionId: string | undefined): boolean;
/**
 * ★★★ **登记子代理起点分配 —— 自建选号 provider 的共享入口**
 * （2026-11-25 修 Bug 1）。
 *
 * ## 这个函数修的是什么（用户原话）
 *
 * > 「子代理设置里面的帐号分布方式不成功」
 *
 * ## 根因
 *
 * `decideSubagentStart` 读 `assignment.slot` 来算错开位次，而 `assignment`
 * 来自 `subagentAssignmentOf(provider, sessionId)` —— 那张表**只有
 * `recordSubagentStart` 会写**。
 *
 * | provider | 选起点 | **登记分配** | 后果 |
 * |---|---|---|---|
 * | buddy 系（`credential-resolver`）| ✅ | ✅ | 正常 |
 * | **codearts**（`index.ts`）| ✅ | ❌ **原先没有** | slot 恒 0 ⇒ 全撞号 |
 * | **officeace**（`officeace-lock.ts`）| ✅ | ❌ **原先没有** | 同上 |
 *
 * ⇒ 三个 provider 对同一件事只做了三分之二 —— 本仓反复记录的
 *   「同一语义多处实现必然漂移」。
 *
 * ## 为什么必须抽成这里（而不是各 provider 手抄）
 *
 * `credential-resolver.ts:720-734` 的判据曾经**绑在「免费模型 / 主代理有起点」
 * 两个额外条件里**（上游 `cde3201c` 修的真缺陷：两条静默失效）。
 * 手抄必然重现 ⇒ 这里与那边用**同一个** `shouldRegisterSubagentStart`。
 *
 * ## ⚠️ 为什么是 fire-and-forget
 *
 * `recordSubagentStart` 内部**先同步更新缓存**、再异步落盘（见 `account-pool.ts`）
 * ⇒ `void` 掉是安全的，且**本次请求就能读到新 slot**（本函数紧接着要算起点）。
 *
 * @param options.pool        池（必须实现 `recordSubagentStart`）
 * @param options.providerId  provider id
 * @param options.sessionId   子代理自己的会话 id
 * @param options.parentSessionId 父会话 id（`undefined` ⇒ 不登记，宁缺不猜）
 * @param options.setting     子代理设置（`undefined` ⇒ 没配 ⇒ 不登记）
 * @returns 是否**发起了**登记（`false` = 条件不满足，调用方可据此诊断）
 */
export declare function registerSubagentStartIfNeeded(options: {
    pool: {
        recordSubagentStart?(provider: string, sessionId: string, parentSessionId: string, now: number): Promise<number>;
    };
    providerId: string;
    sessionId: string | undefined;
    parentSessionId: string | undefined;
    setting: SubagentRotationSetting | undefined;
    /** 注入时钟（单测可固定）。 */
    now?: () => number;
}): boolean;
/**
 * ★★★ **算子代理的起点**（本模块的唯一入口）。
 *
 * @param options.providerId  provider id（池读取用）
 * @param options.sessionId   当前会话（子代理自己的）
 * @param options.candidateIds 当前**可用**候选（enabled / 未封禁 / 未限流）
 * @param options.allowPermanent 是否允许烧永久积分（档位判据要用）
 * @param options.pool        池读能力（注入）
 * @param options.selector    余额分档选择器（`cachedTierOf` 用于档位过滤）
 * @param options.mainSessionStartId 主代理当前起点（`undefined` = 主代理没配）
 *
 * @returns 决策；`startId === undefined` ⇒ 调用方**保持原起点**。
 */
export declare function decideSubagentStart(options: {
    providerId: string;
    sessionId: string | undefined;
    candidateIds: readonly string[];
    allowPermanent: boolean;
    pool: SubagentStartPoolLike;
    selector?: BuddySelectorLike;
    mainSessionStartId?: string;
    /**
     * ⚠️ 主代理的起点（用于「主代理自己不是子代理」时的档位基准）。
     * 传 `undefined` ⇒ 用 `bestTierAnchorId` 找档位最优的号作锚。
     */
    baseRotationStartId?: string;
}): SubagentStartDecision;
/**
 * 找「档位最优（临期优先）且可用」的账号作锚点。
 *
 * ⚠️ 从 `credential-resolver.ts` 原样提取（**行为不变**）。
 *
 * ## 为什么需要
 *
 * 「无锚点」恰是**生产默认**（主代理不指定起点）。上一版在无锚点时直接用
 * 全池 ⇒ 档位过滤一次都没生效 ⇒ 池 `[临期A, 临期B, 永久P]` 时
 * **第二个子代理拿到永久号、先烧永久积分**（上游双审 P1①）。
 */
export declare function bestTierAnchorId(enabledIds: readonly string[], selector: BuddySelectorLike | undefined, allowPermanent: boolean): string | undefined;
/**
 * 取「与主代理起点**同档位**」的账号子集。
 *
 * ⚠️ 从 `credential-resolver.ts` 原样提取（**行为不变**）。
 *
 * ## 为什么必须做档位过滤
 *
 * 用户明确要求「子代理也要遵守档次优先：临期 → 短期 → 永久」。
 * 不过滤 ⇒ 子代理可能错开到永久号上 ⇒ **先烧永久积分**。
 *
 * @param mainStartId 主代理当前起点（**不是**子代理的）
 */
export declare function sameTierAsMainStart(enabledIds: readonly string[], mainStartId: string, selector: BuddySelectorLike | undefined, allowPermanent: boolean): readonly string[];
/** 供调用方判断「该会话是不是子代理」（转发，避免各处重复 import）。 */
export { isSubagentSession };
/** 导出档位枚举，供调用方判「该号是否还有可用积分」。 */
export { BUDDY_BALANCE_TIER, buddyBalanceTier };
export type { RotationStartTier };
//# sourceMappingURL=subagent-start.d.ts.map