export const DATA_TYPE_KEYS = Object.freeze([
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
]);

export const DATA_TYPE_LABELS = Object.freeze({
    history: '履歴',
    cache: 'キャッシュ',
    cookies: 'Cookie',
    downloads: 'ダウンロード履歴',
    formData: 'フォームデータ',
    cacheStorage: 'Cache Storage',
    localStorage: 'Local Storage',
    indexedDB: 'IndexedDB',
    serviceWorkers: 'Service Workers',
    fileSystems: 'File Systems',
});

const STANDARD_DATA_TYPES = Object.freeze({
    history: true,
    cache: true,
    cookies: true,
    downloads: true,
    formData: true,
    cacheStorage: false,
    localStorage: false,
    indexedDB: false,
    serviceWorkers: false,
    fileSystems: false,
});

export const PRESET_DATA_TYPES = Object.freeze({
    safe: Object.freeze({
        ...STANDARD_DATA_TYPES,
        cookies: false,
        formData: false,
    }),
    standard: Object.freeze({ ...STANDARD_DATA_TYPES }),
    complete: Object.freeze({
        history: true,
        cache: true,
        cookies: true,
        downloads: true,
        formData: true,
        cacheStorage: true,
        localStorage: true,
        indexedDB: true,
        serviceWorkers: true,
        fileSystems: true,
    }),
});

export const PRESET_LABELS = Object.freeze({
    safe: '安全',
    standard: '標準',
    complete: '完全（サイトデータ含む）',
    custom: 'カスタム',
});

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: 2,
    dataTypes: Object.freeze({ ...STANDARD_DATA_TYPES }),
    sinceMode: 'all',
    confirmBeforeRun: true,
    preservedOrigins: Object.freeze([]),
});

export const MAX_PRESERVED_ORIGINS = 100;

const SINCE_MODES = new Set(['all', 'hour', 'day', 'week']);
const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(settings) {
    return {
        schemaVersion: 2,
        dataTypes: { ...settings.dataTypes },
        sinceMode: settings.sinceMode,
        confirmBeforeRun: settings.confirmBeforeRun,
        preservedOrigins: [...settings.preservedOrigins],
    };
}

/**
 * Normalize one origin entered by a user. The returned value is URL.origin,
 * which means default ports, host case, and IDN representation are canonical.
 */
export function normalizeOrigin(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('originを入力してください。');
    }
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new TypeError('有効なorigin URLを入力してください。');
    }
    if (url.origin === 'null' || !['http:', 'https:'].includes(url.protocol)) {
        throw new TypeError('httpまたはhttpsのoriginだけを登録できます。');
    }
    if (url.username || url.password) {
        throw new TypeError(
            'ユーザー名やパスワードを含むURLは登録できません。',
        );
    }
    if (
        url.protocol === 'http:' &&
        !LOOPBACK_HTTP_HOSTS.has(url.hostname.toLowerCase())
    ) {
        throw new TypeError(
            'httpはlocalhost、127.0.0.1、[::1]だけ登録できます。',
        );
    }
    if (url.pathname !== '/' || url.search || url.hash) {
        throw new TypeError(
            'path、query、fragmentを含めずoriginだけを入力してください。',
        );
    }
    return url.origin;
}

/**
 * Stored settings are normalized defensively. Invalid persisted origins are
 * discarded as a safe fallback; user-entered values use normalizeOrigin()
 * directly so that the UI can show the reason for rejection.
 */
export function normalizePreservedOrigins(value) {
    if (!Array.isArray(value)) return [];
    const normalized = [];
    for (const origin of value) {
        if (typeof origin !== 'string') return [];
        try {
            normalized.push(normalizeOrigin(origin));
        } catch {
            return [];
        }
    }
    const unique = [...new Set(normalized)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
    );
    return unique.length <= MAX_PRESERVED_ORIGINS ? unique : [];
}

function normalizeDataTypes(rawTypes) {
    const inputTypes = isPlainObject(rawTypes) ? rawTypes : {};
    const dataTypes = {};
    for (const key of DATA_TYPE_KEYS) {
        dataTypes[key] =
            typeof inputTypes[key] === 'boolean'
                ? inputTypes[key]
                : DEFAULT_SETTINGS.dataTypes[key];
    }
    return dataTypes;
}

export function normalizeSettings(raw) {
    const input = isPlainObject(raw) ? raw : {};
    return cloneSettings({
        schemaVersion: 2,
        dataTypes: normalizeDataTypes(input.dataTypes),
        sinceMode:
            typeof input.sinceMode === 'string' &&
            SINCE_MODES.has(input.sinceMode)
                ? input.sinceMode
                : DEFAULT_SETTINGS.sinceMode,
        confirmBeforeRun:
            typeof input.confirmBeforeRun === 'boolean'
                ? input.confirmBeforeRun
                : DEFAULT_SETTINGS.confirmBeforeRun,
        preservedOrigins: normalizePreservedOrigins(input.preservedOrigins),
    });
}

function dataTypesEqual(left, right) {
    return DATA_TYPE_KEYS.every(
        (key) => Boolean(left?.[key]) === Boolean(right?.[key]),
    );
}

export function detectPreset(value) {
    const dataTypes = isPlainObject(value?.dataTypes) ? value.dataTypes : value;
    for (const presetId of ['safe', 'standard', 'complete']) {
        if (dataTypesEqual(dataTypes, PRESET_DATA_TYPES[presetId]))
            return presetId;
    }
    return 'custom';
}

export function applyPreset(settings, presetId) {
    if (!Object.hasOwn(PRESET_DATA_TYPES, presetId) || presetId === 'custom') {
        throw new TypeError(`未知のプリセットです: ${presetId}`);
    }
    const normalized = normalizeSettings(settings);
    return cloneSettings({
        ...normalized,
        dataTypes: { ...PRESET_DATA_TYPES[presetId] },
    });
}

export function hasSelectedDataTypes(settings) {
    const normalized = normalizeSettings(settings);
    return DATA_TYPE_KEYS.some((key) => normalized.dataTypes[key]);
}

export function selectedDataTypeCount(settings) {
    const normalized = normalizeSettings(settings);
    return DATA_TYPE_KEYS.filter((key) => normalized.dataTypes[key]).length;
}

export function settingsForStorage(settings) {
    return normalizeSettings(settings);
}

export { SINCE_MODES };
