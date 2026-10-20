export const STATUS = Object.freeze({
    NO_SELECTION: 'no_selection',
    DELETING: 'deleting',
    DELETE_COMPLETED: 'delete_completed',
    CLOSING_REQUESTED: 'closing_requested',
    CLOSING_FINAL_EXPECTED: 'closing_final_expected',
    OK: 'ok',
    PARTIAL: 'partial',
    ERROR: 'error',
    INTERRUPTED_UNKNOWN: 'interrupted_unknown',
});

export const BLOCKING_STATUSES = Object.freeze([
    STATUS.DELETING,
    STATUS.DELETE_COMPLETED,
    STATUS.CLOSING_REQUESTED,
]);

export const PROVISIONAL_STATUSES = Object.freeze([
    ...BLOCKING_STATUSES,
    STATUS.CLOSING_FINAL_EXPECTED,
]);

export const FINAL_STATUSES = Object.freeze([
    STATUS.NO_SELECTION,
    STATUS.OK,
    STATUS.PARTIAL,
    STATUS.ERROR,
    STATUS.INTERRUPTED_UNKNOWN,
]);

export const PARTIAL_REASONS = Object.freeze([
    'browsing_data_partial',
    'enumerate_failed',
    'initiator_window_missing',
    'no_stable_target',
    'window_close_failed',
    'verification_failed',
    'recovery_terminalized',
]);

const PARTIAL_REASON_SET = new Set(PARTIAL_REASONS);
const BLOCKING_SET = new Set(BLOCKING_STATUSES);

const ALLOWED_TRANSITIONS = Object.freeze({
    [STATUS.DELETING]: new Set([
        STATUS.DELETING,
        STATUS.DELETE_COMPLETED,
        STATUS.PARTIAL,
        STATUS.ERROR,
        STATUS.INTERRUPTED_UNKNOWN,
    ]),
    [STATUS.DELETE_COMPLETED]: new Set([
        STATUS.DELETE_COMPLETED,
        STATUS.CLOSING_REQUESTED,
        STATUS.OK,
        STATUS.PARTIAL,
        STATUS.ERROR,
    ]),
    [STATUS.CLOSING_REQUESTED]: new Set([
        STATUS.CLOSING_REQUESTED,
        STATUS.CLOSING_FINAL_EXPECTED,
        STATUS.PARTIAL,
        STATUS.ERROR,
    ]),
    [STATUS.CLOSING_FINAL_EXPECTED]: new Set([
        STATUS.CLOSING_FINAL_EXPECTED,
        STATUS.OK,
        STATUS.PARTIAL,
    ]),
    [STATUS.NO_SELECTION]: new Set(),
    [STATUS.OK]: new Set(),
    [STATUS.PARTIAL]: new Set(),
    [STATUS.ERROR]: new Set(),
    [STATUS.INTERRUPTED_UNKNOWN]: new Set(),
});

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function defaultNow() {
    return new Date().toISOString();
}

export function isBlockingStatus(status) {
    return BLOCKING_SET.has(status);
}

export function isProvisionalStatus(status) {
    return PROVISIONAL_STATUSES.includes(status);
}

export function isFinalStatus(status) {
    return FINAL_STATUSES.includes(status);
}

export function normalizePartialReasons(reasons) {
    const values = Array.isArray(reasons) ? reasons : [];
    return PARTIAL_REASONS.filter(
        (reason) => values.includes(reason) && PARTIAL_REASON_SET.has(reason),
    );
}

export function sanitizeError(error, fallbackCode = 'UNKNOWN_ERROR') {
    const code =
        typeof error?.errorCode === 'string' &&
        /^[A-Z0-9_]{1,64}$/.test(error.errorCode)
            ? error.errorCode
            : fallbackCode;
    const message =
        typeof error?.message === 'string'
            ? error.message.replace(/\s+/g, ' ').slice(0, 240)
            : '処理に失敗しました。';
    return { errorCode: code, errorMessage: message };
}

export function createRunRecord({
    operationId,
    now,
    requestedTypes = [],
    since = 0,
    closeRequested = false,
    preDeleteWindowIds = [],
    preDeleteExcludedIncognitoWindowCount = 0,
    preservedOriginCount = 0,
}) {
    return {
        operationId,
        revision: 0,
        startedAt: now,
        updatedAt: now,
        status: STATUS.DELETING,
        requestedTypes: [...requestedTypes],
        since,
        completedTypes: [],
        failedTypes: [],
        notAttemptedTypes: [],
        preservedOriginCount:
            Number.isInteger(preservedOriginCount) && preservedOriginCount >= 0
                ? preservedOriginCount
                : 0,
        closeRequested,
        preDeleteWindowIds: [...preDeleteWindowIds],
        preDeleteExcludedIncognitoWindowCount:
            Number.isInteger(preDeleteExcludedIncognitoWindowCount) &&
            preDeleteExcludedIncognitoWindowCount >= 0
                ? preDeleteExcludedIncognitoWindowCount
                : 0,
        postDeleteExcludedIncognitoWindowCount: 0,
        postDeleteWindowIds: [],
        targetWindowIds: [],
        skippedWindowIds: [],
        disappearedWindowIds: [],
        closedWindowIds: [],
        failedWindowIds: [],
        finalWindowId: null,
        finalWindowCloseArmed: false,
        remainingWindows: null,
        durationMs: null,
        partialReasons: [],
        errorCode: null,
        errorMessage: null,
    };
}

function assertTransition(from, to) {
    if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
        throw new Error(`Invalid journal transition: ${from} -> ${to}`);
    }
}

function enqueue(queueState, task) {
    const run = queueState.tail.then(task, task);
    queueState.tail = run.catch(() => undefined);
    return run;
}

export function createJournalStore(storageArea, { now = defaultNow } = {}) {
    if (
        !storageArea ||
        typeof storageArea.get !== 'function' ||
        typeof storageArea.set !== 'function'
    ) {
        throw new TypeError('storageArea.get and storageArea.set are required');
    }
    const queueState = { tail: Promise.resolve() };

    async function readLastRun() {
        const value = await storageArea.get('lastRun');
        return value?.lastRun ? clone(value.lastRun) : null;
    }

    async function writeLastRun(record) {
        await storageArea.set({ lastRun: clone(record) });
        return clone(record);
    }

    function beginRun(record) {
        return enqueue(queueState, async () => {
            const current = await readLastRun();
            if (current && isBlockingStatus(current.status)) {
                return {
                    ok: false,
                    code: 'RECOVERY_REQUIRED',
                    lastRun: current,
                };
            }
            const next = { ...clone(record), revision: 0, updatedAt: now() };
            return { ok: true, record: await writeLastRun(next) };
        });
    }

    function updateRunIfCurrent(operationId, mutate) {
        return enqueue(queueState, async () => {
            const current = await readLastRun();
            if (!current || current.operationId !== operationId) {
                return { ok: false, code: 'STALE_OPERATION', lastRun: current };
            }
            const draft = clone(current);
            const candidate = await mutate(draft);
            const next =
                candidate && typeof candidate === 'object' ? candidate : draft;
            if (next.operationId !== operationId) {
                return { ok: false, code: 'STALE_OPERATION', lastRun: current };
            }
            assertTransition(current.status, next.status);
            next.revision = current.revision + 1;
            next.updatedAt = now();
            next.partialReasons = normalizePartialReasons(next.partialReasons);
            return { ok: true, record: await writeLastRun(next) };
        });
    }

    function acknowledgeRecovery(operationId) {
        return enqueue(queueState, async () => {
            const current = await readLastRun();
            if (!current || current.operationId !== operationId) {
                return { ok: false, code: 'STALE_OPERATION', lastRun: current };
            }
            if (!isBlockingStatus(current.status)) {
                return { ok: false, code: 'NOT_RECOVERABLE', lastRun: current };
            }
            const next = clone(current);
            next.status =
                current.status === STATUS.DELETING
                    ? STATUS.INTERRUPTED_UNKNOWN
                    : STATUS.PARTIAL;
            next.partialReasons = normalizePartialReasons([
                ...(current.partialReasons || []),
                ...(next.status === STATUS.PARTIAL
                    ? ['recovery_terminalized']
                    : []),
            ]);
            next.revision = current.revision + 1;
            next.updatedAt = now();
            return { ok: true, record: await writeLastRun(next) };
        });
    }

    return Object.freeze({
        readLastRun,
        beginRun,
        updateRunIfCurrent,
        acknowledgeRecovery,
    });
}
