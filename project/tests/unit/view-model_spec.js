import { describe, expect, it } from 'vitest';
import { STATUS } from '../../extension/lib/run-state.js';
import { toRunViewModel } from '../../extension/lib/view-model.js';

const base = {
    operationId: 'x',
    requestedTypes: ['history'],
    closedWindowIds: [2],
    skippedWindowIds: [4],
    failedWindowIds: [],
};

describe('view-model', () => {
    it('maps no run to an executable neutral view', () => {
        expect(toRunViewModel(null)).toMatchObject({
            canRun: true,
            showRecovery: false,
            tone: 'neutral',
        });
    });

    it.each([
        STATUS.DELETING,
        STATUS.DELETE_COMPLETED,
        STATUS.CLOSING_REQUESTED,
    ])('requires recovery for %s', (status) => {
        expect(toRunViewModel({ ...base, status })).toMatchObject({
            canRun: false,
            showRecovery: true,
            tone: 'warning',
        });
    });

    it('keeps closing_final_expected runnable and shows skipped count', () => {
        const model = toRunViewModel({
            ...base,
            status: STATUS.CLOSING_FINAL_EXPECTED,
            partialReasons: [],
        });
        expect(model).toMatchObject({
            canRun: true,
            showRecovery: false,
            tone: 'success',
            skippedCount: 1,
        });
    });

    it('shows every partial reason without overwriting earlier reasons', () => {
        const model = toRunViewModel({
            ...base,
            status: STATUS.PARTIAL,
            partialReasons: ['enumerate_failed', 'verification_failed'],
        });
        expect(model.reasons.map((reason) => reason.code)).toEqual([
            'enumerate_failed',
            'verification_failed',
        ]);
    });

    it('renders a non-empty label for a browsing data partial failure', () => {
        const model = toRunViewModel({
            ...base,
            status: STATUS.PARTIAL,
            partialReasons: ['browsing_data_partial'],
        });
        expect(model.reasons).toEqual([
            {
                code: 'browsing_data_partial',
                text: '閲覧データの一部だけが削除されました。未実行または失敗した項目を確認してください。',
            },
        ]);
    });

    it('warns when an interrupted deletion may already have removed some data', () => {
        const deleting = toRunViewModel({
            ...base,
            status: STATUS.DELETING,
            completedTypes: ['cookies'],
            partialReasons: [],
        });
        expect(deleting.reasons).toContainEqual({
            code: 'partial_deletion_possible',
            text: '削除処理が中断される前に、一部の閲覧データが削除済みの可能性があります。',
        });
        expect(deleting.completedTypeCount).toBe(1);

        const interrupted = toRunViewModel({
            ...base,
            status: STATUS.INTERRUPTED_UNKNOWN,
            completedTypes: ['cookies'],
            partialReasons: [],
        });
        expect(interrupted.reasons.map((reason) => reason.code)).toContain(
            'partial_deletion_possible',
        );
    });

    it('renders every supported partial reason in canonical order', () => {
        const reasons = [
            'recovery_terminalized',
            'window_close_failed',
            'no_stable_target',
            'initiator_window_missing',
            'verification_failed',
            'enumerate_failed',
        ];
        const model = toRunViewModel({
            ...base,
            status: STATUS.PARTIAL,
            partialReasons: reasons,
        });
        expect(model.reasons.map((reason) => reason.code)).toEqual([
            'enumerate_failed',
            'initiator_window_missing',
            'no_stable_target',
            'window_close_failed',
            'verification_failed',
            'recovery_terminalized',
        ]);
        expect(model.tone).toBe('warning');
        expect(model.canRun).toBe(true);
    });

    it('includes the previous run timestamp in the summary', () => {
        const model = toRunViewModel({
            ...base,
            status: STATUS.OK,
            startedAt: '2026-07-31T12:03:04.000Z',
            partialReasons: [],
        });
        expect(model.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        expect(model.summary).toContain('前回 ');
        expect(model.summary).toContain(' — 完了');
    });
});
