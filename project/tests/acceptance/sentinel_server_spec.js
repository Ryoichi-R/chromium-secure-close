import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
    createAcceptanceSentinelPair,
    createSentinelServer,
} from './sentinel-server.mjs';

function requestText(url, method = 'GET') {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { method }, (response) => {
            const chunks = [];
            response.setEncoding('utf8');
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
                resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body: chunks.join(''),
                }),
            );
        });
        request.on('error', reject);
        request.end();
    });
}

describe('acceptance sentinel server', () => {
    it('serves deterministic history, cookie, form, cache, and download sentinels', async () => {
        const sentinel = createSentinelServer();
        const started = await sentinel.start();
        const baseUrl = started.url;
        try {
            expect(started).toMatchObject({
                host: '127.0.0.1',
                port: expect.any(Number),
                origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
            });
            const page = await requestText(baseUrl);
            expect(page.statusCode).toBe(200);
            expect(page.headers['set-cookie']?.[0]).toContain(
                'secure-close-sentinel=dummy-value',
            );
            expect(page.headers['x-secure-close-sentinel']).toBe(
                'history,cookies,formData',
            );
            expect(page.body).toContain('secure-close-form');

            const cache = await requestText(
                new URL('/sentinel/cache.css', baseUrl),
            );
            expect(cache.statusCode).toBe(200);
            expect(cache.headers['cache-control']).toContain('max-age=3600');
            expect(cache.headers['x-secure-close-sentinel']).toBe('cache');

            const cacheEntry = await requestText(
                new URL('/sentinel/cache-entry', baseUrl),
            );
            expect(cacheEntry.statusCode).toBe(200);
            expect(cacheEntry.headers['x-secure-close-sentinel']).toBe(
                'cacheStorage',
            );
            expect(cacheEntry.body).toContain('dummy-cache-storage-value');

            const download = await requestText(
                new URL('/sentinel/download', baseUrl),
            );
            expect(download.statusCode).toBe(200);
            expect(download.headers['content-disposition']).toContain(
                'secure-close-download.txt',
            );
            expect(download.headers['x-secure-close-sentinel']).toBe(
                'downloads',
            );
            expect(download.body).toContain('secure-close-download-sentinel');
        } finally {
            await sentinel.stop();
        }
    });

    it('binds the fixed acceptance port on IPv4 and IPv6 with structured endpoints', async () => {
        const pair = createAcceptanceSentinelPair({ port: 51730 });
        const started = await pair.start();
        try {
            expect(started.ipv4).toEqual({
                origin: 'http://127.0.0.1:51730',
                url: 'http://127.0.0.1:51730/sentinel',
                host: '127.0.0.1',
                port: 51730,
            });
            expect(started.ipv6).toEqual({
                origin: 'http://[::1]:51730',
                url: 'http://[::1]:51730/sentinel',
                host: '::1',
                port: 51730,
            });
            await expect(requestText(started.ipv4.url)).resolves.toMatchObject({
                statusCode: 200,
            });
            await expect(requestText(started.ipv6.url)).resolves.toMatchObject({
                statusCode: 200,
            });
        } finally {
            await pair.stop();
        }
    });

    it('stops the IPv4 listener when the IPv6 bind fails', async () => {
        const blocker = createSentinelServer({ port: 51731, host: '::1' });
        const pair = createAcceptanceSentinelPair({ port: 51731 });
        await blocker.start();
        try {
            await expect(pair.start()).rejects.toMatchObject({
                code: 'EADDRINUSE',
            });
            const probe = createSentinelServer({
                port: 51731,
                host: '127.0.0.1',
            });
            try {
                await expect(probe.start()).resolves.toMatchObject({
                    host: '127.0.0.1',
                    port: 51731,
                });
            } finally {
                await probe.stop();
            }
        } finally {
            await pair.stop();
            await blocker.stop();
        }
    });
});
