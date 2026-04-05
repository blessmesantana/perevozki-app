import { database } from './firebase.js';
import {
    normalizeDeliveryId,
    parseTransferId,
} from './deliveries.js';
import { captureException } from './logger.js';
import {
    readOfflineCollectionSnapshot,
    readPendingOfflineScans,
    writeOfflineCollectionSnapshot,
    writePendingOfflineScans,
} from './offline-store.js';
import {
    get,
    onValue,
    push,
    query,
    ref,
    set,
    update,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

const collectionCache = new Map();
const collectionVersions = new Map();
const collectionIndexes = new Map();
const EMPTY_COLLECTION = Object.freeze([]);
const DELIVERY_SHORT_ID_LENGTH = 4;
const OFFLINE_SUPPORTED_COLLECTIONS = new Set(['couriers', 'deliveries', 'scans']);
let pendingOfflineScansCache = null;
let pendingOfflineScansPromise = null;

function normalizeCourierName(value) {
    return String(value || '').trim().toLocaleLowerCase('ru-RU');
}

function supportsOfflineSnapshot(path) {
    return OFFLINE_SUPPORTED_COLLECTIONS.has(path);
}

function cloneItem(record) {
    return record ? { ...record } : record;
}

function createOfflineScanKey(timestamp = Date.now()) {
    return `offline:${timestamp}:${Math.random().toString(36).slice(2, 10)}`;
}

function isConnectivityError(error) {
    if (!navigator.onLine) {
        return true;
    }

    const fingerprint = `${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`
        .toLowerCase();

    return (
        fingerprint.includes('network')
        || fingerprint.includes('offline')
        || fingerprint.includes('unavailable')
        || fingerprint.includes('fetch')
    );
}

function withTimeout(promise, timeoutMs = 5000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
        ),
    ]);
}

async function getPendingOfflineScansQueue() {
    if (Array.isArray(pendingOfflineScansCache)) {
        return pendingOfflineScansCache;
    }

    if (!pendingOfflineScansPromise) {
        pendingOfflineScansPromise = readPendingOfflineScans()
            .then((items) => {
                pendingOfflineScansCache = Array.isArray(items) ? items : [];
                return pendingOfflineScansCache;
            })
            .catch(() => {
                pendingOfflineScansCache = [];
                return pendingOfflineScansCache;
            })
            .finally(() => {
                pendingOfflineScansPromise = null;
            });
    }

    return pendingOfflineScansPromise;
}

async function persistPendingOfflineScansQueue(items) {
    pendingOfflineScansCache = Array.isArray(items)
        ? items.map((item) => cloneItem(item))
        : [];
    await writePendingOfflineScans(pendingOfflineScansCache);
}

function mergePendingOfflineScans(items, pendingScans) {
    if (!Array.isArray(pendingScans) || pendingScans.length === 0) {
        return Array.isArray(items) ? items.map((item) => cloneItem(item)) : [];
    }

    const merged = Array.isArray(items) ? items.map((item) => cloneItem(item)) : [];
    const seenKeys = new Set(merged.map((item) => item?.key).filter(Boolean));

    pendingScans.forEach((scan) => {
        if (!scan || seenKeys.has(scan.key)) {
            return;
        }

        merged.push(cloneItem(scan));
        seenKeys.add(scan.key);
    });

    return merged;
}

async function withOfflineSnapshot(path, items) {
    if (path !== 'scans') {
        return Array.isArray(items) ? items : [];
    }

    return mergePendingOfflineScans(items, await getPendingOfflineScansQueue());
}

function persistCollectionSnapshot(path, items) {
    if (!supportsOfflineSnapshot(path)) {
        return;
    }

    void writeOfflineCollectionSnapshot(path, items).catch(() => {});
}

function snapshotToArray(snapshot) {
    const items = [];

    if (!snapshot.exists()) {
        return items;
    }

    snapshot.forEach((childSnapshot) => {
        const value = childSnapshot.val();

        items.push({
            key: childSnapshot.key,
            ...value,
        });
    });

    return items;
}

function freezeRecord(record) {
    return Object.freeze({ ...record });
}

function freezeCollection(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return EMPTY_COLLECTION;
    }

    return Object.freeze(items.map((item) => freezeRecord(item)));
}

function freezeBuckets(sourceMap) {
    const frozenMap = new Map();

    sourceMap.forEach((bucket, key) => {
        frozenMap.set(key, Object.freeze([...bucket]));
    });

    return frozenMap;
}

function buildCollectionIndexes(path, items, version) {
    if (path === 'deliveries') {
        const byNormalizedId = new Map();
        const byShortId = new Map();

        items.forEach((delivery) => {
            const normalizedId = normalizeDeliveryId(delivery?.id);

            if (!normalizedId) {
                return;
            }

            const exactBucket = byNormalizedId.get(normalizedId) || [];
            exactBucket.push(delivery);
            byNormalizedId.set(normalizedId, exactBucket);

            const shortId = normalizedId.slice(-DELIVERY_SHORT_ID_LENGTH);
            const shortBucket = byShortId.get(shortId) || [];
            shortBucket.push(delivery);
            byShortId.set(shortId, shortBucket);
        });

        return {
            byNormalizedId: freezeBuckets(byNormalizedId),
            byShortId: freezeBuckets(byShortId),
            version,
        };
    }

    if (path === 'scans') {
        const byDeliveryId = new Map();

        items.forEach((scan) => {
            const normalizedId = normalizeDeliveryId(scan?.delivery_id);

            if (!normalizedId || byDeliveryId.has(normalizedId)) {
                return;
            }

            byDeliveryId.set(normalizedId, scan);
        });

        return {
            byDeliveryId,
            version,
        };
    }

    return {
        version,
    };
}

function setCollectionData(path, items, version) {
    const frozenItems = freezeCollection(items);

    collectionVersions.set(path, version);
    collectionCache.set(path, {
        data: frozenItems,
        version,
    });
    collectionIndexes.set(path, buildCollectionIndexes(path, frozenItems, version));
    persistCollectionSnapshot(path, frozenItems);

    return frozenItems;
}

function uniquePaths(paths) {
    return [...new Set(paths.filter(Boolean))];
}

function getCollectionVersion(path) {
    return collectionVersions.get(path) || 0;
}

function prefetchCollections(paths) {
    uniquePaths(paths).forEach((path) => {
        void getCollection(path).catch(() => {
            collectionCache.delete(path);
            collectionIndexes.delete(path);
        });
    });
}

function invalidateCollections(paths, options = {}) {
    const normalizedPaths = uniquePaths(paths);

    normalizedPaths.forEach((path) => {
        collectionVersions.set(path, getCollectionVersion(path) + 1);
        collectionCache.delete(path);
        collectionIndexes.delete(path);
    });

    if (options.prefetch) {
        prefetchCollections(normalizedPaths);
    }
}

function appendCollectionItems(path, items) {
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    const cachedItems = collectionCache.get(path)?.data || EMPTY_COLLECTION;
    const nextVersion = getCollectionVersion(path) + 1;

    setCollectionData(path, [...cachedItems, ...items], nextVersion);
}

function replaceCollectionItems(path, transform) {
    const cachedItems = collectionCache.get(path)?.data || EMPTY_COLLECTION;
    const nextVersion = getCollectionVersion(path) + 1;
    const nextItems = transform([...cachedItems]);

    return setCollectionData(path, nextItems, nextVersion);
}

async function getCollection(path) {
    const cachedEntry = collectionCache.get(path);
    const currentVersion = getCollectionVersion(path);

    if (cachedEntry?.data && cachedEntry.version === currentVersion) {
        return cachedEntry.data;
    }

    if (cachedEntry?.promise && cachedEntry.version === currentVersion) {
        return cachedEntry.promise;
    }

    const requestVersion = currentVersion;
    const loadPromise = (async () => {
        let lastError = null;

        try {
            const timeoutDuration = !navigator.onLine ? 5000 : 10000;
            const snapshot = await withTimeout(
                get(query(ref(database, path))),
                timeoutDuration,
            );
            const items = await withOfflineSnapshot(path, snapshotToArray(snapshot));

            if (getCollectionVersion(path) === requestVersion) {
                return setCollectionData(path, items, requestVersion);
            }

            return freezeCollection(items);
        } catch (error) {
            lastError = error;

            if (supportsOfflineSnapshot(path)) {
                try {
                    const offlineItems = await withOfflineSnapshot(
                        path,
                        await readOfflineCollectionSnapshot(path),
                    );

                    if (offlineItems && offlineItems.length > 0) {
                        if (getCollectionVersion(path) === requestVersion) {
                            return setCollectionData(path, offlineItems, requestVersion);
                        }

                        return freezeCollection(offlineItems);
                    }
                } catch (offlineError) {
                    // Continue to throw the original error
                }
            }

            throw lastError;
        }
    })();

    collectionCache.set(path, { promise: loadPromise, version: requestVersion });

    try {
        return await loadPromise;
    } catch (error) {
        // For offline-supported collections, try fallback before clearing cache
        if (supportsOfflineSnapshot(path)) {
            try {
                const fallbackItems = await readOfflineCollectionSnapshot(path);
                if (fallbackItems && fallbackItems.length > 0) {
                    return freezeCollection(fallbackItems);
                }
            } catch (fallbackError) {
                // Continue with cache deletion
            }
        }

        collectionCache.delete(path);
        collectionIndexes.delete(path);
        throw error;
    }
}

async function getCollectionIndex(path) {
    const currentVersion = getCollectionVersion(path);
    const cachedIndex = collectionIndexes.get(path);

    if (cachedIndex?.version === currentVersion) {
        return cachedIndex;
    }

    await getCollection(path);

    return (
        collectionIndexes.get(path)
        || buildCollectionIndexes(path, EMPTY_COLLECTION, getCollectionVersion(path))
    );
}

async function removePaths(paths) {
    const updates = {};

    paths.forEach((path) => {
        updates[path] = null;
    });

    if (Object.keys(updates).length === 0) {
        return;
    }

    await update(ref(database), updates);
}

export async function getCouriers() {
    return getCollection('couriers');
}

export async function getDeliveries() {
    return getCollection('deliveries');
}

export async function getScans() {
    return getCollection('scans');
}

export async function preloadCollections() {
    if (!navigator.onLine) {
        console.log('Offline: skipping preload, will use cached data');
        return;
    }

    try {
        console.log('Preloading collections for offline support...');
        await Promise.all([
            getCollection('couriers'),
            getCollection('deliveries'),
            getCollection('scans'),
        ]);
        console.log('Collections preloaded successfully');
    } catch (error) {
        console.warn('Failed to preload collections:', error);
        // Not critical - will use cache when needed
    }
}

export async function getTelemetryEvents() {
    const items = await getCollection('telemetry_events');
    return [...items].sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));
}

export async function findMatchingDeliveriesByTransferId(rawTransferId) {
    const parsedTransferId = parseTransferId(rawTransferId);

    if (!parsedTransferId.cleanedId) {
        return {
            ...parsedTransferId,
            matches: EMPTY_COLLECTION,
        };
    }

    const deliveryIndex = await getCollectionIndex('deliveries');
    let matches = parsedTransferId.isShort
        ? deliveryIndex.byShortId?.get(parsedTransferId.cleanedId) || EMPTY_COLLECTION
        : deliveryIndex.byNormalizedId?.get(parsedTransferId.cleanedId) || EMPTY_COLLECTION;

    // Fallback: if no matches in index, search directly in collection
    if (matches.length === 0) {
        try {
            const allDeliveries = await getCollection('deliveries');
            matches = allDeliveries.filter((delivery) => {
                if (parsedTransferId.isShort) {
                    return normalizeDeliveryId(delivery.id)?.endsWith(parsedTransferId.cleanedId);
                }
                return normalizeDeliveryId(delivery.id) === parsedTransferId.cleanedId;
            });
        } catch (error) {
            console.warn('Fallback delivery search failed:', error);
        }
    }

    return {
        ...parsedTransferId,
        matches,
    };
}

export async function findScanByDeliveryId(deliveryId) {
    const normalizedId = normalizeDeliveryId(deliveryId);

    if (!normalizedId) {
        return null;
    }

    const scanIndex = await getCollectionIndex('scans');
    return scanIndex.byDeliveryId?.get(normalizedId) || null;
}

function subscribeCollection(path, onData, onError = null) {
    const collectionRef = ref(database, path);

    return onValue(
        collectionRef,
        async (snapshot) => {
            const items = await withOfflineSnapshot(path, snapshotToArray(snapshot));
            const nextVersion = getCollectionVersion(path) + 1;
            const frozenItems = setCollectionData(path, items, nextVersion);

            onData(frozenItems);
        },
        async (error) => {
            captureException(error, {
                operation: 'subscribe_collection',
                path,
                tags: {
                    scope: 'firebase',
                },
            });

            if (supportsOfflineSnapshot(path)) {
                const offlineItems = await withOfflineSnapshot(
                    path,
                    await readOfflineCollectionSnapshot(path),
                );

                const nextVersion = getCollectionVersion(path) + 1;
                onData(setCollectionData(path, offlineItems, nextVersion));
            }

            if (typeof onError === 'function') {
                onError(error);
            } else {
                console.error(`Subscription error for "${path}":`, error);
            }
        },
    );
}

export function subscribeCouriers(onData, onError = null) {
    return subscribeCollection('couriers', onData, onError);
}

export function subscribeDeliveries(onData, onError = null) {
    return subscribeCollection('deliveries', onData, onError);
}

export function subscribeScans(onData, onError = null) {
    return subscribeCollection('scans', onData, onError);
}

export function subscribeTelemetryEvents(onData, onError = null) {
    return subscribeCollection(
        'telemetry_events',
        (items) => {
            onData(
                [...items].sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0)),
            );
        },
        onError,
    );
}

export async function warmAdminData() {
    await Promise.all([
        getCollection('couriers'),
        getCollection('deliveries'),
        getCollection('scans'),
    ]);
}

export async function saveCourier(courierName) {
    const courierRef = push(ref(database, 'couriers'));
    const record = {
        name: courierName,
        timestamp: Date.now(),
    };
    const savedCourier = {
        key: courierRef.key,
        ...record,
    };

    await set(courierRef, record);
    appendCollectionItems('couriers', [savedCourier]);

    return savedCourier;
}

export async function saveDeliveries(courierId, courierName, deliveryIds) {
    const savedDeliveries = [];

    for (const deliveryId of deliveryIds) {
        if (!deliveryId) {
            continue;
        }

        const deliveryRef = push(ref(database, 'deliveries'));
        const record = {
            id: deliveryId,
            courier_id: courierId,
            courier_name: courierName,
            timestamp: Date.now(),
        };
        const savedDelivery = {
            key: deliveryRef.key,
            ...record,
        };

        await set(deliveryRef, record);
        savedDeliveries.push(savedDelivery);
    }

    appendCollectionItems('deliveries', savedDeliveries);

    return savedDeliveries;
}

async function queueOfflineScan(deliveryId, courierName, timestamp = Date.now()) {
    const pendingScans = await getPendingOfflineScansQueue();
    const offlineScan = {
        courier_name: courierName,
        delivery_id: deliveryId,
        key: createOfflineScanKey(timestamp),
        offlineQueued: true,
        timestamp,
    };

    await persistPendingOfflineScansQueue([...pendingScans, offlineScan]);
    appendCollectionItems('scans', [offlineScan]);

    return offlineScan;
}

export async function saveScan(deliveryId, courierName, timestamp = Date.now()) {
    if (!navigator.onLine) {
        return queueOfflineScan(deliveryId, courierName, timestamp);
    }

    const scanRef = push(ref(database, 'scans'));
    const record = {
        delivery_id: deliveryId,
        courier_name: courierName,
        timestamp,
    };
    const savedScan = {
        key: scanRef.key,
        ...record,
    };

    try {
        await set(scanRef, record);
        appendCollectionItems('scans', [savedScan]);
        return savedScan;
    } catch (error) {
        if (!isConnectivityError(error)) {
            throw error;
        }

        return queueOfflineScan(deliveryId, courierName, timestamp);
    }
}

export async function getPendingOfflineScanCount() {
    return (await getPendingOfflineScansQueue()).length;
}

export async function flushPendingScans() {
    const pendingScans = await getPendingOfflineScansQueue();

    if (pendingScans.length === 0 || !navigator.onLine) {
        return {
            flushedCount: 0,
            pendingCount: pendingScans.length,
        };
    }

    let flushedCount = 0;
    const remaining = [...pendingScans];

    while (remaining.length > 0) {
        const pendingScan = remaining[0];
        const scanRef = push(ref(database, 'scans'));
        const record = {
            courier_name: pendingScan.courier_name,
            delivery_id: pendingScan.delivery_id,
            timestamp: pendingScan.timestamp || Date.now(),
        };
        const syncedScan = {
            key: scanRef.key,
            ...record,
        };

        try {
            await set(scanRef, record);
            remaining.shift();
            flushedCount += 1;
            await persistPendingOfflineScansQueue(remaining);
            replaceCollectionItems('scans', (items) =>
                items.map((item) => (
                    item.key === pendingScan.key
                        ? syncedScan
                        : item
                )),
            );
        } catch (error) {
            if (isConnectivityError(error)) {
                break;
            }

            throw error;
        }
    }

    return {
        flushedCount,
        pendingCount: remaining.length,
    };
}

export async function deleteAllDailyData() {
    await update(ref(database), {
        couriers: null,
        deliveries: null,
        scans: null,
    });
    invalidateCollections(['couriers', 'deliveries', 'scans'], {
        prefetch: true,
    });
}

export async function deleteAllDeliveriesAndScans() {
    await update(ref(database), {
        deliveries: null,
        scans: null,
    });
    invalidateCollections(['deliveries', 'scans'], { prefetch: true });
}

export async function deleteCourierByName(courierName) {
    const normalizedCourierName = normalizeCourierName(courierName);
    const couriers = await getCouriers();
    const keysToDelete = couriers
        .filter((courier) => normalizeCourierName(courier.name) === normalizedCourierName)
        .map((courier) => `couriers/${courier.key}`);

    await removePaths(keysToDelete);
    invalidateCollections(['couriers'], { prefetch: true });

    return keysToDelete;
}

export async function deleteDeliveriesByCourier(courierName) {
    const normalizedCourierName = normalizeCourierName(courierName);
    const deliveries = await getDeliveries();
    const matchedDeliveries = deliveries.filter(
        (delivery) => normalizeCourierName(delivery.courier_name) === normalizedCourierName,
    );

    await removePaths(
        matchedDeliveries.map((delivery) => `deliveries/${delivery.key}`),
    );
    invalidateCollections(['deliveries'], { prefetch: true });

    return matchedDeliveries;
}

export async function deleteScansByCourier(courierName) {
    const normalizedCourierName = normalizeCourierName(courierName);
    const scans = await getScans();
    const matchedScans = scans.filter(
        (scan) => normalizeCourierName(scan.courier_name) === normalizedCourierName,
    );

    await removePaths(matchedScans.map((scan) => `scans/${scan.key}`));
    invalidateCollections(['scans'], { prefetch: true });

    return matchedScans;
}

export async function deleteScansByDeliveryIds(deliveryIds) {
    const ids = new Set(deliveryIds.map((deliveryId) => normalizeDeliveryId(deliveryId)).filter(Boolean));

    if (ids.size === 0) {
        return [];
    }

    const scans = await getScans();
    const matchedScans = scans.filter((scan) => ids.has(normalizeDeliveryId(scan.delivery_id)));

    await removePaths(matchedScans.map((scan) => `scans/${scan.key}`));
    invalidateCollections(['scans'], { prefetch: true });

    return matchedScans;
}

export async function deleteDeliveryByCourierAndId(courierName, deliveryId) {
    const normalizedCourierName = normalizeCourierName(courierName);
    const normalizedDeliveryId = normalizeDeliveryId(deliveryId);
    const deliveries = await getDeliveries();
    const matchedDeliveries = deliveries.filter(
        (delivery) =>
            normalizeCourierName(delivery.courier_name) === normalizedCourierName &&
            normalizeDeliveryId(delivery.id) === normalizedDeliveryId,
    );

    await removePaths(
        matchedDeliveries.map((delivery) => `deliveries/${delivery.key}`),
    );
    invalidateCollections(['deliveries'], { prefetch: true });

    return matchedDeliveries;
}

export async function deleteScansByCourierAndDeliveryId(courierName, deliveryId) {
    const normalizedCourierName = normalizeCourierName(courierName);
    const normalizedDeliveryId = normalizeDeliveryId(deliveryId);
    const scans = await getScans();
    const matchedScans = scans.filter(
        (scan) =>
            normalizeCourierName(scan.courier_name) === normalizedCourierName &&
            normalizeDeliveryId(scan.delivery_id) === normalizedDeliveryId,
    );

    await removePaths(matchedScans.map((scan) => `scans/${scan.key}`));
    invalidateCollections(['scans'], { prefetch: true });

    return matchedScans;
}

export async function deleteCourierCascade(courierName) {
    const deletedDeliveries = await deleteDeliveriesByCourier(courierName);
    const deletedDeliveryIds = deletedDeliveries.map((delivery) => delivery.id);

    await Promise.all([
        deleteCourierByName(courierName),
        deleteScansByCourier(courierName),
        deleteScansByDeliveryIds(deletedDeliveryIds),
    ]);

    return {
        deletedDeliveryIds,
    };
}

export async function deleteDeliveriesAndRelatedScansByCourier(courierName) {
    const deletedDeliveries = await deleteDeliveriesByCourier(courierName);
    const deletedDeliveryIds = deletedDeliveries.map((delivery) => delivery.id);

    await deleteScansByDeliveryIds(deletedDeliveryIds);

    return {
        deletedDeliveryIds,
    };
}

export async function deleteDeliveryAndRelatedScansByCourier(courierName, deliveryId) {
    const deletedDeliveries = await deleteDeliveryByCourierAndId(courierName, deliveryId);

    await deleteScansByCourierAndDeliveryId(courierName, deliveryId);

    return {
        deletedDeliveryIds: deletedDeliveries.map((delivery) => delivery.id),
    };
}
