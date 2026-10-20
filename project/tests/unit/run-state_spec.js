import { describe, expect, it } from 'vitest';
import {
    STATUS,
    createJournalStore,
    createRunRecord,
    isBlockingStatus,
    normalizePartialReasons,
} from '../../extension/lib/run-state.js';
import { createStorageArea } from '../support/fake-chrome.js';

function store(initial = {}) {
    let tick = 0;
    return createJournalStore(createStorageArea(initial), {
        now: () => `2026-08-01T00:00:0${tick++}.000Z`,
    });
}

describe('run-state journal', () => {
    it('serializes writes and discards stale operations', async () => {
        const journal = store();
        const first = createRunRecord({
            operationId: 'first',
            now: '2026-08-01T00:00:00.000Z',
        });
        const second = createRunRecord({
            operationId: 'second',
            now: '2026-08-01T00:00:00.000Z',
        });
        first.status = STATUS.OK;
        expect((await journal.beginRun(first)).ok).toBe(true);
        expect((await journal.beginRun(second)).record.operationId).toBe(
            'second',
        );
        const stale = await journal.updateRunIfCurrent('first', (record) => {
            record.status = STATUS.OK;
            return record;
        });
        expect(stale).toMatchObject({ ok: false, code: 'STALE_OPERATION' });
        expect((await journal.readLastRun()).operationId).toBe('second');
    });

    it('blocks recovery states and acknowledges them explicitly', async () => {
        const journal = store();
        const record = createRunRecord({
            operationId: 'recover',
            now: '2026-08-01T00:00:00.000Z',
        });
        expect((await journal.beginRun(record)).ok).toBe(true);
        expect(isBlockingStatus((await journal.readLastRun()).status)).toBe(
            true,
        );
        expect(
            (
                await journal.beginRun(
                    createRunRecord({ operationId: 'blocked', now: 'now' }),
                )
            ).code,
        ).toBe('RECOVERY_REQUIRED');
        const acknowledged = await journal.acknowledgeRecovery('recover');
        expect(acknowledged.record.status).toBe(STATUS.INTERRUPTED_UNKNOWN);
    });

    it('normalizes reasons and rejects invalid terminal transitions', async () => {
        expect(
            normalizePartialReasons([
                'browsing_data_partial',
                'verification_failed',
                'verification_failed',
                'unknown',
                'enumerate_failed',
            ]),
        ).toEqual([
            'browsing_data_partial',
            'enumerate_failed',
            'verification_failed',
        ]);
        const journal = store();
        await journal.beginRun(
            createRunRecord({ operationId: 'terminal', now: 'now' }),
        );
        await expect(
            journal.updateRunIfCurrent('terminal', (record) => {
                record.status = STATUS.OK;
                return record;
            }),
        ).rejects.toThrow(/Invalid journal transition/);
    });

    it('stores partial deletion fields and preserved origin count on a run record', () => {
        const record = createRunRecord({
            operationId: 'partial',
            now: '2026-08-01T00:00:00.000Z',
            preservedOriginCount: 3,
        });
        expect(record).toMatchObject({
            completedTypes: [],
            failedTypes: [],
            notAttemptedTypes: [],
            preservedOriginCount: 3,
        });
        const invalidIncognitoCount = createRunRecord({
            operationId: 'invalid-incognito-count',
            now: '2026-08-01T00:00:00.000Z',
            preDeleteExcludedIncognitoWindowCount: -1,
        });
        expect(
            invalidIncognitoCount.preDeleteExcludedIncognitoWindowCount,
        ).toBe(0);
    });

    it.each([
        STATUS.NO_SELECTION,
        STATUS.OK,
        STATUS.PARTIAL,
        STATUS.ERROR,
        STATUS.INTERRUPTED_UNKNOWN,
    ])('rejects same-status updates after finalization: %s', async (status) => {
        const journal = store();
        const record = createRunRecord({
            operationId: `final-${status}`,
            now: '2026-08-01T00:00:00.000Z',
        });
        record.status = status;
        expect((await journal.beginRun(record)).ok).toBe(true);
        await expect(
            journal.updateRunIfCurrent(record.operationId, (current) => {
                current.errorMessage = 'must not be persisted';
                return current;
            }),
        ).rejects.toThrow(/Invalid journal transition/);
        expect((await journal.readLastRun()).errorMessage).toBeNull();
    });

    it('discards an old final-window callback after a new run replaces the journal', async () => {
        const journal = store();
        const oldRun = createRunRecord({
            operationId: 'old-final',
            now: '2026-08-01T00:00:00.000Z',
        });
        oldRun.status = STATUS.CLOSING_FINAL_EXPECTED;
        oldRun.finalWindowCloseArmed = true;
        expect((await journal.beginRun(oldRun)).ok).toBe(true);
        const newRun = createRunRecord({
            operationId: 'new-run',
            now: '2026-08-01T00:00:01.000Z',
        });
        expect((await journal.beginRun(newRun)).ok).toBe(true);
        const stale = await journal.updateRunIfCurrent(
            'old-final',
            (record) => {
                record.status = STATUS.PARTIAL;
                return record;
            },
        );
        expect(stale).toMatchObject({ ok: false, code: 'STALE_OPERATION' });
        expect((await journal.readLastRun()).operationId).toBe('new-run');
    });
});
