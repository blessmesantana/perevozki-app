import { database } from './firebase.js';
import {
    get,
    push,
    query,
    ref,
    set,
    update,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

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

async function getCollection(path) {
    const snapshot = await get(query(ref(database, path)));

    return snapshotToArray(snapshot);
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

export async function saveCourier(courierName) {
    const courierRef = push(ref(database, 'couriers'));
    const record = {
        name: courierName,
        timestamp: Date.now(),
    };

    await set(courierRef, record);

    return {
        key: courierRef.key,
        ...record,
    };
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

        await set(deliveryRef, record);
        savedDeliveries.push({
            key: deliveryRef.key,
            ...record,
        });
    }

    return savedDeliveries;
}

export async function saveScan(deliveryId, courierName, timestamp = Date.now()) {
    const scanRef = push(ref(database, 'scans'));
    const record = {
        delivery_id: deliveryId,
        courier_name: courierName,
        timestamp,
    };

    await set(scanRef, record);

    return {
        key: scanRef.key,
        ...record,
    };
}

export async function deleteAllDailyData() {
    await update(ref(database), {
        couriers: null,
        deliveries: null,
        scans: null,
    });
}

export async function deleteAllDeliveriesAndScans() {
    await update(ref(database), {
        deliveries: null,
        scans: null,
    });
}

export async function deleteCourierByName(courierName) {
    const couriers = await getCouriers();
    const keysToDelete = couriers
        .filter((courier) => courier.name === courierName)
        .map((courier) => `couriers/${courier.key}`);

    await removePaths(keysToDelete);

    return keysToDelete;
}

export async function deleteDeliveriesByCourier(courierName) {
    const deliveries = await getDeliveries();
    const matchedDeliveries = deliveries.filter(
        (delivery) => delivery.courier_name === courierName,
    );

    await removePaths(
        matchedDeliveries.map((delivery) => `deliveries/${delivery.key}`),
    );

    return matchedDeliveries;
}

export async function deleteScansByCourier(courierName) {
    const scans = await getScans();
    const matchedScans = scans.filter((scan) => scan.courier_name === courierName);

    await removePaths(matchedScans.map((scan) => `scans/${scan.key}`));

    return matchedScans;
}

export async function deleteScansByDeliveryIds(deliveryIds) {
    const ids = new Set(deliveryIds.filter(Boolean));

    if (ids.size === 0) {
        return [];
    }

    const scans = await getScans();
    const matchedScans = scans.filter((scan) => ids.has(scan.delivery_id));

    await removePaths(matchedScans.map((scan) => `scans/${scan.key}`));

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
