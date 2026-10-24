import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const INDEX_HTML = readFileSync(
    new URL('./sentinel/index.html', import.meta.url),
    'utf8',
);
const DOWNLOAD_BODY = 'secure-close-download-sentinel\n';
const CACHE_CSS = '#history-sentinel { color: #174a7e; }\n';
const CACHE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#174a7e"/></svg>\n';

function send(response, statusCode, headers, body) {
    response.writeHead(statusCode, headers);
    response.end(body);
}

async function consumeRequest(request) {
    for await (const chunk of request) void chunk;
}

function formatHost(host) {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function createSentinelServer({ port = 0, host = '127.0.0.1' } = {}) {
    const server = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (
            url.pathname === '/sentinel' ||
            url.pathname === '/sentinel/' ||
            url.pathname === '/sentinel/history'
        ) {
            send(
                response,
                200,
                {
                    'Cache-Control': 'no-store',
                    'Content-Type': 'text/html; charset=utf-8',
                    'Set-Cookie':
                        'secure-close-sentinel=dummy-value; Path=/sentinel',
                    'X-Secure-Close-Sentinel': 'history,cookies,formData',
                },
                INDEX_HTML,
            );
            return;
        }
        if (url.pathname === '/sentinel/cache.css') {
            send(
                response,
                200,
                {
                    'Cache-Control': 'public, max-age=3600',
                    'Content-Type': 'text/css; charset=utf-8',
                    ETag: '"secure-close-cache-css-v1"',
                    'X-Secure-Close-Sentinel': 'cache',
                },
                CACHE_CSS,
            );
            return;
        }
        if (url.pathname === '/sentinel/cache.svg') {
            send(
                response,
                200,
                {
                    'Cache-Control': 'public, max-age=3600',
                    'Content-Type': 'image/svg+xml',
                    ETag: '"secure-close-cache-svg-v1"',
                    'X-Secure-Close-Sentinel': 'cache',
                },
                CACHE_SVG,
            );
            return;
        }
        if (url.pathname === '/sentinel/cache-entry') {
            send(
                response,
                200,
                {
                    'Cache-Control': 'public, max-age=3600',
                    'Content-Type': 'text/plain; charset=utf-8',
                    ETag: '"secure-close-cache-entry-v1"',
                    'X-Secure-Close-Sentinel': 'cacheStorage',
                },
                'dummy-cache-storage-value\n',
            );
            return;
        }
        if (url.pathname === '/sentinel/download') {
            send(
                response,
                200,
                {
                    'Cache-Control': 'no-store',
                    'Content-Disposition':
                        'attachment; filename="secure-close-download.txt"',
                    'Content-Length': Buffer.byteLength(DOWNLOAD_BODY),
                    'Content-Type': 'text/plain; charset=utf-8',
                    'X-Secure-Close-Sentinel': 'downloads',
                },
                DOWNLOAD_BODY,
            );
            return;
        }
        if (
            url.pathname === '/sentinel/form-submit' &&
            request.method === 'POST'
        ) {
            void consumeRequest(request)
                .then(() => {
                    send(
                        response,
                        200,
                        {
                            'Cache-Control': 'no-store',
                            'Content-Type': 'text/html; charset=utf-8',
                            'X-Secure-Close-Sentinel': 'formData',
                        },
                        '<!doctype html><p>form-data-sentinel-submitted</p><a href="/sentinel">Back</a>',
                    );
                })
                .catch(() =>
                    send(
                        response,
                        400,
                        { 'Content-Type': 'text/plain; charset=utf-8' },
                        'bad request',
                    ),
                );
            return;
        }
        send(
            response,
            404,
            { 'Content-Type': 'text/plain; charset=utf-8' },
            'not found',
        );
    });
    return {
        async start() {
            if (!server.listening) {
                await new Promise((resolve, reject) => {
                    const onError = (error) => reject(error);
                    server.once('error', onError);
                    server.listen({ port, host }, () => {
                        server.off('error', onError);
                        resolve();
                    });
                });
            }
            const address = server.address();
            const actualPort =
                typeof address === 'object' && address ? address.port : port;
            const origin = `http://${formatHost(host)}:${actualPort}`;
            return {
                origin,
                url: `${origin}/sentinel`,
                host,
                port: actualPort,
            };
        },
        async stop() {
            if (server.listening)
                await new Promise((resolve, reject) =>
                    server.close((error) =>
                        error ? reject(error) : resolve(),
                    ),
                );
        },
    };
}

export function createAcceptanceSentinelPair({
    port = 51730,
    ipv4Host = '127.0.0.1',
    ipv6Host = '::1',
    serverFactory = createSentinelServer,
} = {}) {
    const ipv4Server = serverFactory({ port, host: ipv4Host });
    const ipv6Server = serverFactory({ port, host: ipv6Host });
    let current = null;

    return {
        async start() {
            if (current) return current;
            try {
                const ipv4 = await ipv4Server.start();
                const ipv6 = await ipv6Server.start();
                if (ipv4.port !== port || ipv6.port !== port) {
                    throw new Error(
                        `Sentinel pair must bind the requested fixed port ${port}.`,
                    );
                }
                current = { ipv4, ipv6 };
                return current;
            } catch (error) {
                await Promise.allSettled([
                    ipv6Server.stop(),
                    ipv4Server.stop(),
                ]);
                current = null;
                throw error;
            }
        },
        async stop() {
            await Promise.allSettled([ipv6Server.stop(), ipv4Server.stop()]);
            current = null;
        },
    };
}
