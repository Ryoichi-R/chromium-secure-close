import { describe, expect, it } from 'vitest';
import {
    FILTERABLE_TYPES,
    GLOBAL_TYPES,
    buildDataTypeSet,
    buildRemovalOptions,
    buildRemovalPlan,
    requestedTypeNames,
} from '../../extension/lib/cleaner.js';
import { DATA_TYPE_KEYS } from '../../extension/lib/settings.js';

function selectedTypes(...selected) {
    return Object.fromEntries(
        DATA_TYPE_KEYS.map((key) => [key, selected.includes(key)]),
    );
}

describe('cleaner', () => {
    it('builds an all-time removal request with only selected known types', () => {
        const settings = {
            dataTypes: { history: true, cookies: false, passwords: true },
            sinceMode: 'all',
        };
        expect(buildRemovalOptions(settings, 1000)).toEqual({
            since: 0,
            originTypes: { unprotectedWeb: true },
        });
        expect(buildDataTypeSet(settings)).toEqual({
            history: true,
            cache: true,
            downloads: true,
            formData: true,
        });
        expect(
            requestedTypeNames({
                dataTypes: { history: true, cookies: false },
            }),
        ).toEqual(['history', 'cache', 'downloads', 'formData']);
    });

    it.each([
        ['hour', 3_600_000],
        ['day', 86_400_000],
        ['week', 604_800_000],
    ])('calculates since for %s', (mode, duration) => {
        expect(
            buildRemovalOptions({ sinceMode: mode }, duration + 123).since,
        ).toBe(123);
    });

    it('rejects invalid clocks', () => {
        expect(() => buildRemovalOptions({}, -1)).toThrow(/non-negative/);
        expect(() => buildRemovalOptions({}, Number.NaN)).toThrow(/finite/);
    });

    it('covers all data types exactly once', () => {
        expect([...FILTERABLE_TYPES, ...GLOBAL_TYPES].sort()).toEqual([
            'cache',
            'cacheStorage',
            'cookies',
            'downloads',
            'fileSystems',
            'formData',
            'history',
            'indexedDB',
            'localStorage',
            'serviceWorkers',
        ]);
    });

    it('uses one compatible step when there are no preserved origins', () => {
        const plan = buildRemovalPlan(
            {
                dataTypes: { history: true, cookies: true },
                preservedOrigins: [],
            },
            1000,
        );
        expect(plan.requestedTypes).toEqual([
            'history',
            'cache',
            'cookies',
            'downloads',
            'formData',
        ]);
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0].kind).toBe('all');
        expect(plan.steps[0].options).not.toHaveProperty('excludeOrigins');
    });

    it('splits filterable and global types and applies exclusions only to filterable data', () => {
        const plan = buildRemovalPlan(
            {
                dataTypes: selectedTypes(
                    'history',
                    'cookies',
                    'localStorage',
                    'formData',
                ),
                preservedOrigins: ['https://github.com'],
                sinceMode: 'day',
            },
            86_400_123,
        );
        expect(plan.preservedOriginCount).toBe(1);
        expect(plan.steps.map((step) => step.kind)).toEqual([
            'filterable',
            'global',
        ]);
        expect(plan.steps[0].dataTypes).toEqual({
            cookies: true,
            localStorage: true,
        });
        expect(plan.steps[0].options.excludeOrigins).toEqual([
            'https://github.com',
        ]);
        expect(plan.steps[1].dataTypes).toEqual({
            history: true,
            formData: true,
        });
        expect(plan.steps[1].options).not.toHaveProperty('excludeOrigins');
        expect(
            plan.steps.every(
                (step) =>
                    JSON.stringify(step.options.originTypes) ===
                    JSON.stringify({ unprotectedWeb: true }),
            ),
        ).toBe(true);
        expect(
            plan.steps.every(
                (step) =>
                    !Object.hasOwn(step.options.originTypes, 'protectedWeb'),
            ),
        ).toBe(true);
        expect(
            plan.steps.every(
                (step) => !Object.hasOwn(step.options.originTypes, 'extension'),
            ),
        ).toBe(true);
    });

    it('does not create empty steps when only one group is selected', () => {
        const filterOnly = buildRemovalPlan(
            {
                dataTypes: selectedTypes('cookies'),
                preservedOrigins: ['https://example.com'],
            },
            1000,
        );
        const globalOnly = buildRemovalPlan(
            {
                dataTypes: selectedTypes('history'),
                preservedOrigins: ['https://example.com'],
            },
            1000,
        );
        expect(filterOnly.steps.map((step) => step.kind)).toEqual([
            'filterable',
        ]);
        expect(globalOnly.steps.map((step) => step.kind)).toEqual(['global']);
    });
});
