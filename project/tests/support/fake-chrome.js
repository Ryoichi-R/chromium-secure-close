function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createStorageArea(initial = {}) {
    const state = clone(initial);
    return {
        async get(keys) {
            if (typeof keys === 'string') return { [keys]: clone(state[keys]) };
            if (Array.isArray(keys))
                return Object.fromEntries(
                    keys.map((key) => [key, clone(state[key])]),
                );
            return clone(state);
        },
        async set(values) {
            Object.assign(state, clone(values));
        },
        snapshot() {
            return clone(state);
        },
    };
}

export function createFakeChrome({
    initialStorage = {},
    windows = [],
    removeWindow = null,
    removeBrowsingData = async () => undefined,
    currentWindowId = 1,
    openOptionsPage = null,
} = {}) {
    const storageLocal = createStorageArea(initialStorage);
    let windowList = windows.map((window) => ({ ...window }));
    let listener = null;
    const removed = [];
    const chromeApi = {
        runtime: {
            id: 'fake-extension-id',
            lastError: null,
            onMessage: {
                addListener(callback) {
                    listener = callback;
                },
            },
            sendMessage(message, callback) {
                if (!listener) throw new Error('No runtime listener');
                const sender = { id: 'fake-extension-id' };
                const result = listener(message, sender, callback);
                if (result !== true && callback) callback(undefined);
                return result;
            },
            openOptionsPage: openOptionsPage || (() => Promise.resolve()),
        },
        storage: { local: storageLocal },
        browsingData: {
            remove(options, dataTypes) {
                return removeBrowsingData(options, dataTypes);
            },
        },
        windows: {
            async getAll() {
                return windowList.map((window) => ({ ...window }));
            },
            async getCurrent() {
                return (
                    windowList.find(
                        (window) => window.id === currentWindowId,
                    ) || { id: currentWindowId, type: 'normal' }
                );
            },
            remove(id) {
                removed.push(id);
                if (removeWindow)
                    return removeWindow(id, {
                        windowList,
                        setWindows: (next) => {
                            windowList = next;
                        },
                    });
                windowList = windowList.filter((window) => window.id !== id);
                return Promise.resolve();
            },
        },
        action: { setBadgeText: async () => undefined },
    };
    return {
        chromeApi,
        storage: storageLocal,
        getWindows: () => windowList.map((window) => ({ ...window })),
        setWindows: (next) => {
            windowList = next.map((window) => ({ ...window }));
        },
        removed,
    };
}
