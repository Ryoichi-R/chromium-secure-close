import { createJournalStore } from './lib/run-state.js';
import { runSecureClose } from './lib/secure-close.js';

const RUN_KEYS = new Set(['type', 'mode', 'settings', 'initiatorWindowId']);
const ACK_KEYS = new Set(['type', 'operationId']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
    return (
        isPlainObject(value) && Object.keys(value).every((key) => keys.has(key))
    );
}

function isValidRunMessage(message) {
    if (!hasOnlyKeys(message, RUN_KEYS)) return false;
    if (message.type !== 'RUN_SECURE_CLOSE') return false;
    if (!['delete_only', 'delete_and_close'].includes(message.mode))
        return false;
    if (!isPlainObject(message.settings)) return false;
    if (message.mode === 'delete_only')
        return message.initiatorWindowId === null;
    return (
        Number.isInteger(message.initiatorWindowId) &&
        message.initiatorWindowId >= 0
    );
}

function isValidAckMessage(message) {
    return (
        hasOnlyKeys(message, ACK_KEYS) &&
        message.type === 'ACKNOWLEDGE_RECOVERY' &&
        typeof message.operationId === 'string' &&
        message.operationId.length > 0 &&
        message.operationId.length <= 128
    );
}

function safeSend(sendResponse, payload) {
    try {
        sendResponse(payload);
    } catch {
        // The last Chrome window may close the message channel before the response.
    }
}

export function createBackgroundHandler({ chromeApi, journal, clock } = {}) {
    const api = chromeApi || globalThis.chrome;
    const journalStore = journal || createJournalStore(api.storage.local);
    let inFlight = false;

    const listener = (message, sender, sendResponse) => {
        if (!sender || sender.id !== api.runtime.id) {
            safeSend(sendResponse, { ok: false, code: 'INVALID_REQUEST' });
            return false;
        }
        if (isValidAckMessage(message)) {
            if (inFlight) {
                safeSend(sendResponse, { ok: false, code: 'BUSY' });
                return false;
            }
            void journalStore
                .acknowledgeRecovery(message.operationId)
                .then((result) =>
                    safeSend(
                        sendResponse,
                        result.ok
                            ? result
                            : {
                                  ok: false,
                                  code: result.code,
                                  lastRun: result.lastRun,
                              },
                    ),
                )
                .catch((error) =>
                    safeSend(sendResponse, {
                        ok: false,
                        code: 'JOURNAL_FAILED',
                        message: String(error?.message || error),
                    }),
                );
            return true;
        }
        if (!isValidRunMessage(message)) {
            safeSend(sendResponse, { ok: false, code: 'INVALID_REQUEST' });
            return false;
        }
        if (inFlight) {
            safeSend(sendResponse, { ok: false, code: 'BUSY' });
            return false;
        }
        inFlight = true;
        void runSecureClose(
            {
                browsingData: api.browsingData,
                windows: api.windows,
                journal: journalStore,
            },
            message,
            clock,
        )
            .then((result) => safeSend(sendResponse, result))
            .catch((error) =>
                safeSend(sendResponse, {
                    ok: false,
                    code: 'UNEXPECTED_ERROR',
                    message: String(error?.message || error),
                }),
            )
            .finally(() => {
                inFlight = false;
            });
        return true;
    };

    return Object.freeze({ listener, isInFlight: () => inFlight });
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
    const chromeApi = globalThis.chrome;
    const journal = createJournalStore(chromeApi.storage.local);
    const handler = createBackgroundHandler({ chromeApi, journal });
    chromeApi.runtime.onMessage.addListener(handler.listener);
}
