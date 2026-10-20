import { describe, expect, it } from 'vitest';
import { createPopupController } from '../../extension/popup/popup.js';
import { createFakeChrome } from '../support/fake-chrome.js';
import { createPopupDocument } from '../support/fake-dom.js';

async function flushAsync(turns = 4) {
    for (let index = 0; index < turns; index += 1)
        await new Promise((resolve) => setImmediate(resolve));
}

describe('popup UI integration', () => {
    it('renders state, uses inline confirmation, and sends the selected mode', async () => {
        const documentRef = createPopupDocument();
        const fake = createFakeChrome();
        const sent = [];
        fake.chromeApi.runtime.sendMessage = (message, callback) => {
            sent.push(message);
            if (message.type === 'ACKNOWLEDGE_RECOVERY')
                void fake.storage.set({
                    lastRun: {
                        operationId: 'recover-1',
                        status: 'interrupted_unknown',
                        partialReasons: [],
                        requestedTypes: ['history'],
                    },
                });
            callback({ ok: true, status: 'ok' });
            return true;
        };
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
            windowRef: { setTimeout: () => 0 },
        });
        await controller.load();
        documentRef
            .getElementById('run-delete')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(documentRef.getElementById('confirm-run').hidden).toBe(false);
        documentRef
            .getElementById('confirm-run')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(sent[0]).toMatchObject({
            type: 'RUN_SECURE_CLOSE',
            mode: 'delete_only',
        });
        expect(
            documentRef.getElementById('status-label').textContent,
        ).toContain('前回');
    });

    it('prevents an empty selection', async () => {
        const documentRef = createPopupDocument();
        const fake = createFakeChrome();
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
            windowRef: { setTimeout: () => 0 },
        });
        await controller.load();
        for (const input of documentRef.querySelectorAll('[data-type]')) {
            input.checked = false;
            input.dispatchEvent({ type: 'change' });
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(documentRef.getElementById('run-close').disabled).toBe(true);
        expect(documentRef.getElementById('run-delete').disabled).toBe(true);
        expect(documentRef.querySelectorAll('[data-type]')[0].disabled).toBe(
            false,
        );
        documentRef
            .getElementById('run-delete')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(documentRef.getElementById('message').textContent).toContain(
            '少なくとも1項目',
        );
    });

    it('gets the initiator window for delete-and-close and acknowledges recovery', async () => {
        const documentRef = createPopupDocument();
        const fake = createFakeChrome({
            initialStorage: {
                settings: { confirmBeforeRun: false },
                lastRun: {
                    operationId: 'recover-1',
                    status: 'deleting',
                    partialReasons: [],
                    requestedTypes: ['history'],
                },
            },
            windows: [{ id: 7, type: 'normal' }],
            currentWindowId: 7,
        });
        const sent = [];
        fake.chromeApi.runtime.sendMessage = (message, callback) => {
            sent.push(message);
            callback({ ok: true, status: 'ok' });
            return true;
        };
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
            windowRef: { setTimeout: () => 0 },
        });
        await controller.load();
        documentRef
            .getElementById('acknowledge')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(sent[0]).toMatchObject({
            type: 'ACKNOWLEDGE_RECOVERY',
            operationId: 'recover-1',
        });
        controller.renderRun({
            operationId: 'recover-1',
            status: 'interrupted_unknown',
            partialReasons: [],
            requestedTypes: ['history'],
        });
        documentRef
            .getElementById('run-close')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(sent.at(-1)).toMatchObject({
            type: 'RUN_SECURE_CLOSE',
            mode: 'delete_and_close',
            initiatorWindowId: 7,
        });
    });

    it('uses the latest preserved origins in confirmation and in the sent request', async () => {
        const documentRef = createPopupDocument();
        const fake = createFakeChrome({
            initialStorage: { settings: { preservedOrigins: [] } },
        });
        const sent = [];
        fake.chromeApi.runtime.sendMessage = (message, callback) => {
            sent.push(message);
            callback({ ok: true, status: 'ok' });
            return true;
        };
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
            windowRef: { setTimeout: () => 0 },
        });
        await controller.load();
        await fake.storage.set({
            settings: { preservedOrigins: ['https://github.com'] },
        });
        documentRef
            .getElementById('run-delete')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        const confirmation =
            documentRef.getElementById('inline-confirm').textContent;
        expect(confirmation).toContain('ログイン維持サイト1件');
        expect(confirmation).toContain(
            '履歴・ダウンロード履歴・フォームデータはログイン維持リストに関係なく全体削除',
        );
        expect(confirmation).toContain('registrable domain全体');
        documentRef
            .getElementById('confirm-run')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(sent[0].settings.preservedOrigins).toEqual([
            'https://github.com',
        ]);
    });

    it('applies a preset and opens the options page without running deletion', async () => {
        let opened = 0;
        const documentRef = createPopupDocument();
        const fake = createFakeChrome({
            initialStorage: {
                settings: { preservedOrigins: ['https://github.com'] },
            },
            openOptionsPage: () => {
                opened += 1;
            },
        });
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        documentRef
            .querySelectorAll('[data-preset]')
            .find((button) => button.dataset.preset === 'safe')
            .dispatchEvent({ type: 'click' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fake.storage.snapshot().settings.dataTypes.cookies).toBe(false);
        documentRef
            .getElementById('run-delete')
            .dispatchEvent({ type: 'click' });
        await flushAsync();
        const confirmation =
            documentRef.getElementById('inline-confirm').textContent;
        expect(confirmation).toContain('キャッシュにのみ適用');
        expect(confirmation).toContain(
            'Cookieとフォームデータは削除対象に選ばれていません',
        );
        expect(confirmation).toContain(
            '履歴・ダウンロード履歴はログイン維持リストに関係なく全体削除',
        );
        documentRef
            .getElementById('edit-preserved')
            .dispatchEvent({ type: 'click' });
        expect(opened).toBe(1);
    });

    it('patches only the changed field and preserves newer settings from another context', async () => {
        const documentRef = createPopupDocument();
        const fake = createFakeChrome();
        const controller = createPopupController({
            document: documentRef,
            chromeApi: fake.chromeApi,
        });
        await controller.load();
        const latest = fake.storage.snapshot().settings || {};
        await fake.storage.set({
            settings: { ...latest, sinceMode: 'week', confirmBeforeRun: false },
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
            dataTypes: { history: false },
        });
    });

    it('serializes rapid writes so an older save cannot finish last', async () => {
        const documentRef = createPopupDocument();
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
        const controller = createPopupController({
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
});
