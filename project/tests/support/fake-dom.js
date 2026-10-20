class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.dataset = {};
        this.attributes = new Map();
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.className = '';
        this.id = '';
    }

    append(child) {
        this.children.push(child);
    }
    replaceChildren(...children) {
        this.children = children;
    }
    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }
    dispatchEvent(event) {
        return this.listeners.get(event.type)?.(event);
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
        if (name.startsWith('data-'))
            this.dataset[name.slice(5)] = String(value);
    }
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
}

export class FakeDocument {
    constructor() {
        this.elements = [];
        this.byId = new Map();
    }
    createElement(tagName) {
        const element = new FakeElement(tagName);
        this.elements.push(element);
        return element;
    }
    addElement(id, tagName = 'div') {
        const element = this.createElement(tagName);
        element.id = id;
        this.byId.set(id, element);
        return element;
    }
    addTypeInput(type) {
        const element = this.createElement('input');
        element.dataset.type = type;
        element.type = 'checkbox';
        return element;
    }
    getElementById(id) {
        return this.byId.get(id) || null;
    }
    querySelectorAll(selector) {
        if (selector === '[data-type]')
            return this.elements.filter((element) => element.dataset.type);
        if (selector === '[data-preset]')
            return this.elements.filter((element) => element.dataset.preset);
        return [];
    }
}

export function createPopupDocument() {
    const documentRef = new FakeDocument();
    for (const id of [
        'run-close',
        'run-delete',
        'confirm-run',
        'cancel-run',
        'acknowledge',
        'since-mode',
        'confirm-before-run',
        'run-status',
        'status-label',
        'status-summary',
        'reason-list',
        'error-message',
        'message',
        'inline-confirm',
        'preset-label',
        'preserved-count',
        'edit-preserved',
    ])
        documentRef.addElement(id);
    for (const type of [
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
    ])
        documentRef.addTypeInput(type);
    for (const preset of ['safe', 'standard', 'complete']) {
        const button = documentRef.createElement('button');
        button.dataset.preset = preset;
    }
    documentRef.getElementById('since-mode').value = 'all';
    return documentRef;
}

export function createOptionsDocument() {
    const documentRef = new FakeDocument();
    for (const id of [
        'since-mode',
        'confirm-before-run',
        'reset',
        'run-status',
        'status-label',
        'status-summary',
        'reason-list',
        'error-message',
        'message',
        'origin-input',
        'add-origin',
        'origin-list',
        'preset-label',
    ])
        documentRef.addElement(id);
    for (const type of [
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
    ])
        documentRef.addTypeInput(type);
    for (const preset of ['safe', 'standard', 'complete']) {
        const button = documentRef.createElement('button');
        button.dataset.preset = preset;
    }
    documentRef.getElementById('since-mode').value = 'all';
    return documentRef;
}
