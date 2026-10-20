import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    DATA_TYPE_KEYS,
    PRESET_DATA_TYPES,
    applyPreset,
    detectPreset,
    hasSelectedDataTypes,
    normalizeOrigin,
    normalizePreservedOrigins,
    normalizeSettings,
    selectedDataTypeCount,
} from '../../extension/lib/settings.js';

describe('settings', () => {
    it('returns an independent v2 default-shaped snapshot', () => {
        const first = normalizeSettings();
        first.dataTypes.history = false;
        first.preservedOrigins.push('https://example.com');
        expect(normalizeSettings()).toEqual(DEFAULT_SETTINGS);
        expect(Object.keys(first.dataTypes)).toEqual(DATA_TYPE_KEYS);
        expect(DEFAULT_SETTINGS.schemaVersion).toBe(2);
        expect(DEFAULT_SETTINGS.confirmBeforeRun).toBe(true);
    });

    it('preserves valid known fields while dropping unknown and invalid values', () => {
        const result = normalizeSettings({
            schemaVersion: 99,
            closeWindows: true,
            passwords: true,
            dataTypes: { history: false, passwords: true, cache: 'yes' },
            sinceMode: 'invalid',
            confirmBeforeRun: 'yes',
            preservedOrigins: ['HTTPS://Example.COM', 'https://example.com'],
        });
        expect(result).toEqual({
            schemaVersion: 2,
            dataTypes: {
                history: false,
                cache: true,
                cookies: true,
                downloads: true,
                formData: true,
                cacheStorage: false,
                localStorage: false,
                indexedDB: false,
                serviceWorkers: false,
                fileSystems: false,
            },
            sinceMode: 'all',
            confirmBeforeRun: true,
            preservedOrigins: ['https://example.com'],
        });
    });

    it('normalizes v1 and unknown versions field by field', () => {
        const result = normalizeSettings({
            schemaVersion: 1,
            dataTypes: { history: false },
            sinceMode: 'day',
            confirmBeforeRun: false,
        });
        expect(result.schemaVersion).toBe(2);
        expect(result.dataTypes.history).toBe(false);
        expect(result.sinceMode).toBe('day');
        expect(result.confirmBeforeRun).toBe(false);
        expect(result.preservedOrigins).toEqual([]);
    });

    it('applies exact presets without changing non-data settings', () => {
        const original = normalizeSettings({
            sinceMode: 'week',
            confirmBeforeRun: false,
            preservedOrigins: ['https://github.com'],
        });
        for (const presetId of ['safe', 'standard', 'complete']) {
            const result = applyPreset(original, presetId);
            expect(result.dataTypes).toEqual(PRESET_DATA_TYPES[presetId]);
            expect(result.sinceMode).toBe('week');
            expect(result.confirmBeforeRun).toBe(false);
            expect(result.preservedOrigins).toEqual(['https://github.com']);
        }
        expect(original.dataTypes).not.toEqual(PRESET_DATA_TYPES.complete);
        expect(detectPreset(PRESET_DATA_TYPES.safe)).toBe('safe');
        expect(detectPreset(PRESET_DATA_TYPES.standard)).toBe('standard');
        expect(detectPreset(PRESET_DATA_TYPES.complete)).toBe('complete');
        expect(
            detectPreset({ ...PRESET_DATA_TYPES.standard, cache: false }),
        ).toBe('custom');
        expect(() => applyPreset(original, 'custom')).toThrow(
            /未知のプリセット/,
        );
    });

    it('normalizes secure origins and rejects unsafe forms', () => {
        expect(normalizeOrigin('HTTPS://Example.COM')).toBe(
            'https://example.com',
        );
        expect(normalizeOrigin('https://例え.テスト')).toMatch(
            /^https:\/\/xn--/,
        );
        expect(normalizeOrigin('http://localhost')).toBe('http://localhost');
        expect(normalizeOrigin('http://127.0.0.1:51730')).toBe(
            'http://127.0.0.1:51730',
        );
        expect(normalizeOrigin('http://[::1]:51730')).toBe(
            'http://[::1]:51730',
        );
        for (const value of [
            '',
            'example.com',
            'http://example.com',
            'https://user:pass@example.com',
            'https://example.com/path',
            'https://example.com/?q=1',
            'https://example.com/#fragment',
            'file:///tmp/example',
            'chrome://settings',
            'brave://settings',
            'chrome-extension://example/options.html',
            'data:text/plain,example',
            'javascript:void(0)',
        ]) {
            expect(() => normalizeOrigin(value)).toThrow();
        }
    });

    it('normalizes, sorts, deduplicates, and safely rejects invalid stored lists', () => {
        expect(
            normalizePreservedOrigins([
                'https://z.example',
                'https://a.example',
                'https://z.example',
            ]),
        ).toEqual(['https://a.example', 'https://z.example']);
        expect(normalizePreservedOrigins('not-an-array')).toEqual([]);
        expect(normalizePreservedOrigins(['https://example.com/path'])).toEqual(
            [],
        );
        expect(
            normalizePreservedOrigins(
                Array.from(
                    { length: 100 },
                    (_, index) => `https://site-${index}.example`,
                ),
            ),
        ).toHaveLength(100);
        expect(
            normalizePreservedOrigins(
                Array.from(
                    { length: 101 },
                    (_, index) => `https://site-${index}.example`,
                ),
            ),
        ).toEqual([]);
    });

    it('recognizes the zero-selection state', () => {
        const settings = normalizeSettings({
            dataTypes: Object.fromEntries(
                DATA_TYPE_KEYS.map((key) => [key, false]),
            ),
        });
        expect(hasSelectedDataTypes(settings)).toBe(false);
        expect(selectedDataTypeCount(settings)).toBe(0);
    });
});
