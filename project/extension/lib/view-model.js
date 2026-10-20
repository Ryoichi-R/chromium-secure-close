import {
    isBlockingStatus,
    normalizePartialReasons,
    STATUS,
} from './run-state.js';

const STATUS_LABELS = Object.freeze({
    [STATUS.NO_SELECTION]: '対象未選択',
    [STATUS.DELETING]: '削除処理中断の可能性',
    [STATUS.DELETE_COMPLETED]: '削除完了・終了未確認',
    [STATUS.CLOSING_REQUESTED]: 'ウィンドウ終了処理中断の可能性',
    [STATUS.CLOSING_FINAL_EXPECTED]:
        '最終ウィンドウの終了処理へ移行（完了確認不可）',
    [STATUS.OK]: '完了',
    [STATUS.PARTIAL]: '一部完了・要確認',
    [STATUS.ERROR]: 'エラー',
    [STATUS.INTERRUPTED_UNKNOWN]: '中断・結果不明',
});

const REASON_LABELS = Object.freeze({
    browsing_data_partial:
        '閲覧データの一部だけが削除されました。未実行または失敗した項目を確認してください。',
    enumerate_failed: 'ウィンドウ列挙に失敗しました。',
    initiator_window_missing:
        '開始元ウィンドウが消えたため、残りから終了対象を選びました。',
    no_stable_target: '削除前後で共通する安定した終了対象がありませんでした。',
    window_close_failed:
        '一部のウィンドウ終了要求が失敗またはタイムアウトしました。',
    verification_failed: '終了後の確認ができないか、対象が残っています。',
    recovery_terminalized: '中断状態を確認済みとして確定しました。',
});

function safeCount(value) {
    return Array.isArray(value) ? value.length : 0;
}

function safeMessage(value) {
    return typeof value === 'string' ? value.slice(0, 240) : '';
}

function formatRunTimestamp(value) {
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function reasonMessages(reasons) {
    return normalizePartialReasons(reasons).map((reason) => ({
        code: reason,
        text: REASON_LABELS[reason] || '処理の一部を確認してください。',
    }));
}

export function toRunViewModel(lastRun) {
    if (!lastRun) {
        return {
            status: null,
            label: '前回の実行結果はありません。',
            summary: '対象を選択して実行してください。',
            timestamp: null,
            tone: 'neutral',
            canRun: true,
            showRecovery: false,
            reasons: [],
            closedCount: 0,
            skippedCount: 0,
            failedCount: 0,
        };
    }
    const status = STATUS_LABELS[lastRun.status]
        ? lastRun.status
        : STATUS.ERROR;
    const reasons = reasonMessages(lastRun.partialReasons);
    const completedTypeCount = safeCount(lastRun.completedTypes);
    if (
        completedTypeCount > 0 &&
        (status === STATUS.DELETING || status === STATUS.INTERRUPTED_UNKNOWN)
    ) {
        reasons.push({
            code: 'partial_deletion_possible',
            text: '削除処理が中断される前に、一部の閲覧データが削除済みの可能性があります。',
        });
    }
    const closedCount = safeCount(lastRun.closedWindowIds);
    const skippedCount = safeCount(lastRun.skippedWindowIds);
    const failedCount = safeCount(lastRun.failedWindowIds);
    const timestamp = formatRunTimestamp(
        lastRun.startedAt || lastRun.updatedAt,
    );
    const blocking = isBlockingStatus(status);
    const warning =
        blocking ||
        status === STATUS.PARTIAL ||
        status === STATUS.ERROR ||
        status === STATUS.INTERRUPTED_UNKNOWN ||
        (status === STATUS.CLOSING_FINAL_EXPECTED && reasons.length > 0);
    const summaryParts = [
        timestamp
            ? `前回 ${timestamp} — ${STATUS_LABELS[status]}`
            : STATUS_LABELS[status],
    ];
    if (lastRun.requestedTypes?.length)
        summaryParts.push(`${lastRun.requestedTypes.length}項目の削除処理`);
    if (closedCount) summaryParts.push(`${closedCount}ウィンドウ終了要求`);
    if (skippedCount)
        summaryParts.push(
            `削除中に開かれたため閉じなかったウィンドウ ${skippedCount} 件`,
        );
    if (failedCount) summaryParts.push(`失敗 ${failedCount} 件`);
    return {
        status,
        label: STATUS_LABELS[status],
        summary: summaryParts.join(' / '),
        timestamp: timestamp || null,
        tone: warning ? 'warning' : 'success',
        canRun: !blocking,
        showRecovery: blocking,
        reasons,
        closedCount,
        skippedCount,
        failedCount,
        completedTypeCount,
        errorMessage: safeMessage(lastRun.errorMessage),
        operationId:
            typeof lastRun.operationId === 'string'
                ? lastRun.operationId
                : null,
    };
}

export { STATUS_LABELS, REASON_LABELS };
