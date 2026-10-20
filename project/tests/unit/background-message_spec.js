import { describe, expect, it } from 'vitest';
import { createBackgroundHandler } from '../../extension/background.js';
import { createFakeChrome } from '../support/fake-chrome.js';

function responseFor(handler, message, sender = { id: 'fake-extension-id' }) {
    return new Promise((resolve) => handler.listener(message, sender, resolve));
}

describe('background message contract', () => {
    it('rejects foreign senders and unknown fields', async () => {
        const fake = createFakeChrome();
        const handler = createBackgroundHandler({ chromeApi: fake.chromeApi });
        expect(
            await responseFor(
                handler,
                {
                    type: 'RUN_SECURE_CLOSE',
                    mode: 'delete_only',
                    settings: {},
                    initiatorWindowId: null,
                },
                { id: 'other' },
            ),
        ).toMatchObject({ code: 'INVALID_REQUEST' });
        expect(
            await responseFor(handler, {
                type: 'RUN_SECURE_CLOSE',
                mode: 'delete_only',
                settings: {},
                initiatorWindowId: null,
                extra: true,
            }),
        ).toMatchObject({ code: 'INVALID_REQUEST' });
        expect(
            await responseFor(handler, {
                type: 'RUN_SECURE_CLOSE',
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: null,
            }),
        ).toMatchObject({ code: 'INVALID_REQUEST' });
        expect(
            await responseFor(handler, {
                type: 'RUN_SECURE_CLOSE',
                mode: 'delete_and_close',
                settings: {},
                initiatorWindowId: -1,
            }),
        ).toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('returns BUSY synchronously while a run is in flight', async () => {
        let release;
        const fake = createFakeChrome({
            removeBrowsingData: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const handler = createBackgroundHandler({ chromeApi: fake.chromeApi });
        const first = responseFor(handler, {
            type: 'RUN_SECURE_CLOSE',
            mode: 'delete_only',
            settings: {},
            initiatorWindowId: null,
        });
        const second = await responseFor(handler, {
            type: 'RUN_SECURE_CLOSE',
            mode: 'delete_only',
            settings: {},
            initiatorWindowId: null,
        });
        expect(second).toMatchObject({ ok: false, code: 'BUSY' });
        await new Promise((resolve) => setImmediate(resolve));
        release();
        expect((await first).ok).toBe(true);
    });
});
