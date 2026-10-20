import { describe, expect, it } from 'vitest';
import { createJournalStore, STATUS } from '../../extension/lib/run-state.js';
import {
    runSecureClose,
    withTimeout,
} from '../../extension/lib/secure-close.js';
import { DATA_TYPE_KEYS } from '../../extension/lib/settings.js';
import { createFakeChrome } from '../support/fake-chrome.js';

function makeClock() {
    let current = 1_000;
    let nextId = 0;
    const timers = new Map();
    return {
        now: () => current,
        uuid: () => 'operation-1',
        setTimeout(callback, ms) {
            const id = ++nextId;
            timers.set(id, { at: current + ms, callback });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            current += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= current) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
    };
}

function makeApi(fake, clock) {
    return {
        browsingData: fake.chromeApi.browsingData,
        windows: fake.chromeApi.windows,
        journal: createJournalStore(fake.storage, {
            now: () => new Date(clock.now()).toISOString(),
        }),
    };
}

function selectedTypes(...selected) {
    return Object.fromEntries(
        DATA_TYPE_KEYS.map((key) => [key, selected.includes(key)]),
    );
}

describe('secure close flow', () => {
    it('rejects invalid runtime and request shapes', async () => {
        expect(await runSecureClose({}, { mode: 'delete_only' })).toMatchObject(
            { ok: false, code: 'INVALID_RUNTIME' },
        );
        const fake = createFakeChrome();
        const api = makeApi(fake, makeClock());
        expect(
            await runSecureClose(api, { mode: 'invalid', settings: {} }),
        ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    });

    it('reports resolved, rejected, and synchronous timeout operations', async () => {
        const clock = makeClock();
        await expect(
            withTimeout(Promise.resolve('done'), 10, clock),
        ).resolves.toMatchObject({ kind: 'resolved', value: 'done' });
        await expect(
            withTimeout(Promise.reject(new Error('no')), 10, clock),
        ).resolves.toMatchObject({ kind: 'rejected' });
        await expect(
            withTimeout(
                () => {
                    throw new Error('sync');
                },
                10,
                clock,
            ),
        ).resolves.toMatchObject({ kind: 'rejected' });
    });

    it('executes filterable and global removal steps in order and records the preserved count', async () => {
        const calls = [];
        const fake = createFakeChrome({
            removeBrowsingData: async (options, dataTypes) =>
                calls.push({ options, dataTypes }),
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_only',
                settings: {
                    dataTypes: selectedTypes('cookies', 'history'),
                    preservedOrigins: ['https://github.com'],
                },
                initiatorWindowId: null,
            },
            makeClock(),
        );
        expect(result).toMatchObject({ ok: true, status: STATUS.OK });
        expect(calls).toHaveLength(2);
        expect(calls[0].dataTypes).toEqual({ cookies: true });
        expect(calls[0].options.excludeOrigins).toEqual(['https://github.com']);
        expect(calls[1].dataTypes).toEqual({ history: true });
        expect(calls[1].options).not.toHaveProperty('excludeOrigins');
        expect(result.record.completedTypes).toEqual(['cookies', 'history']);
        expect(result.record.preservedOriginCount).toBe(1);
    });

    it('records a partial browsing-data failure and never closes windows', async () => {
        const fake = createFakeChrome({
            windows: [{ id: 1, type: 'normal' }],
            removeBrowsingData: async (_options, dataTypes) => {
                if (dataTypes.history) throw new Error('global delete failed');
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_and_close',
                settings: {
                    dataTypes: selectedTypes('cookies', 'history'),
                    preservedOrigins: ['https://github.com'],
                },
                initiatorWindowId: 1,
            },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'BROWSING_DATA_REMOVE_PARTIAL',
            record: { status: STATUS.PARTIAL },
        });
        expect(result.record.completedTypes).toEqual(['cookies']);
        expect(result.record.failedTypes).toEqual(['history']);
        expect(result.record.notAttemptedTypes).toEqual([]);
        expect(result.record.partialReasons).toContain('browsing_data_partial');
        expect(fake.removed).toEqual([]);
    });

    it('records unattempted global types when the first filterable step fails', async () => {
        const fake = createFakeChrome({
            removeBrowsingData: async () => {
                throw new Error('filterable delete failed');
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_only',
                settings: {
                    dataTypes: selectedTypes('cookies', 'history'),
                    preservedOrigins: ['https://github.com'],
                },
                initiatorWindowId: null,
            },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'BROWSING_DATA_REMOVE_FAILED',
            record: { status: STATUS.ERROR },
        });
        expect(result.record.failedTypes).toEqual(['cookies']);
        expect(result.record.notAttemptedTypes).toEqual(['history']);
    });

    it('records pre-delete enumeration failures without deleting data', async () => {
        const fake = createFakeChrome();
        fake.chromeApi.windows.getAll = async () => {
            throw new Error('enumeration');
        };
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            { mode: 'delete_and_close', settings: {}, initiatorWindowId: 1 },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'WINDOW_ENUMERATION_FAILED',
            record: { status: STATUS.ERROR },
        });
    });

    it('rejects an initiator that is absent before deletion', async () => {
        let deleteCalls = 0;
        const fake = createFakeChrome({
            windows: [{ id: 1, type: 'normal' }],
            removeBrowsingData: async () => {
                deleteCalls += 1;
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 99,
            },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'INITIATOR_WINDOW_NOT_FOUND',
            record: { status: STATUS.ERROR },
        });
        expect(result.record.preDeleteWindowIds).toEqual([1]);
        expect(deleteCalls).toBe(0);
        expect(fake.removed).toEqual([]);
    });

    it('excludes incognito windows from both snapshots and records counts only', async () => {
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal', incognito: true },
                { id: 3, type: 'popup' },
                { id: 4, type: 'popup', incognito: true },
            ],
            removeWindow: (id, { windowList, setWindows }) => {
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            makeClock(),
        );

        expect(result).toMatchObject({ ok: true, status: STATUS.OK });
        expect(fake.removed).toEqual([3, 1]);
        expect(fake.getWindows().map((window) => window.id)).toEqual([2, 4]);
        expect(result.record.preDeleteWindowIds).toEqual([1, 3]);
        expect(result.record.postDeleteWindowIds).toEqual([1, 3]);
        expect(result.record.preDeleteExcludedIncognitoWindowCount).toBe(2);
        expect(result.record.postDeleteExcludedIncognitoWindowCount).toBe(2);
        expect(result.record.targetWindowIds).toEqual([1, 3]);
    });

    it('rejects delete-and-close from an incognito initiator before deletion', async () => {
        let deleteCalls = 0;
        const fake = createFakeChrome({
            windows: [{ id: 2, type: 'normal', incognito: true }],
            removeBrowsingData: async () => {
                deleteCalls += 1;
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 2,
            },
            makeClock(),
        );

        expect(result).toMatchObject({
            ok: false,
            code: 'INCOGNITO_INITIATOR_UNSUPPORTED',
            record: {
                status: STATUS.ERROR,
                preDeleteWindowIds: [],
                preDeleteExcludedIncognitoWindowCount: 1,
            },
        });
        expect(result.record.errorMessage).toContain('削除のみ');
        expect(deleteCalls).toBe(0);
        expect(fake.removed).toEqual([]);
    });

    it('records browsing data rejection and does not close windows', async () => {
        const fake = createFakeChrome({
            removeBrowsingData: async () => {
                throw new Error('delete failed');
            },
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            { mode: 'delete_only', settings: {}, initiatorWindowId: null },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'BROWSING_DATA_REMOVE_FAILED',
            record: { status: STATUS.ERROR },
        });
        expect(fake.removed).toEqual([]);
    });

    it('records post-delete enumeration failure as partial', async () => {
        const fake = createFakeChrome({ windows: [{ id: 1, type: 'normal' }] });
        let calls = 0;
        fake.chromeApi.windows.getAll = async () => {
            calls += 1;
            if (calls > 1) throw new Error('post enumeration');
            return [{ id: 1, type: 'normal' }];
        };
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            { mode: 'delete_and_close', settings: {}, initiatorWindowId: 1 },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'WINDOW_ENUMERATION_FAILED',
            record: { status: STATUS.PARTIAL },
        });
        expect(fake.removed).toEqual([]);
    });

    it('records no stable target when every pre window disappears', async () => {
        const fake = createFakeChrome({
            windows: [{ id: 1, type: 'normal' }],
            removeBrowsingData: async () => fake.setWindows([]),
        });
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            { mode: 'delete_and_close', settings: {}, initiatorWindowId: 1 },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'NO_STABLE_TARGET',
            record: { status: STATUS.PARTIAL },
        });
        expect(result.record.partialReasons).toContain('no_stable_target');
    });

    it('records final verification failure and final remove failure', async () => {
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
            ],
            removeWindow: (id) =>
                id === 1
                    ? Promise.reject(new Error('final failed'))
                    : Promise.resolve(),
            currentWindowId: 1,
        });
        let calls = 0;
        fake.chromeApi.windows.getAll = async () => {
            calls += 1;
            if (calls > 2) throw new Error('verification');
            return [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
            ];
        };
        const result = await runSecureClose(
            makeApi(fake, makeClock()),
            { mode: 'delete_and_close', settings: {}, initiatorWindowId: 1 },
            makeClock(),
        );
        expect(result).toMatchObject({
            ok: false,
            code: 'WINDOW_VERIFICATION_FAILED',
            record: { status: STATUS.PARTIAL },
        });
        expect(result.record.partialReasons).toContain('window_close_failed');
        expect(result.record.partialReasons).toContain('verification_failed');
    });

    it('deletes before closing stable windows and persists final success', async () => {
        const order = [];
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
                { id: 3, type: 'popup' },
                { id: 9, type: 'devtools' },
            ],
            removeBrowsingData: async () => {
                order.push('delete');
            },
            removeWindow: (id, { windowList, setWindows }) => {
                order.push(`close:${id}`);
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
            currentWindowId: 1,
        });
        const clock = makeClock();
        const result = await runSecureClose(
            makeApi(fake, clock),
            {
                type: 'RUN_SECURE_CLOSE',
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            clock,
        );
        expect(result).toMatchObject({ ok: true, status: STATUS.OK });
        expect(order[0]).toBe('delete');
        expect(fake.removed).toEqual([2, 3, 1]);
        expect(result.record.preDeleteWindowIds).toEqual([1, 2, 3]);
        expect(result.record.closedWindowIds).toEqual([1, 2, 3]);
    });

    it('does not close a window created during deletion', async () => {
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
            ],
            removeBrowsingData: async () =>
                fake.setWindows([
                    { id: 1, type: 'normal' },
                    { id: 2, type: 'normal' },
                    { id: 4, type: 'normal' },
                ]),
            removeWindow: (id, { windowList, setWindows }) => {
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
            currentWindowId: 1,
        });
        const clock = makeClock();
        const result = await runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            clock,
        );
        expect(result.record.skippedWindowIds).toEqual([4]);
        expect(fake.removed).not.toContain(4);
        expect(fake.getWindows().map((window) => window.id)).toEqual([4]);
    });

    it('uses deterministic fallback when the initiator disappears', async () => {
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
                { id: 3, type: 'normal' },
            ],
            removeBrowsingData: async () =>
                fake.setWindows([
                    { id: 2, type: 'normal' },
                    { id: 3, type: 'normal' },
                ]),
            removeWindow: (id, { windowList, setWindows }) => {
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
            currentWindowId: 1,
        });
        const clock = makeClock();
        const result = await runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            clock,
        );
        expect(result.record.finalWindowId).toBe(2);
        expect(result.record.partialReasons).toContain(
            'initiator_window_missing',
        );
        expect(fake.removed).toEqual([3, 2]);
        expect(result.status).toBe(STATUS.PARTIAL);
    });

    it('continues after an intermediate remove timeout', async () => {
        const clock = makeClock();
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
                { id: 3, type: 'normal' },
            ],
            removeWindow: (id, { windowList, setWindows }) => {
                if (id === 2) return new Promise(() => undefined);
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
            currentWindowId: 1,
        });
        const promise = runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            clock,
        );
        await new Promise((resolve) => setImmediate(resolve));
        clock.advance(5_000);
        const result = await promise;
        expect(result.status).toBe(STATUS.PARTIAL);
        expect(result.record.failedWindowIds).toContain(2);
        expect(fake.removed).toEqual([2, 3, 1]);
    });

    it('records a final remove timeout and verifies the remaining target', async () => {
        const clock = makeClock();
        const fake = createFakeChrome({
            windows: [
                { id: 1, type: 'normal' },
                { id: 2, type: 'normal' },
            ],
            removeWindow: (id, { windowList, setWindows }) => {
                if (id === 1) return new Promise(() => undefined);
                setWindows(windowList.filter((window) => window.id !== id));
                return Promise.resolve();
            },
            currentWindowId: 1,
        });
        const promise = runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: 1,
            },
            clock,
        );
        await new Promise((resolve) => setImmediate(resolve));
        clock.advance(5_000);
        const result = await promise;
        expect(result).toMatchObject({ ok: false, status: STATUS.PARTIAL });
        expect(result.record.failedWindowIds).toContain(1);
        expect(result.record.partialReasons).toContain('window_close_failed');
        expect(result.record.remainingWindows).toBe(1);
        expect(fake.removed).toEqual([2, 1]);
    });

    it('supports delete-only without enumerating or closing windows', async () => {
        let deleteCalls = 0;
        const fake = createFakeChrome({
            windows: [{ id: 1, type: 'normal' }],
            removeBrowsingData: async () => {
                deleteCalls += 1;
            },
        });
        const clock = makeClock();
        const result = await runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_only',
                settings: {},
                initiatorWindowId: null,
            },
            clock,
        );
        expect(result).toMatchObject({ ok: true, status: STATUS.OK });
        expect(deleteCalls).toBe(1);
        expect(fake.removed).toEqual([]);
    });

    it('persists no_selection and never calls deletion APIs', async () => {
        let deleteCalls = 0;
        const fake = createFakeChrome({
            removeBrowsingData: async () => {
                deleteCalls += 1;
            },
        });
        const clock = makeClock();
        const result = await runSecureClose(
            makeApi(fake, clock),
            {
                mode: 'delete_and_close',
                settings: {
                    dataTypes: Object.fromEntries(
                        [
                            'history',
                            'cache',
                            'cookies',
                            'downloads',
                            'formData',
                            'cacheStorage',
                            'localStorage',
                            'indexedDB',
                            'serviceWorkers',
                            'fileSystems',
                        ].map((key) => [key, false]),
                    ),
                },
                initiatorWindowId: 1,
            },
            clock,
        );
        expect(result).toMatchObject({ ok: true, status: STATUS.NO_SELECTION });
        expect(deleteCalls).toBe(0);
    });
});
