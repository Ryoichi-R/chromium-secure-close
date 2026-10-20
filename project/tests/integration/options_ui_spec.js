import { describe, expect, it } from 'vitest';
import { createOptionsController } from '../../extension/options/options.js';
import { createFakeChrome } from '../support/fake-chrome.js';
import { createOptionsDocument } from '../support/fake-dom.js';

async function flushAsync(turns = 4) {
    for (let index = 0; index < turns; index += 1)
        await new Promise((resolve) => setImmediate(resolve));
}

describe('options UI integration', () => {
    it('loads, persists, and resets settings through storage.local', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome({
            initialStorage: {
                settings: {
                    dataTypes: { history: false },
                    sinceMode: 'day',
                    confirmBeforeRun: false,
                },
            },
        });
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        expect(documentRef.querySelectorAll('[data-type]')[0].checked).toBe(
            false,
        );
        expect(documentRef.getElementById('since-mode').value).toBe('day');
        documentRef.querySelectorAll('[data-type]')[0].checked = true;
        await controller.save();
        expect(fake.storage.snapshot().settings.dataTypes.history).toBe(true);
        await controller.reset();
        expect(fake.storage.snapshot().settings.confirmBeforeRun).toBe(true);
    });

    it('adds, rejects, and removes normalized origins while preserving other settings', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome({
            initialStorage: {
                settings: { sinceMode: 'day', confirmBeforeRun: false },
            },
        });
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
            windowRef: { confirm: () => true },
        });
        await controller.load();
        documentRef.getElementById('origin-input').value =
            'HTTPS://Example.COM';
        documentRef
            .getElementById('add-origin')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fake.storage.snapshot().settings.preservedOrigins).toEqual([
            'https://example.com',
        ]);
        expect(fake.storage.snapshot().settings.sinceMode).toBe('day');
        documentRef.getElementById('origin-input').value = 'http://example.com';
        documentRef
            .getElementById('add-origin')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(documentRef.getElementById('message').textContent).toContain(
            'httpは',
        );
        const removeButton =
            documentRef.getElementById('origin-list').children[0].children[0];
        removeButton.dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fake.storage.snapshot().settings.preservedOrigins).toEqual([]);
    });

    it('keeps a concurrently added origin when another field is saved', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome({
            initialStorage: { settings: { preservedOrigins: [] } },
        });
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        await fake.storage.set({
            settings: { preservedOrigins: ['https://github.com'] },
        });
        documentRef.querySelectorAll('[data-type]')[0].checked = false;
        await controller.save();
        expect(fake.storage.snapshot().settings.preservedOrigins).toEqual([
            'https://github.com',
        ]);
    });

    it('patches only the changed field and preserves newer general settings', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome();
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        await fake.storage.set({
            settings: {
                sinceMode: 'week',
                confirmBeforeRun: false,
                preservedOrigins: ['https://github.com'],
            },
        });
        const historyInput = documentRef
            .querySelectorAll('[data-type]')
            .find((input) => input.dataset.type === 'history');
        historyInput.checked = false;
        historyInput.dispatchEvent({ type: 'change' });
        await flushAsync();
        expect(fake.storage.snapshot().settings).toMatchObject({
            sinceMode: 'week',
            confirmBeforeRun: false,
            preservedOrigins: ['https://github.com'],
            dataTypes: { history: false },
        });
    });

    it('serializes rapid writes so an older save cannot finish last', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome();
        const originalSet = fake.chromeApi.storage.local.set.bind(
            fake.chromeApi.storage.local,
        );
        let releaseFirst;
        const firstGate = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        let setCalls = 0;
        fake.chromeApi.storage.local.set = async (values) => {
            setCalls += 1;
            if (setCalls === 1) await firstGate;
            await originalSet(values);
        };
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        const historyInput = documentRef
            .querySelectorAll('[data-type]')
            .find((input) => input.dataset.type === 'history');
        historyInput.checked = false;
        historyInput.dispatchEvent({ type: 'change' });
        await flushAsync(1);
        documentRef.getElementById('since-mode').value = 'day';
        documentRef
            .getElementById('since-mode')
            .dispatchEvent({ type: 'change' });
        await flushAsync(2);
        expect(setCalls).toBe(1);
        releaseFirst();
        await flushAsync(6);
        expect(setCalls).toBe(2);
        expect(fake.storage.snapshot().settings).toMatchObject({
            sinceMode: 'day',
            dataTypes: { history: false },
        });
    });

    it('reports duplicate and maximum-origin errors without writing', async () => {
        const documentRef = createOptionsDocument();
        const fake = createFakeChrome({
            initialStorage: {
                settings: { preservedOrigins: ['https://example.com'] },
            },
        });
        const controller = createOptionsController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        documentRef.getElementById('origin-input').value =
            'https://example.com';
        await controller.addOrigin();
        expect(documentRef.getElementById('message').textContent).toContain(
            '既に登録',
        );

        await fake.storage.set({
            settings: {
                preservedOrigins: Array.from(
                    { length: 100 },
                    (_, index) => `https://site-${index}.example`,
                ),
            },
        });
        documentRef.getElementById('origin-input').value =
            'https://overflow.example';
        await controller.addOrigin();
        expect(documentRef.getElementById('message').textContent).toContain(
            '100件まで',
        );
        expect(fake.storage.snapshot().settings.preservedOrigins).toHaveLength(
            100,
        );
    });
});
