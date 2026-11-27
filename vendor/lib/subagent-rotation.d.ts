/**
 * ★★★ **子代理专属起点与模型的运行时状态**（2026-11-23）。
 *
 * # 它解决什么问题
 *
 * 现状：子代理与主代理**用同一个起点账号**。用户希望子代理错开消耗 ——
 * 主代理烧 A 的临期，子代理去烧 B/C/D 的临期，避免所有子代理挤在一个号上
 * 把它的积分耗尽、而其他号闲置到过期。
 *
 * 用户原话：
 * > 「可以指定当前会话拉起的子代理使用的帐号起点」
 *
 * # 宿主已提供的能力（均已实证，2026-11-23）
 *
 * | 能力 | 宿主 API | 我们用它做什么 |
 * |---|---|---|
 * | 知道「谁是子代理、父会话是谁」| `subagent/start` 的 `parentSessionId` + `id` | 建立 sessionId → 分配记录 |
 * | 知道「子代理什么时候结束」| `subagent/end` | 标记结束（**保留**分配，供 resume）|
 * | 换账号 | `resolveCredential(model, sessionId)` | 按 sessionId 查分配 → 算出起点 |
 * | 换模型 | `agent/pre-step` + `agent.model.select()` | 每次 step 前按 sessionId 改写 |
 *
 * # 关键设计：本模块**不碰宿主**
 *
 * 全部是纯函数 + 状态容器。事件订阅与接线在 `index.ts` /
 * `credential-resolver.ts`，这样本文件可被单测直接 import
 *（本仓教训：把判据写进能测的文件里，别埋在装配层）。
 *
 * @module
 */
import type { SubagentRotationSetting, SubagentStartMode } from './jet-hub-store.js';
/**
 * 一条子代理分配记录。
 *
 * ⚠️ **必须持久化**：插件重启后收不到已经发过的 `subagent/start`，
 * 若不落盘，正在跑的子代理会退化成「用主代理起点」——
 * 用户会看到「子代理突然开始烧主代理的号」。
 */
export interface SubagentAssignment {
    /** 子代理自己的会话 id（= `subagent/start` 的 `info.id`）。 */
    sessionId: string;
    /** 父会话 id（= 主代理）。用于查「主代理当时用的哪个起点」。 */
    parentSessionId: string;
    /** 分配时刻（淘汰按它排序）。 */
    at: number;
    /**
     * 本子代理在「错开序列」里的序号（0 = 第一个子代理）。
     *
     * ⚠️ 存序号而不是直接存 accountId：账号池会变（增删/停用/积分耗尽），
     * 每次请求都要**现算**起点，才能保证「起点失效时自动换下一个」这条
     * 沿用主代理规则。
     */
    slot: number;
    /** `subagent/end` 是否已到达（只用于诊断，**不参与**任何判据）。 */
    ended?: boolean;
}
/** 单 provider 的分配表：sessionId → 记录。 */
export type SubagentAssignmentMap = Record<string, SubagentAssignment>;
/**
 * 淘汰上限（单 provider）。
 *
 * 取 128：子代理通常短命，但可能连续拉起几十个。单条 ≈ 200 字节
 * ⇒ 单 provider 至多 ≈ 26 KB，可接受。
 *
 * ⚠️ 比 `PREFERRED_ROTATION_MAX_SESSIONS`（64）大一倍：子代理的产生频率
 * 远高于「用户手动选起点」。
 */
export declare const SUBAGENT_ASSIGNMENT_MAX = 128;
/**
 * 归一化分配表（读写两侧都跑，与 `sanitizePreferredRotation` 同纪律）。
 *
 * ⚠️ 脏数据**整条丢弃**：`sessionId` / `parentSessionId` 是后续所有判据的前提。
 */
export declare function sanitizeSubagentAssignments(raw: unknown): SubagentAssignmentMap;
/**
 * 按 {@link SUBAGENT_ASSIGNMENT_MAX} 淘汰最旧的（`at` 升序丢前面的）。
 *
 * ⚠️ 纯函数，返回新对象。
 * ⚠️ `limit <= 0` ⇒ 返回空表（确定性结果，不是「全留」）。
 */
export declare function pruneSubagentAssignments(assignments: SubagentAssignmentMap, limit?: number): SubagentAssignmentMap;
/**
 * 记录一个新分配（**幂等**）。
 *
 * ## 为什么幂等（真实场景）
 *
 * 同一个子代理可能被 resume ⇒ `subagent/start` 会**再次**发出。
 * 若每次都分配新 slot，一个子代理会「越跑越往后挪」，而它的历史分配被浪费。
 *
 * ⇒ 已存在就**保留原 slot**。
 */
export declare function recordSubagentAssignment(assignments: SubagentAssignmentMap, sessionId: string, parentSessionId: string, slot: number, now: number): SubagentAssignmentMap;
/**
 * 标记某个子代理已结束（**不清除记录**）。
 *
 * ## 为什么保留记录
 *
 * 1. 子代理可能被 **resume**（`send_message` 继续它的对话）—— 那时 sessionId 不变，
 *    应继续用**原来的** slot，而不是重新排到队尾；
 * 2. 立即删除会让「正在收尾的最后一轮请求」查不到分配 ⇒ 突然跳回主代理起点
 *    （用户会看到「子代理最后一枪烧了主代理的号」）。
 *
 * ⇒ 只置 `ended` 标记（诊断用），实际清理交给 `at` 淘汰。
 */
export declare function markSubagentEnded(assignments: SubagentAssignmentMap, sessionId: string): SubagentAssignmentMap;
export declare function nextSubagentSlot(assignments: SubagentAssignmentMap): number;
/**
 * ★★★ **在「同档位序列」里按策略算出起点账号 id**。
 *
 * # 这是本功能的核心判据（纯函数，可全量测）
 *
 * ## 输入
 *
 * @param tierIds - 主代理起点**所在档位**的账号 id 列表，**按策略序**
 * @param mainStartId - 主代理当前实际用的账号 id（= 该档位列表里的某个元素）
 * @param mode - 策略
 * @param slot - 本子代理的序号（0 起）
 * @param sessionId - 子代理会话 id（`hash` 模式用）
 * @returns 应作为子代理起点的账号 id；`undefined` = 无法决定（调用方回落主代理）
 *
 * ## 各策略的语义（用户 2026-11-23 确认）
 *
 * | 模式 | 语义 |
 * |---|---|
 * | `follow` | 返回 `mainStartId`（与主代理同号）|
 * | `sequence` | 主代理起点**往后**第 `slot+1` 个（绕回）|
 * | `reverse` | 主代理起点**往前**第 `slot+1` 个（绕回）|
 * | `hash` | 按 `sessionId` 稳定哈希到该档位内某个账号（排除主代理）|
 * | `fixed` | 返回 `undefined` —— 固定模式**不走档位序列**，由外层按位次取 |
 *
 * ## ⚠️⚠️ 为什么只在「同一档位内」错开
 *
 * 用户明确纠正过我第一版的错误理解：
 *
 * > 「子代理在分配帐号起点时，肯定也要像主代理一样，遵守档次优先的原则呀」
 *
 * 跨档位反转会让子代理**先烧短期**（临期还没烧完就去烧短期）——
 * 那就违背了「临期优先」这条核心策略。`rotateFromPreferred` 内部**始终**
 * 先按档位分组，所以只要起点落在同一档位内，第一枪必然是临期。
 *
 * ## ⚠️ 主代理起点可能不在 `tierIds` 里
 *
 * 调用方应从**候选集**构造 `tierIds`；若主代理起点不在其中（被限流/封禁滤掉），
 * 返回 `undefined` 让调用方回落 —— 而不是猜一个。
 */
export declare function startIndexOfSlot(tierIds: readonly string[], mainStartId: string, mode: SubagentStartMode, slot: number, sessionId: string): string | undefined;
/**
 * 稳定字符串哈希（32 位 FNV-1a 变体）。
 *
 * ⚠️ **不能用 `Math.random` 或时间**：同一子代理的每次请求必须落在同一账号上，
 * 否则「子代理 A 第一枪烧 B、第二枪烧 C」—— 用户在积分面板上看到它在乱跳。
 */
export declare function hashString(value: string): number;
/**
 * 从「全量启用账号」里按**位次**取账号 id（`fixed` 模式用）。
 *
 * @param enabledIds - 全量启用账号 id，**按池序**（1-based 位次即下标 +1）
 * @param position - 1-based 位次
 * @returns 该位次的账号 id；越界 / 非正整数 ⇒ `undefined`
 *
 * ⚠️ 越界时返回 `undefined`（调用方回落主代理起点），**不**静默取最后一个：
 * 用户的设置里写着「位次 5」，实际只剩 3 个号时悄悄用第 3 个，会让用户
 * 以为「固定」失效了（本仓记过多次同类静默降级）。
 */
export declare function accountIdAtPosition(enabledIds: readonly string[], position: number | undefined): string | undefined;
/**
 * 判断「该 provider 的子代理设置是否需要生效」。
 *
 * @param setting - 该 provider 的子代理设置
 * @returns 是否启用（`false` ⇒ 调用方走主代理逻辑，与加本功能之前逐字节相同）
 */
export declare function subagentSettingActive(setting: SubagentRotationSetting | undefined): boolean;
/** 记下「某子代理的父会话」（`subagent/start` 时调）。 */
export declare function rememberSubagentParent(childId: string, parentId: string): void;
/** 查「某 sessionId 是不是子代理」。 */
export declare function isSubagentSession(sessionId: string): boolean;
/** 查某子代理的父会话 id。 */
export declare function subagentParentOf(sessionId: string): string | undefined;
/** 子代理结束时**不必**从父子表清除（见 {@link isSubagentSession} 的说明），
 * 但清理能省内存；且若它被 resume，`subagent/start` 会再登记一次。 */
export declare function forgetSubagentParent(sessionId: string): void;
/** 清空父子表（**仅供单测**）。 */
export declare function resetSubagentParentsForTest(): void;
/** 当前父子表大小（诊断 / 单测用）。 */
export declare function subagentParentCount(): number;
//# sourceMappingURL=subagent-rotation.d.ts.map