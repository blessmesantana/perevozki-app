import { captureException, captureMessage } from './logger.js';

const DB_NAME = 'peredachkin-offline';
const DB_VERSION = 1;
const COLLECTION_STORE = 'collections';
const QUEUE_STORE = 'queues';
const PENDING_SCANS_KEY = 'pending_scans';
const LOCAL_STORAGE_PREFIX = 'offline_store_v1';

let dbPromise = null;
let indexedDbUnavailable = false;

function getCollectionStorageKey(path) {
    return `${LOCAL_STORAGE_PREFIX}:collection:${path}`;
}

function getQueueStorageKey(key) {
    return `${LOCAL_STORAGE_PREFIX}:queue:${key}`;
}

function cloneItems(items) {
    return Array.isArray(items)
        ? items.map((item) => ({ ...item }))
        : [];
}

function canUseIndexedDb() {
    return !indexedDbUnavailable && typeof indexedDB !== 'undefined';
}

function openDb() {
    if (!canUseIndexedDb()) {
        captureMessage('IndexedDB unavailable or disabled', { severity: 'info' });
        return Promise.resolve(null);
    }

    if (!dbPromise) {
        dbPromise = new Promise((resolve) => {
            try {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = () => {
                    const db = request.result;

                    if (!db.objectStoreNames.contains(COLLECTION_STORE)) {
                        db.createObjectStore(COLLECTION_STORE, {
                            keyPath: 'path',
                        });
                    }

                    if (!db.objectStoreNames.contains(QUEUE_STORE)) {
                        db.createObjectStore(QUEUE_STORE, {
                            keyPath: 'key',
                        });
                    }
                };

                request.onsuccess = () => {
                    captureMessage('IndexedDB opened successfully', { severity: 'debug' });
                    resolve(request.result);
                };

                request.onerror = () => {
                    const error = request.error;
                    indexedDbUnavailable = true;
                    
                    if (error?.name === 'QuotaExceededError') {
                        captureException(error, {
                            operation: 'indexeddb_open',
                            errorType: 'quota_exceeded',
                        });
                    } else {
                        captureException(error, {
                            operation: 'indexeddb_open',
                            errorType: error?.name || 'unknown',
                        });
                    }
                    
                    resolve(null);
                };
            } catch (error) {
                indexedDbUnavailable = true;
                captureException(error, {
                    operation: 'indexeddb_open',
                    errorType: 'exception',
                });
                resolve(null);
            }
        });
    }

    return dbPromise;
}

function runTransaction(storeName, mode, executor) {
    return openDb().then((db) => {
        if (!db) {
            captureMessage('Database not available for transaction', { 
                severity: 'warning',
                storeName,
                mode,
            });
            return null;
        }

        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, mode);
                const store = transaction.objectStore(storeName);
                const request = executor(store);

                transaction.oncomplete = () => {
                    resolve(request?.result ?? null);
                };
                
                transaction.onerror = () => {
                    const error = transaction.error;
                    if (error?.name === 'QuotaExceededError') {
                        captureException(error, {
                            operation: 'indexeddb_transaction',
                            storeName,
                            mode,
                            errorType: 'quota_exceeded',
                        });
                    } else {
                        captureException(error, {
                            operation: 'indexeddb_transaction',
                            storeName,
                            mode,
                            errorType: error?.name || 'unknown',
                        });
                    }
                    reject(error);
                };
                
                transaction.onabort = () => {
                    const error = transaction.error;
                    captureMessage('IndexedDB transaction aborted', {
                        severity: 'warning',
                        storeName,
                        errorType: error?.name || 'unknown',
                    });
                    reject(error);
                };
            } catch (error) {
                captureException(error, {
                    operation: 'indexeddb_transaction_setup',
                    storeName,
                    mode,
                });
                reject(error);
            }
        }).catch((error) => {
            // Fallback gracefully - don't propagate IndexedDB errors
            // This allows app to continue with localStorage fallback
            return null;
        });
    });
}

function readLocalStorageJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);

        if (!raw) {
            return fallback;
        }

        return JSON.parse(raw);
    } catch (error) {
        captureMessage('LocalStorage read failed', {
            severity: 'warning',
            key,
            errorType: error?.name || 'parse_error',
        });
        return fallback;
    }
}

function writeLocalStorageJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        if (error?.name === 'QuotaExceededError') {
            captureException(error, {
                operation: 'localStorage_write',
                errorType: 'quota_exceeded',
                key,
            });
        } else {
            captureMessage('LocalStorage write failed', {
                severity: 'warning',
                key,
                errorType: error?.name || 'write_error',
            });
        }
    }
}

export async function readOfflineCollectionSnapshot(path) {
    const record = await runTransaction(COLLECTION_STORE, 'readonly', (store) => {
        return store.get(path);
    });

    if (record?.items) {
        return cloneItems(record.items);
    }

    const fallback = readLocalStorageJson(getCollectionStorageKey(path), null);
    return fallback?.items ? cloneItems(fallback.items) : null;
}

export async function writeOfflineCollectionSnapshot(path, items) {
    const payload = {
        items: cloneItems(items),
        path,
        updatedAt: Date.now(),
    };

    writeLocalStorageJson(getCollectionStorageKey(path), payload);

    await runTransaction(COLLECTION_STORE, 'readwrite', (store) => {
        return store.put(payload);
    });
}

export async function readPendingOfflineScans() {
    const record = await runTransaction(QUEUE_STORE, 'readonly', (store) => {
        return store.get(PENDING_SCANS_KEY);
    });

    if (record?.items) {
        return cloneItems(record.items);
    }

    const fallback = readLocalStorageJson(getQueueStorageKey(PENDING_SCANS_KEY), null);
    return fallback?.items ? cloneItems(fallback.items) : [];
}

export async function writePendingOfflineScans(items) {
    const payload = {
        items: cloneItems(items),
        key: PENDING_SCANS_KEY,
        updatedAt: Date.now(),
    };

    writeLocalStorageJson(getQueueStorageKey(PENDING_SCANS_KEY), payload);

    await runTransaction(QUEUE_STORE, 'readwrite', (store) => {
        return store.put(payload);
    });
}
