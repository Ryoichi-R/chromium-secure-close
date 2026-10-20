import { DATA_TYPE_KEYS, normalizeSettings } from './settings.js';

export const SINCE_MS = Object.freeze({
    all: 0,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
});

export const FILTERABLE_TYPES = Object.freeze([
    'cache',
    'cookies',
    'cacheStorage',
    'localStorage',
    'indexedDB',
    'serviceWorkers',
    'fileSystems',
]);

export const GLOBAL_TYPES = Object.freeze(['history', 'downloads', 'formData']);

function buildRemovalOptionsFromNormalized(normalized, now) {
    const current = now === undefined ? Date.now() : now;
    if (!Number.isFinite(current) || current < 0) {
        throw new TypeError('now must be a finite non-negative number');
    }
    const since =
        normalized.sinceMode === 'all'
            ? 0
            : Math.max(0, current - SINCE_MS[normalized.sinceMode]);
    return { since, originTypes: { unprotectedWeb: true } };
}

function buildDataTypeSetFromNormalized(normalized, keys = DATA_TYPE_KEYS) {
    const result = {};
    for (const key of keys) {
        if (normalized.dataTypes[key]) result[key] = true;
    }
    return result;
}

function buildStep(kind, normalized, keys, removalOptions) {
    const dataTypes = buildDataTypeSetFromNormalized(normalized, keys);
    if (Object.keys(dataTypes).length === 0) return null;
    const options = { ...removalOptions };
    if (kind === 'filterable' && normalized.preservedOrigins.length > 0) {
        options.excludeOrigins = [...normalized.preservedOrigins];
    }
    return { kind, dataTypes, options };
}

export function buildRemovalOptions(settings, now) {
    return buildRemovalOptionsFromNormalized(normalizeSettings(settings), now);
}

export function buildDataTypeSet(settings) {
    return buildDataTypeSetFromNormalized(normalizeSettings(settings));
}

export function requestedTypeNames(settings) {
    return Object.keys(buildDataTypeSet(settings));
}

export function buildRemovalPlan(settings, now) {
    const normalized = normalizeSettings(settings);
    const removalOptions = buildRemovalOptionsFromNormalized(normalized, now);
    const requestedTypes = Object.keys(
        buildDataTypeSetFromNormalized(normalized),
    );
    const preservedOriginCount = normalized.preservedOrigins.length;
    const steps = [];

    if (preservedOriginCount === 0) {
        const step = buildStep(
            'all',
            normalized,
            DATA_TYPE_KEYS,
            removalOptions,
        );
        if (step) steps.push(step);
    } else {
        const filterable = buildStep(
            'filterable',
            normalized,
            FILTERABLE_TYPES,
            removalOptions,
        );
        const global = buildStep(
            'global',
            normalized,
            GLOBAL_TYPES,
            removalOptions,
        );
        if (filterable) steps.push(filterable);
        if (global) steps.push(global);
    }

    return {
        requestedTypes,
        since: removalOptions.since,
        preservedOriginCount,
        steps,
    };
}
