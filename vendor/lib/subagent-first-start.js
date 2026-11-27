/** `tierRank` → `RotationStartTier`（与 `buddy-balance-rank.ts` 的枚举同值）。 */
export function rotationStartTierOfRank(rank) {
    if (rank === 0)
        return 'imminent';
    if (rank === 1)
        return 'expiring';
    if (rank === 2)
        return 'permanent';
    return undefined;
}
/**
 * 给定目标账号 id，读出它的档位快照。
 *
 * @returns 档位；`undefined` = 读不到（此时**不应**写 `preferredRotation`
 *          —— 没有档位的条目会被 `sanitizePreferredRotation` 丢弃）
 */
export async function probeRotationStartTier(probe, accountId) {
    if (probe === undefined || typeof probe.cachedTierOf !== 'function')
        return undefined;
    const asAccount = { id: accountId };
    /** ① 先读缓存（绝大多数情况命中）。 */
    const cached = probe.cachedTierOf(asAccount, true);
    if (cached !== undefined)
        return rotationStartTierOfRank(cached);
    /** ② 冷启动：查一次（`balanceOf` 内部会缓存结果，后续请求零成本）。 */
    if (typeof probe.balanceOf === 'function') {
        try {
            await probe.balanceOf(asAccount);
        }
        catch {
            return undefined;
        }
        const after = probe.cachedTierOf(asAccount, true);
        if (after !== undefined)
            return rotationStartTierOfRank(after);
    }
    return undefined;
}
/**
 * 把「账号 id」换算成「启用账号池序里的位次」（1-based）。
 *
 * ⚠️ 必须与 `AccountPool.preferredRotationFor` 的换算**同口径** ——
 * 那里是 `readAccounts().filter(enabled)[position - 1]`，
 * 故这里必须用**同一份顺序**（`listAccountsByProvider` 已按池序返回，
 * 只需再 `filter(enabled)`）。
 *
 * @returns 位次；找不到 ⇒ `undefined`（调用方不写，避免写进「永远不生效」的位次）
 */
export function positionOfAccount(enabledIds, accountId) {
    const idx = enabledIds.indexOf(accountId);
    return idx < 0 ? undefined : idx + 1;
}
/**
 * 判断「本次是否该为子代理算起点」。
 *
 * ## 三条同时成立
 *
 * | # | 条件 | 为什么 |
 * |---|---|---|
 * | ① | 有 `sessionId` 且**已登记为子代理**（分配表里有记录）| 主代理不参与 |
 * | ② | 配了 `subagent.startMode` | 没配 ⇒ 完全走主代理行为 |
 * | ③ | **`preferredRotation` 里还没有该 sessionId 的条目** | 只在**首次**算一次 |
 *
 * ⚠️ ③ 是关键：主代理的起点是「用户选一次」；子代理照抄 ⇒
 *    只在首次写，之后 pin 固定（缓存命中率）。
 */
export function shouldDecideSubagentStartOnFirstUse(options) {
    if (options.sessionId === undefined || options.sessionId.length === 0)
        return false;
    if (!options.hasAssignment)
        return false;
    if (options.setting?.startMode === undefined)
        return false;
    /** ⚠️ 已有条目 ⇒ 用户/上一次已定过起点 ⇒ **不再算**。 */
    if (options.hasPreferredRotation)
        return false;
    return true;
}
/** 合法 `startMode` 列表（与 `jet-hub-store.ts` 的 `SUBAGENT_START_MODES` 一致）。 */
export const DECIDE_START_MODES = ['follow', 'sequence', 'reverse', 'hash', 'fixed'];
//# sourceMappingURL=subagent-first-start.js.map