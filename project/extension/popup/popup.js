import {
    DATA_TYPE_LABELS,
    PRESET_LABELS,
    applyPreset,
    detectPreset,
    normalizeSettings,
} from '../lib/settings.js';
import { FILTERABLE_TYPES, GLOBAL_TYPES } from '../lib/cleaner.js';
import { toRunViewModel } from '../lib/view-model.js';

const TYPE_INPUTS = '[data-type]';
const SINCE_LABELS = Object.freeze({
    all: '全期間',
    hour: '過去1時間',
    day: '過去24時間',
    week: '過去1週間',
});

function byId(documentRef, id) {
    return documentRef.getElementById(id);
}

function setDisabled(elements, disabled) {
    for (const element of elements) element.disabled = disabled;
}

function sendMessage(chromeApi, message) {
    return new Promise((resolve, reject) => {
        chromeApi.runtime.sendMessage(message, (response) => {
            if (chromeApi.runtime.lastError) {
                reject(new Error(chromeApi.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

function selectedFilterableLabels(settings) {
    return FILTERABLE_TYPES.filter((type) => settings.dataTypes[type]).map(
        (type) => DATA_TYPE_LABELS[type],
    );
}

function confirmationText(mode, settings) {
    const presetId = detectPreset(settings);
    const preset = PRESET_LABELS[presetId] || PRESET_LABELS.custom;
    const selectedCount = Object.values(settings.dataTypes).filter(
        Boolean,
    ).length;
    const preservedCount = settings.preservedOrigins.length;
    const filterableLabels = selectedFilterableLabels(settings);
    const globalLabels = GLOBAL_TYPES.filter(
        (type) => settings.dataTypes[type],
    ).map((type) => DATA_TYPE_LABELS[type]);
    const preservedText =
        preservedCount === 0
            ? 'ログイン維持サイトは0件です。'
            : filterableLabels.length === 0
              ? `ログイン維持サイトは${preservedCount}件ですが、現在の選択ではログイン維持リストは適用されません。`
              : `ログイン維持サイト${preservedCount}件を${filterableLabels.join('・')}${filterableLabels.length === 1 ? 'にのみ' : 'に'}適用します。`;
    const safeText =
        presetId === 'safe'
            ? '安全プリセットではCookieとフォームデータは削除対象に選ばれていません。'
            : '';
    const globalText =
        globalLabels.length > 0
            ? `${globalLabels.join('・')}はログイン維持リストに関係なく全体削除されます。`
            : '';
    const cookieScopeText =
        preservedCount > 0 && settings.dataTypes.cookies
            ? 'Cookieの維持範囲はregistrable domain全体に及ぶ場合があります。'
            : '';
    const closeText =
        mode === 'delete_and_close'
            ? '列挙可能な通常・ポップアップウィンドウを閉じます。シークレットウィンドウは閉じません。シークレットからは削除のみを選択してください。'
            : 'ウィンドウは閉じません。';
    return `${preset} / ${selectedCount}項目 / ${SINCE_LABELS[settings.sinceMode]}。${preservedText}${safeText}${globalText}${cookieScopeText}${closeText}`;
}

export function createPopupController({
    document: documentRef,
    chromeApi,
    windowRef = globalThis.window,
} = {}) {
    const runCloseButton = byId(documentRef, 'run-close');
    const runDeleteButton = byId(documentRef, 'run-delete');
    const confirmButton = byId(documentRef, 'confirm-run');
    const cancelButton = byId(documentRef, 'cancel-run');
    const acknowledgeButton = byId(documentRef, 'acknowledge');
    const settingsInputs = [...documentRef.querySelectorAll(TYPE_INPUTS)];
    const presetButtons = [...documentRef.querySelectorAll('[data-preset]')];
    const sinceInput = byId(documentRef, 'since-mode');
    const confirmInput = byId(documentRef, 'confirm-before-run');
    const statusBox = byId(documentRef, 'run-status');
    const statusLabel = byId(documentRef, 'status-label');
    const statusSummary = byId(documentRef, 'status-summary');
    const reasonList = byId(documentRef, 'reason-list');
    const errorMessage = byId(documentRef, 'error-message');
    const messageBox = byId(documentRef, 'message');
    const inlineConfirm = byId(documentRef, 'inline-confirm');
    const presetLabel = byId(documentRef, 'preset-label');
    const preservedCount = byId(documentRef, 'preserved-count');
    const editPreservedButton = byId(documentRef, 'edit-preserved');
    let currentRun = null;
    let currentSettings = normalizeSettings();
    let pendingRequest = null;
    let busy = false;
    let settingsWriteTail = Promise.resolve();

    function enqueueSettingsWrite(task) {
        const run = settingsWriteTail.then(task, task);
        settingsWriteTail = run.catch(() => undefined);
        return run;
    }

    function showMessage(text) {
        messageBox.textContent = text;
    }

    function readSettingsPatch() {
        const dataTypes = {};
        for (const input of settingsInputs)
            dataTypes[input.dataset.type] = Boolean(input.checked);
        return {
            dataTypes,
            sinceMode: sinceInput.value,
            confirmBeforeRun: Boolean(confirmInput.checked),
        };
    }

    function readSettings() {
        return normalizeSettings({
            ...readSettingsPatch(),
            preservedOrigins: currentSettings.preservedOrigins,
        });
    }

    function saveSettings(patch = readSettingsPatch()) {
        const capturedPatch = {
            ...patch,
            ...(patch.dataTypes ? { dataTypes: { ...patch.dataTypes } } : {}),
        };
        return enqueueSettingsWrite(async () => {
            const saved = await chromeApi.storage.local.get('settings');
            const latest = normalizeSettings(saved.settings);
            const settings = normalizeSettings({
                ...latest,
                ...capturedPatch,
                dataTypes: capturedPatch.dataTypes
                    ? { ...latest.dataTypes, ...capturedPatch.dataTypes }
                    : latest.dataTypes,
                preservedOrigins: latest.preservedOrigins,
            });
            await chromeApi.storage.local.set({ settings });
            currentSettings = settings;
            return settings;
        });
    }

    function renderSettings(settings) {
        currentSettings = normalizeSettings(settings);
        for (const input of settingsInputs)
            input.checked = currentSettings.dataTypes[input.dataset.type];
        sinceInput.value = currentSettings.sinceMode;
        confirmInput.checked = currentSettings.confirmBeforeRun;
        const presetId = detectPreset(currentSettings);
        if (presetLabel)
            presetLabel.textContent =
                PRESET_LABELS[presetId] || PRESET_LABELS.custom;
        for (const button of presetButtons) {
            const active = button.dataset.preset === presetId;
            button.setAttribute('aria-pressed', String(active));
        }
        if (preservedCount)
            preservedCount.textContent = String(
                currentSettings.preservedOrigins.length,
            );
    }

    function hasSelectedDataType() {
        return settingsInputs.some((input) => Boolean(input.checked));
    }

    function renderRun(lastRun) {
        currentRun = lastRun || null;
        const model = toRunViewModel(lastRun);
        statusLabel.textContent = model.label;
        statusSummary.textContent = model.summary;
        statusBox.className = `status ${model.tone}`;
        reasonList.replaceChildren();
        for (const reason of model.reasons) {
            const item = documentRef.createElement('li');
            item.textContent = reason.text;
            reasonList.append(item);
        }
        errorMessage.textContent = model.errorMessage || '';
        acknowledgeButton.hidden = !model.showRecovery;
        const settingsDisabled = busy || !model.canRun;
        const runDisabled = settingsDisabled || !hasSelectedDataType();
        setDisabled(
            [...settingsInputs, ...presetButtons, sinceInput, confirmInput],
            settingsDisabled,
        );
        setDisabled([runCloseButton, runDeleteButton], runDisabled);
        if (editPreservedButton) editPreservedButton.disabled = busy;
    }

    async function persistSettingsAndRefresh(patch) {
        renderRun(currentRun);
        try {
            const settings = await saveSettings(patch);
            renderSettings(settings);
        } catch (error) {
            showMessage(error.message || '設定を保存できません。');
        }
        renderRun(currentRun);
    }

    function setConfirmationVisible(visible, request = null) {
        pendingRequest = visible ? request : null;
        inlineConfirm.hidden = !visible;
        confirmButton.hidden = !visible;
        cancelButton.hidden = !visible;
        if (visible)
            inlineConfirm.textContent = confirmationText(
                request.mode,
                request.settings,
            );
        else inlineConfirm.textContent = '';
    }

    async function execute(mode, effectiveSettings = null) {
        if (busy) return;
        busy = true;
        setConfirmationVisible(false);
        setDisabled(
            [
                ...settingsInputs,
                ...presetButtons,
                sinceInput,
                confirmInput,
                runCloseButton,
                runDeleteButton,
            ],
            true,
        );
        showMessage('処理を開始しました。');
        try {
            const settings = effectiveSettings
                ? normalizeSettings(effectiveSettings)
                : await saveSettings();
            currentSettings = settings;
            let initiatorWindowId = null;
            if (mode === 'delete_and_close') {
                const currentWindow = await chromeApi.windows.getCurrent();
                if (!Number.isInteger(currentWindow?.id))
                    throw new Error('開始元ウィンドウを取得できません。');
                initiatorWindowId = currentWindow.id;
            }
            const request = sendMessage(chromeApi, {
                type: 'RUN_SECURE_CLOSE',
                mode,
                settings,
                initiatorWindowId,
            });
            let timeoutId;
            const timeout = new Promise((resolve) => {
                timeoutId = windowRef.setTimeout(
                    () => resolve({ ok: false, code: 'UI_TIMEOUT' }),
                    90_000,
                );
            });
            const response = await Promise.race([request, timeout]);
            if (
                timeoutId !== undefined &&
                typeof windowRef.clearTimeout === 'function'
            )
                windowRef.clearTimeout(timeoutId);
            if (response.code === 'UI_TIMEOUT') {
                showMessage(
                    '応答待ちがタイムアウトしました。処理継続中か、終了処理へ移行済みです。',
                );
            } else if (!response.ok && response.code === 'RECOVERY_REQUIRED') {
                showMessage('前回の中断状態を確認してください。');
            } else if (!response.ok) {
                showMessage(`処理結果: ${response.code || '失敗'}`);
            } else {
                showMessage('処理結果を保存しました。');
            }
            const saved = await chromeApi.storage.local.get('lastRun');
            renderRun(saved.lastRun || currentRun);
        } catch (error) {
            showMessage(error.message || '処理を開始できません。');
            renderRun(currentRun);
        } finally {
            busy = false;
            const saved = await chromeApi.storage.local.get('lastRun');
            renderRun(saved.lastRun || currentRun);
        }
    }

    async function requestRun(mode) {
        if (!toRunViewModel(currentRun).canRun || busy) return;
        try {
            const settings = await saveSettings();
            renderSettings(settings);
            if (!Object.values(settings.dataTypes).some(Boolean)) {
                showMessage('少なくとも1項目を選択してください。');
                renderRun(currentRun);
                return;
            }
            const request = { mode, settings };
            if (settings.confirmBeforeRun)
                setConfirmationVisible(true, request);
            else void execute(mode, settings);
        } catch (error) {
            showMessage(error.message || '設定を読み込めません。');
        }
    }

    async function acknowledge() {
        if (!currentRun?.operationId) return;
        const response = await sendMessage(chromeApi, {
            type: 'ACKNOWLEDGE_RECOVERY',
            operationId: currentRun.operationId,
        });
        showMessage(
            response.ok
                ? '中断状態を確認済みにしました。'
                : `確認できません: ${response.code || '失敗'}`,
        );
        const saved = await chromeApi.storage.local.get('lastRun');
        renderRun(saved.lastRun || currentRun);
    }

    async function load() {
        const saved = await chromeApi.storage.local.get([
            'settings',
            'lastRun',
        ]);
        renderSettings(saved.settings);
        renderRun(saved.lastRun || null);
    }

    for (const input of settingsInputs) {
        input.addEventListener(
            'change',
            () =>
                void persistSettingsAndRefresh({
                    dataTypes: { [input.dataset.type]: Boolean(input.checked) },
                }),
        );
    }
    for (const button of presetButtons) {
        button.addEventListener('click', () => {
            try {
                renderSettings(
                    applyPreset(readSettings(), button.dataset.preset),
                );
                void persistSettingsAndRefresh({
                    dataTypes: { ...currentSettings.dataTypes },
                });
            } catch (error) {
                showMessage(error.message || 'プリセットを適用できません。');
            }
        });
    }
    sinceInput.addEventListener(
        'change',
        () => void persistSettingsAndRefresh({ sinceMode: sinceInput.value }),
    );
    confirmInput.addEventListener(
        'change',
        () =>
            void persistSettingsAndRefresh({
                confirmBeforeRun: Boolean(confirmInput.checked),
            }),
    );
    runCloseButton.addEventListener(
        'click',
        () => void requestRun('delete_and_close'),
    );
    runDeleteButton.addEventListener(
        'click',
        () => void requestRun('delete_only'),
    );
    confirmButton.addEventListener('click', () => {
        if (pendingRequest)
            void execute(pendingRequest.mode, pendingRequest.settings);
    });
    cancelButton.addEventListener('click', () => setConfirmationVisible(false));
    acknowledgeButton.addEventListener('click', () => void acknowledge());
    editPreservedButton?.addEventListener('click', () => {
        if (typeof chromeApi.runtime.openOptionsPage === 'function')
            void chromeApi.runtime.openOptionsPage();
    });

    return Object.freeze({
        load,
        renderRun,
        readSettings,
        execute,
        requestRun,
    });
}

if (globalThis.document && globalThis.chrome?.runtime) {
    void createPopupController({
        document: globalThis.document,
        chromeApi: globalThis.chrome,
    }).load();
}
