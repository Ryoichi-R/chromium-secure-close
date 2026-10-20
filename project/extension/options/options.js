import {
    DEFAULT_SETTINGS,
    MAX_PRESERVED_ORIGINS,
    PRESET_LABELS,
    applyPreset,
    detectPreset,
    normalizeOrigin,
    normalizeSettings,
} from '../lib/settings.js';
import { toRunViewModel } from '../lib/view-model.js';

function byId(documentRef, id) {
    return documentRef.getElementById(id);
}

export function createOptionsController({
    document: documentRef,
    chromeApi,
    windowRef = globalThis.window,
} = {}) {
    const inputs = [...documentRef.querySelectorAll('[data-type]')];
    const presetButtons = [...documentRef.querySelectorAll('[data-preset]')];
    const sinceInput = byId(documentRef, 'since-mode');
    const confirmInput = byId(documentRef, 'confirm-before-run');
    const resetButton = byId(documentRef, 'reset');
    const originInput = byId(documentRef, 'origin-input');
    const addOriginButton = byId(documentRef, 'add-origin');
    const originList = byId(documentRef, 'origin-list');
    const presetLabel = byId(documentRef, 'preset-label');
    const statusBox = byId(documentRef, 'run-status');
    const statusLabel = byId(documentRef, 'status-label');
    const statusSummary = byId(documentRef, 'status-summary');
    const reasonList = byId(documentRef, 'reason-list');
    const errorMessage = byId(documentRef, 'error-message');
    const messageBox = byId(documentRef, 'message');
    let currentSettings = normalizeSettings();
    let settingsWriteTail = Promise.resolve();

    function enqueueSettingsWrite(task) {
        const run = settingsWriteTail.then(task, task);
        settingsWriteTail = run.catch(() => undefined);
        return run;
    }

    function readPatch() {
        const dataTypes = {};
        for (const input of inputs)
            dataTypes[input.dataset.type] = Boolean(input.checked);
        return {
            dataTypes,
            sinceMode: sinceInput.value,
            confirmBeforeRun: Boolean(confirmInput.checked),
        };
    }

    function readSettings() {
        return normalizeSettings({
            ...readPatch(),
            preservedOrigins: currentSettings.preservedOrigins,
        });
    }

    async function readLatestSettings() {
        const saved = await chromeApi.storage.local.get('settings');
        return normalizeSettings(saved.settings);
    }

    function renderOrigins(origins) {
        originList.replaceChildren();
        for (let index = 0; index < origins.length; index += 1) {
            const row = documentRef.createElement('li');
            row.textContent = origins[index];
            const removeButton = documentRef.createElement('button');
            removeButton.type = 'button';
            removeButton.textContent = '削除';
            removeButton.addEventListener(
                'click',
                () => void removeOrigin(index),
            );
            row.append(removeButton);
            originList.append(row);
        }
    }

    function applySettings(settings) {
        currentSettings = normalizeSettings(settings);
        for (const input of inputs)
            input.checked = currentSettings.dataTypes[input.dataset.type];
        sinceInput.value = currentSettings.sinceMode;
        confirmInput.checked = currentSettings.confirmBeforeRun;
        const presetId = detectPreset(currentSettings);
        if (presetLabel)
            presetLabel.textContent =
                PRESET_LABELS[presetId] || PRESET_LABELS.custom;
        for (const button of presetButtons)
            button.setAttribute(
                'aria-pressed',
                String(button.dataset.preset === presetId),
            );
        renderOrigins(currentSettings.preservedOrigins);
    }

    async function storeSettings(settings, message) {
        await chromeApi.storage.local.set({ settings });
        applySettings(settings);
        messageBox.textContent = message;
        return settings;
    }

    function save(patch = readPatch(), message = '設定を保存しました。') {
        const capturedPatch = {
            ...patch,
            ...(patch.dataTypes ? { dataTypes: { ...patch.dataTypes } } : {}),
            ...(patch.preservedOrigins
                ? { preservedOrigins: [...patch.preservedOrigins] }
                : {}),
        };
        return enqueueSettingsWrite(async () => {
            const latest = await readLatestSettings();
            const settings = normalizeSettings({
                ...latest,
                ...capturedPatch,
                dataTypes: capturedPatch.dataTypes
                    ? { ...latest.dataTypes, ...capturedPatch.dataTypes }
                    : latest.dataTypes,
                preservedOrigins: Object.hasOwn(
                    capturedPatch,
                    'preservedOrigins',
                )
                    ? capturedPatch.preservedOrigins
                    : latest.preservedOrigins,
            });
            return storeSettings(settings, message);
        });
    }

    function renderRun(lastRun) {
        const model = toRunViewModel(lastRun);
        statusLabel.textContent = model.label;
        statusSummary.textContent = model.summary;
        statusBox.className = model.tone;
        reasonList.replaceChildren();
        for (const reason of model.reasons) {
            const item = documentRef.createElement('li');
            item.textContent = reason.text;
            reasonList.append(item);
        }
        errorMessage.textContent = model.errorMessage || '';
    }

    async function addOrigin() {
        try {
            const origin = normalizeOrigin(originInput.value);
            await enqueueSettingsWrite(async () => {
                const latest = await readLatestSettings();
                if (latest.preservedOrigins.includes(origin)) {
                    messageBox.textContent =
                        'このoriginは既に登録されています。';
                    return latest;
                }
                if (latest.preservedOrigins.length >= MAX_PRESERVED_ORIGINS) {
                    messageBox.textContent = `ログイン維持サイトは${MAX_PRESERVED_ORIGINS}件までです。`;
                    return latest;
                }
                const settings = normalizeSettings({
                    ...latest,
                    preservedOrigins: [...latest.preservedOrigins, origin],
                });
                await storeSettings(
                    settings,
                    'ログイン維持サイトを追加しました。',
                );
                originInput.value = '';
                return settings;
            });
        } catch (error) {
            messageBox.textContent =
                error.message || 'originを追加できません。';
        }
    }

    async function removeOrigin(index) {
        try {
            await enqueueSettingsWrite(async () => {
                const latest = await readLatestSettings();
                if (
                    !Number.isInteger(index) ||
                    index < 0 ||
                    index >= latest.preservedOrigins.length
                )
                    return latest;
                const preservedOrigins = latest.preservedOrigins.filter(
                    (_, itemIndex) => itemIndex !== index,
                );
                const settings = normalizeSettings({
                    ...latest,
                    preservedOrigins,
                });
                return storeSettings(
                    settings,
                    'ログイン維持サイトを削除しました。',
                );
            });
        } catch (error) {
            messageBox.textContent =
                error.message || 'originを削除できません。';
        }
    }

    async function reset() {
        if (
            typeof windowRef?.confirm === 'function' &&
            !windowRef.confirm('設定とログイン維持リストを既定値へ戻しますか？')
        )
            return;
        await enqueueSettingsWrite(() =>
            storeSettings(
                normalizeSettings(DEFAULT_SETTINGS),
                '既定値へ戻しました。',
            ),
        );
    }

    async function load() {
        const saved = await chromeApi.storage.local.get([
            'settings',
            'lastRun',
        ]);
        applySettings(saved.settings);
        renderRun(saved.lastRun || null);
    }

    for (const input of inputs) {
        input.addEventListener(
            'change',
            () =>
                void save({
                    dataTypes: { [input.dataset.type]: Boolean(input.checked) },
                }),
        );
    }
    for (const button of presetButtons) {
        button.addEventListener('click', () => {
            try {
                const next = applyPreset(readSettings(), button.dataset.preset);
                void save({ dataTypes: next.dataTypes });
            } catch (error) {
                messageBox.textContent =
                    error.message || 'プリセットを適用できません。';
            }
        });
    }
    sinceInput.addEventListener(
        'change',
        () => void save({ sinceMode: sinceInput.value }),
    );
    confirmInput.addEventListener(
        'change',
        () => void save({ confirmBeforeRun: Boolean(confirmInput.checked) }),
    );
    addOriginButton.addEventListener('click', () => void addOrigin());
    resetButton.addEventListener('click', () => void reset());
    return Object.freeze({
        load,
        save,
        reset,
        readSettings,
        renderRun,
        addOrigin,
        removeOrigin,
    });
}

if (globalThis.document && globalThis.chrome?.storage) {
    void createOptionsController({
        document: globalThis.document,
        chromeApi: globalThis.chrome,
    }).load();
}
