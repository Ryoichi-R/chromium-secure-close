import { buildRemovalPlan } from './cleaner.js';
import { STATUS, createRunRecord, sanitizeError } from './run-state.js';

export const WINDOW_CLOSE_TIMEOUT_MS = 5_000;

function defaultClock() {
    return {
        now: () => Date.now(),
        uuid: () =>
            globalThis.crypto?.randomUUID?.() ||
            `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
}

function toIso(clock) {
    return new Date(clock.now()).toISOString();
}

function normalizeWindowSnapshot(windows, initiatorWindowId = null) {
    if (!Array.isArray(windows))
        throw new TypeError('windows.getAll must return an array');
    let excludedIncognitoWindowCount = 0;
    let initiatorExcluded = false;
    const ids = windows
        .filter((win) => {
            if (
                win?.incognito === true &&
                (win.type === 'normal' || win.type === 'popup') &&
                Number.isInteger(win.id)
            ) {
                excludedIncognitoWindowCount += 1;
                if (win.id === initiatorWindowId) initiatorExcluded = true;
                return false;
            }
            return (
                win &&
                (win.type === 'normal' || win.type === 'popup') &&
                Number.isInteger(win.id)
            );
        })
        .map((win) => win.id)
        .sort((left, right) => left - right);
    return { ids, excludedIncognitoWindowCount, initiatorExcluded };
}

async function enumerateWindows(api, initiatorWindowId = null) {
    const result = await api.windows.getAll({
        windowTypes: ['normal', 'popup'],
    });
    return normalizeWindowSnapshot(result, initiatorWindowId);
}

function uniqueSorted(values) {
    return [...new Set(values)].sort((left, right) => left - right);
}

function difference(left, right) {
    const rightSet = new Set(right);
    return left.filter((id) => !rightSet.has(id));
}

function intersection(left, right) {
    const rightSet = new Set(right);
    return left.filter((id) => rightSet.has(id));
}

function appendReason(record, reason) {
    record.partialReasons = [...(record.partialReasons || []), reason];
}

function appendId(record, field, id) {
    record[field] = uniqueSorted([...(record[field] || []), id]);
}

function appendTypes(record, field, types) {
    record[field] = [...new Set([...(record[field] || []), ...types])];
}

function nowMs(clock) {
    const value = clock.now();
    return Number.isFinite(value) ? value : Date.now();
}

/**
 * Resolves when the operation settles, rejects, or the timeout expires. The
 * underlying promise always gets a rejection handler, including after timeout.
 */
export function withTimeout(operation, timeoutMs, clock = defaultClock()) {
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clock.clearTimeout(timer);
            resolve(result);
        };
        timer = clock.setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
        let promise;
        try {
            promise = typeof operation === 'function' ? operation() : operation;
        } catch (error) {
            finish({ kind: 'rejected', error });
            return;
        }
        Promise.resolve(promise).then(
            (value) => finish({ kind: 'resolved', value }),
            (error) => finish({ kind: 'rejected', error }),
        );
    });
}

function staleResult(result) {
    return {
        ok: false,
        code: result.code || 'STALE_OPERATION',
        lastRun: result.lastRun || null,
    };
}

function createRecordArgs(
    plan,
    operationId,
    startedAt,
    closeRequested,
    preDeleteWindowIds = [],
    preDeleteExcludedIncognitoWindowCount = 0,
) {
    return {
        operationId,
        now: startedAt,
        requestedTypes: plan.requestedTypes,
        since: plan.since,
        closeRequested,
        preDeleteWindowIds,
        preDeleteExcludedIncognitoWindowCount,
        preservedOriginCount: plan.preservedOriginCount,
    };
}

export async function runSecureClose(api, request, clock = defaultClock()) {
    if (!api?.browsingData?.remove || !api?.windows || !api?.journal) {
        return { ok: false, code: 'INVALID_RUNTIME' };
    }
    if (
        !request ||
        !['delete_only', 'delete_and_close'].includes(request.mode)
    ) {
        return { ok: false, code: 'INVALID_REQUEST' };
    }
    if (request.mode === 'delete_only' && request.initiatorWindowId !== null) {
        return { ok: false, code: 'INVALID_REQUEST' };
    }
    if (
        request.mode === 'delete_and_close' &&
        (!Number.isInteger(request.initiatorWindowId) ||
            request.initiatorWindowId < 0)
    ) {
        return { ok: false, code: 'INVALID_REQUEST' };
    }

    const operationId = clock.uuid();
    const startedAtMs = nowMs(clock);
    const startedAt = toIso(clock);
    const closeRequested = request.mode === 'delete_and_close';
    const plan = buildRemovalPlan(request.settings, startedAtMs);
    const types = plan.requestedTypes;

    if (types.length === 0) {
        const emptyRecord = {
            ...createRunRecord(
                createRecordArgs(plan, operationId, startedAt, closeRequested),
            ),
            status: STATUS.NO_SELECTION,
            durationMs: 0,
        };
        const begun = await api.journal.beginRun(emptyRecord);
        return begun.ok
            ? { ok: true, status: STATUS.NO_SELECTION, record: begun.record }
            : begun;
    }

    let preDeleteWindowIds = [];
    let preDeleteExcludedIncognitoWindowCount = 0;
    if (closeRequested) {
        try {
            const preSnapshot = await enumerateWindows(
                api,
                request.initiatorWindowId,
            );
            preDeleteWindowIds = preSnapshot.ids;
            preDeleteExcludedIncognitoWindowCount =
                preSnapshot.excludedIncognitoWindowCount;
            if (preSnapshot.initiatorExcluded) {
                const failedRecord = {
                    ...createRunRecord(
                        createRecordArgs(
                            plan,
                            operationId,
                            startedAt,
                            closeRequested,
                            preDeleteWindowIds,
                            preDeleteExcludedIncognitoWindowCount,
                        ),
                    ),
                    status: STATUS.ERROR,
                    durationMs: Math.max(0, nowMs(clock) - startedAtMs),
                    errorCode: 'INCOGNITO_INITIATOR_UNSUPPORTED',
                    errorMessage:
                        'シークレットウィンドウからは削除して閉じるを実行できません。削除のみを選択してください。',
                };
                const begun = await api.journal.beginRun(failedRecord);
                return begun.ok
                    ? {
                          ok: false,
                          code: 'INCOGNITO_INITIATOR_UNSUPPORTED',
                          record: begun.record,
                      }
                    : begun;
            }
        } catch (error) {
            const failedRecord = {
                ...createRunRecord(
                    createRecordArgs(
                        plan,
                        operationId,
                        startedAt,
                        closeRequested,
                    ),
                ),
                status: STATUS.ERROR,
                durationMs: Math.max(0, nowMs(clock) - startedAtMs),
                ...sanitizeError(error, 'WINDOW_ENUMERATION_FAILED'),
            };
            const begun = await api.journal.beginRun(failedRecord);
            return begun.ok
                ? {
                      ok: false,
                      code: 'WINDOW_ENUMERATION_FAILED',
                      record: begun.record,
                  }
                : begun;
        }
        if (!preDeleteWindowIds.includes(request.initiatorWindowId)) {
            const failedRecord = {
                ...createRunRecord(
                    createRecordArgs(
                        plan,
                        operationId,
                        startedAt,
                        closeRequested,
                        preDeleteWindowIds,
                        preDeleteExcludedIncognitoWindowCount,
                    ),
                ),
                status: STATUS.ERROR,
                durationMs: Math.max(0, nowMs(clock) - startedAtMs),
                errorCode: 'INITIATOR_WINDOW_NOT_FOUND',
                errorMessage:
                    '開始元ウィンドウを確認できないため、削除を開始しませんでした。',
            };
            const begun = await api.journal.beginRun(failedRecord);
            return begun.ok
                ? {
                      ok: false,
                      code: 'INITIATOR_WINDOW_NOT_FOUND',
                      record: begun.record,
                  }
                : begun;
        }
    }

    const initialRecord = createRunRecord(
        createRecordArgs(
            plan,
            operationId,
            startedAt,
            closeRequested,
            preDeleteWindowIds,
            preDeleteExcludedIncognitoWindowCount,
        ),
    );
    const begun = await api.journal.beginRun(initialRecord);
    if (!begun.ok) return begun;

    const update = async (mutate) =>
        api.journal.updateRunIfCurrent(operationId, mutate);

    for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        try {
            await Promise.resolve(
                api.browsingData.remove(step.options, step.dataTypes),
            );
        } catch (error) {
            const completedBeforeFailure = plan.steps
                .slice(0, index)
                .flatMap((candidate) => Object.keys(candidate.dataTypes));
            const notAttempted = plan.steps
                .slice(index + 1)
                .flatMap((candidate) => Object.keys(candidate.dataTypes));
            const isPartial = completedBeforeFailure.length > 0;
            const safeError = sanitizeError(
                error,
                'BROWSING_DATA_REMOVE_FAILED',
            );
            const result = await update((record) => {
                appendTypes(record, 'failedTypes', Object.keys(step.dataTypes));
                appendTypes(record, 'notAttemptedTypes', notAttempted);
                Object.assign(record, safeError);
                record.errorCode = isPartial
                    ? 'BROWSING_DATA_REMOVE_PARTIAL'
                    : 'BROWSING_DATA_REMOVE_FAILED';
                record.status = isPartial ? STATUS.PARTIAL : STATUS.ERROR;
                if (isPartial) appendReason(record, 'browsing_data_partial');
                record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
                return record;
            });
            const code = isPartial
                ? 'BROWSING_DATA_REMOVE_PARTIAL'
                : 'BROWSING_DATA_REMOVE_FAILED';
            return result.ok
                ? { ok: false, code, record: result.record }
                : staleResult(result);
        }

        const completed = await update((record) => {
            appendTypes(record, 'completedTypes', Object.keys(step.dataTypes));
            return record;
        });
        if (!completed.ok) return staleResult(completed);
    }

    let result = await update((record) => {
        record.status = STATUS.DELETE_COMPLETED;
        record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
        return record;
    });
    if (!result.ok) return staleResult(result);

    if (!closeRequested) {
        result = await update((record) => {
            record.status = STATUS.OK;
            record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
            return record;
        });
        return result.ok
            ? { ok: true, status: STATUS.OK, record: result.record }
            : staleResult(result);
    }

    let postDeleteWindowIds;
    let postDeleteExcludedIncognitoWindowCount = 0;
    try {
        const postSnapshot = await enumerateWindows(api);
        postDeleteWindowIds = postSnapshot.ids;
        postDeleteExcludedIncognitoWindowCount =
            postSnapshot.excludedIncognitoWindowCount;
    } catch (error) {
        result = await update((record) => {
            record.status = STATUS.PARTIAL;
            appendReason(record, 'enumerate_failed');
            Object.assign(
                record,
                sanitizeError(error, 'WINDOW_ENUMERATION_FAILED'),
            );
            record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
            record.remainingWindows = null;
            return record;
        });
        return result.ok
            ? {
                  ok: false,
                  code: 'WINDOW_ENUMERATION_FAILED',
                  record: result.record,
              }
            : staleResult(result);
    }

    const targetWindowIds = intersection(
        preDeleteWindowIds,
        postDeleteWindowIds,
    );
    const skippedWindowIds = difference(
        postDeleteWindowIds,
        preDeleteWindowIds,
    );
    const disappearedWindowIds = difference(
        preDeleteWindowIds,
        postDeleteWindowIds,
    );
    result = await update((record) => {
        record.postDeleteWindowIds = [...postDeleteWindowIds];
        record.postDeleteExcludedIncognitoWindowCount =
            postDeleteExcludedIncognitoWindowCount;
        record.targetWindowIds = [...targetWindowIds];
        record.skippedWindowIds = [...skippedWindowIds];
        record.disappearedWindowIds = [...disappearedWindowIds];
        if (targetWindowIds.length === 0) {
            record.status = STATUS.PARTIAL;
            appendReason(record, 'no_stable_target');
        }
        record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
        return record;
    });
    if (!result.ok) return staleResult(result);
    if (targetWindowIds.length === 0)
        return { ok: false, code: 'NO_STABLE_TARGET', record: result.record };

    const finalWindowId = targetWindowIds.includes(request.initiatorWindowId)
        ? request.initiatorWindowId
        : targetWindowIds[0];
    const initiatorMissing = finalWindowId !== request.initiatorWindowId;

    result = await update((record) => {
        record.status = STATUS.CLOSING_REQUESTED;
        record.finalWindowId = finalWindowId;
        record.targetWindowIds = [...targetWindowIds];
        if (initiatorMissing) appendReason(record, 'initiator_window_missing');
        return record;
    });
    if (!result.ok) return staleResult(result);

    const intermediateIds = targetWindowIds.filter(
        (id) => id !== finalWindowId,
    );
    for (const windowId of intermediateIds) {
        const closeResult = await withTimeout(
            () => api.windows.remove(windowId),
            WINDOW_CLOSE_TIMEOUT_MS,
            clock,
        );
        result = await update((record) => {
            if (closeResult.kind === 'resolved')
                appendId(record, 'closedWindowIds', windowId);
            else {
                appendId(record, 'failedWindowIds', windowId);
                appendReason(record, 'window_close_failed');
            }
            record.status = STATUS.CLOSING_REQUESTED;
            return record;
        });
        if (!result.ok) return staleResult(result);
    }

    result = await update((record) => {
        record.status = STATUS.CLOSING_FINAL_EXPECTED;
        record.finalWindowId = finalWindowId;
        record.finalWindowCloseArmed = true;
        record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
        return record;
    });
    if (!result.ok) return staleResult(result);

    const finalCloseResult = await withTimeout(
        () => api.windows.remove(finalWindowId),
        WINDOW_CLOSE_TIMEOUT_MS,
        clock,
    );
    result = await update((record) => {
        if (finalCloseResult.kind === 'resolved')
            appendId(record, 'closedWindowIds', finalWindowId);
        else {
            appendId(record, 'failedWindowIds', finalWindowId);
            appendReason(record, 'window_close_failed');
        }
        return record;
    });
    if (!result.ok) return staleResult(result);

    let verificationIds;
    try {
        const verificationSnapshot = await enumerateWindows(api);
        verificationIds = verificationSnapshot.ids;
    } catch (error) {
        result = await update((record) => {
            record.status = STATUS.PARTIAL;
            appendReason(record, 'verification_failed');
            Object.assign(
                record,
                sanitizeError(error, 'WINDOW_VERIFICATION_FAILED'),
            );
            record.remainingWindows = null;
            record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
            return record;
        });
        return result.ok
            ? {
                  ok: false,
                  code: 'WINDOW_VERIFICATION_FAILED',
                  record: result.record,
              }
            : staleResult(result);
    }

    const remainingTargetIds = intersection(targetWindowIds, verificationIds);
    result = await update((record) => {
        record.remainingWindows = remainingTargetIds.length;
        if (remainingTargetIds.length > 0)
            appendReason(record, 'verification_failed');
        record.status =
            (record.partialReasons || []).length > 0
                ? STATUS.PARTIAL
                : STATUS.OK;
        record.durationMs = Math.max(0, nowMs(clock) - startedAtMs);
        return record;
    });
    return result.ok
        ? {
              ok: result.record.status === STATUS.OK,
              status: result.record.status,
              record: result.record,
          }
        : staleResult(result);
}
