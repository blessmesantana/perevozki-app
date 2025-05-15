import { database } from './firebase.js';
import { ref, push, set, get, child, query, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

document.addEventListener("DOMContentLoaded", function () {
    const resultDiv = document.getElementById('result');
    const resultTransferId = document.getElementById('resultTransferId');
    const resultCourier = document.getElementById('resultCourier');
    const resultPrevious = document.getElementById('resultPrevious');
    const resultStatus = document.getElementById('resultStatus');
    const resultRawData = document.getElementById('resultRawData');

    const inputModeButton = document.getElementById('inputModeButton');
    const manualInputContainer = document.getElementById('manualInputContainer');
    const manualTransferIdInput = document.getElementById('manualTransferId');
    const manualSubmitButton = document.getElementById('manualSubmitButton');
    const scanButton = document.getElementById('scanButton');
    const qrContainer = document.querySelector('.qr-container');
    const videoElement = document.getElementById('qr-video');
    const qrIcon = document.querySelector('.qr-icon');
    const loadingIndicator = document.getElementById('loadingIndicator');

    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarMenu = document.getElementById('sidebarMenu');
    const addDataButton = document.getElementById('addDataButton');
    const rawDataInput = document.getElementById('rawData');
    const showStatsButton = document.getElementById('showStatsButton');

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;
    let cachedDeliveries = {};

    window.showMessage = function(status, message, courier, previousCourier, rawData) {
        resultDiv.className = `scan-result ${status}`;
        let transferId = message;
        const match = message.match(/\d{10}|\d{4}/);
        if (match) transferId = match[0];

        resultTransferId.textContent = transferId || '';
        resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
        resultPrevious.textContent = previousCourier || '';
        resultStatus.textContent = status === 'already_scanned' ? 'Повторное сканирование' :
                                 status === 'success' ? 'Успешно' :
                                 status === 'not_found' ? 'Не найдено' : message;
        resultRawData.textContent = rawData ? `Сырые данные: ${rawData}` : '';
        resultDiv.style.display = 'flex';

        setTimeout(() => {
            resultDiv.style.display = 'none';
            if (status === 'success' || status === 'already_scanned') {
                startQrScanner();
            }
        }, 5000);
    }

    inputModeButton.addEventListener('click', () => {
        inputModeButton.classList.add('active');
        manualSubmitButton.classList.add('active');
        inputModeButton.style.display = 'none';
        manualInputContainer.style.display = 'flex';
        stopQrScanner();
        manualTransferIdInput.focus();
    });

    manualSubmitButton.addEventListener('click', () => {
        const transferId = manualTransferIdInput.value.trim();
        if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
            processTransferId(transferId);
        } else {
            showMessage('error', 'Неверный формат ID', '', '', '');
        }
    });

    manualTransferIdInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') manualSubmitButton.click();
    });

    scanButton.addEventListener('click', () => {
        scanButton.classList.add('released');
        checkCameraPermission();
        setTimeout(() => scanButton.classList.remove('released'), 500);
    });

    sidebarToggle.addEventListener('click', () => {
        sidebarMenu.style.display = sidebarMenu.style.display === 'block' ? 'none' : 'block';
    });

    addDataButton.addEventListener('click', async () => {
        const rawData = rawDataInput.value.trim();
        if (!rawData) {
            showMessage('error', 'Введите данные', '', '', '');
            return;
        }

        const { courierName, deliveryIds } = parseRawData(rawData);
        if (!courierName) {
            showMessage('error', 'Не найдено имя курьера', '', '', '');
            return;
        }
        if (deliveryIds.length === 0) {
            showMessage('error', 'Не найдены номера передач', '', '', '');
            return;
        }

        await saveCourierAndDeliveries(courierName, deliveryIds);
        rawDataInput.value = '';
    });

    showStatsButton.addEventListener('click', displayCourierStats);

    function parseRawData(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        let courierName = '';
        const deliveryIds = [];

        if (lines.length > 0) {
            courierName = lines[0];
        }

        for (const line of lines) {
            if (/^\d{10}$/.test(line)) {
                deliveryIds.push(line);
            }
        }

        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        if (!courierName || deliveryIds.length === 0) {
            showMessage('error', 'Нет данных для сохранения', '', '', '');
            return;
        }

        try {
            const currentDate = new Date().toISOString().split('T')[0];
            const couriersRef = ref(database, `couriers/${currentDate}`);
            const deliveriesRef = ref(database, `deliveries/${currentDate}`);

            const newCourierRef = push(couriersRef);
            await set(newCourierRef, {
                name: courierName,
                timestamp: Date.now()
            });

            const courierId = newCourierRef.key;

            for (const id of deliveryIds) {
                const newDeliveryRef = push(deliveriesRef);
                await set(newDeliveryRef, {
                    id,
                    courier_id: courierId,
                    courier_name: courierName,
                    timestamp: Date.now(),
                    scanned: false
                });
            }

            showMessage('success', '', `Добавлен курьер: ${courierName}`, `Передач: ${deliveryIds.length}`);
        } catch (e) {
            console.error("Ошибка сохранения в Firebase:", e);
            showMessage('error', `Ошибка при сохранении: ${e.message}`, '', '', '');
        }
    }

    async function checkCameraPermission() {
        try {
            const permissionStatus = await navigator.permissions.query({ name: 'camera' });
            if (permissionStatus.state === 'granted') {
                startQrScanner();
            } else if (permissionStatus.state === 'prompt') {
                showMessage('info', 'Пожалуйста, разрешите доступ к камере', '', '', '');
                startQrScanner();
            } else {
                showMessage('error', 'Доступ к камере запрещен. Разрешите в настройках браузера.', '', '', '');
            }
        } catch (err) {
            console.error('Ошибка проверки разрешений:', err);
            showMessage('error', 'Ошибка проверки разрешений камеры', '', '', '');
        }
    }

    async function startQrScanner() {
        try {
            stopQrScanner();

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');

            if (!videoDevices.length) {
                showMessage('error', 'Камеры не найдены на устройстве', '', '', '');
                qrIcon.style.display = 'block';
                return;
            }

            let selectedCamera = videoDevices.find(device =>
                device.label.toLowerCase().includes('back') ||
                device.label.toLowerCase().includes('rear')
            ) || videoDevices[videoDevices.length - 1];

            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: selectedCamera.deviceId },
                    facingMode: { ideal: 'environment' }
                }
            });

            videoElement.srcObject = stream;
            await videoElement.play();

            if (!codeReader) {
                codeReader = new ZXing.BrowserMultiFormatReader();
            }

            qrIcon.style.display = 'none';
            codeReader.decodeFromVideoDevice(selectedCamera.deviceId, 'qr-video', (result, err) => {
                if (result) {
                    onScanSuccess(result.getText());
                    codeReader.reset();
                    stopQrScanner();
                }
                if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error('Ошибка сканирования:', err);
                    showMessage('error', 'Ошибка сканирования QR', '', '', '');
                }
            });
        } catch (err) {
            console.error('Ошибка камеры:', err);
            showMessage('error', 'Ошибка доступа к камере. Проверьте разрешения.', '', '', '');
            qrIcon.style.display = 'block';
        }
    }

    function onScanSuccess(decodedText) {
        const now = Date.now();
        if (now - lastScanTime < scanDelay) return;
        lastScanTime = now;

        navigator.vibrate?.(200);
        flashFrame();
        processTransferId(decodedText);
    }

    function flashFrame() {
        qrContainer.classList.remove('flash');
        setTimeout(() => qrContainer.classList.add('flash'), 0);
    }

    async function processTransferId(transferId) {
        if (isProcessing) return;
        isProcessing = true;
        loadingIndicator.style.display = 'block';

        try {
            const cleanedId = transferId.replace(/[^\d]/g, '');
            const currentDate = new Date().toISOString().split('T')[0];

            if (cleanedId.length !== 4 && cleanedId.length !== 10) {
                showMessage('error', 'Неверный формат ID', '', '', '');
                isProcessing = false;
                return;
            }

            const deliveriesRef = ref(database, `deliveries/${currentDate}`);
            const snapshot = await get(deliveriesRef);

            let matches = [];
            if (snapshot.exists()) {
                snapshot.forEach(childSnapshot => {
                    const data = childSnapshot.val();
                    const deliveryId = data.id;
                    if (deliveryId === cleanedId || (cleanedId.length === 4 && deliveryId.endsWith(cleanedId))) {
                        matches.push({ key: childSnapshot.key, ...data });
                    }
                });
            }

            if (matches.length === 0) {
                showMessage('not_found', cleanedId);
                isProcessing = false;
                return;
            }

            if (matches.length > 1 && cleanedId.length === 4) {
                showMessage('error', 'Найдено несколько совпадений. Уточните ID.', '', '', JSON.stringify(matches.map(m => m.id)));
                isProcessing = false;
                return;
            }

            const delivery = matches[0];
            const courierName = delivery.courier_name;
            const deliveryKey = delivery.key;

            const scansRef = ref(database, `scans/${currentDate}`);
            const scansSnapshot = await get(scansRef);
            let duplicate = false;
            let prevCourier = '';

            if (scansSnapshot.exists()) {
                scansSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    if (scanData.delivery_id === delivery.id) {
                        duplicate = true;
                        prevCourier = scanData.courier_name;
                    }
                });
            }

            if (duplicate) {
                showMessage('already_scanned', delivery.id, courierName, `Ранее сканировал: ${prevCourier}`);
            } else {
                const newScanRef = push(scansRef);
                await set(newScanRef, {
                    delivery_id: delivery.id,
                    courier_name: courierName,
                    timestamp: Date.now()
                });

                await set(ref(database, `deliveries/${currentDate}/${deliveryKey}/scanned`), true);
                showMessage('success', delivery.id, courierName);
            }
        } catch (e) {
            console.error('Ошибка поиска:', e);
            showMessage('error', `Ошибка при поиске: ${e.message}`, '', '', '');
        } finally {
            loadingIndicator.style.display = 'none';
            isProcessing = false;
        }
    }

    function stopQrScanner() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            videoElement.srcObject = null;
        }
        if (codeReader) codeReader.reset();
        qrIcon.style.display = 'block';
        loadingIndicator.style.display = 'none';
    }

    async function displayCourierStats() {
        const currentDate = new Date().toISOString().split('T')[0];
        const couriersRef = ref(database, `couriers/${currentDate}`);
        const deliveriesRef = ref(database, `deliveries/${currentDate}`);

        const couriersSnapshot = await get(couriersRef);
        const deliveriesSnapshot = await get(deliveriesRef);

        let stats = [];
        if (couriersSnapshot.exists()) {
            couriersSnapshot.forEach(courierSnap => {
                const courier = courierSnap.val();
                let scannedCount = 0;
                let totalCount = 0;

                if (deliveriesSnapshot.exists()) {
                    deliveriesSnapshot.forEach(deliverySnap => {
                        const delivery = deliverySnap.val();
                        if (delivery.courier_id === courierSnap.key) {
                            totalCount++;
                            if (delivery.scanned) scannedCount++;
                        }
                    });
                }

                stats.push({
                    date: currentDate,
                    courier: courier.name,
                    total: totalCount,
                    scanned: scannedCount,
                    notScanned: totalCount - scannedCount
                });
            });
        }

        const statsContainer = document.createElement('div');
        statsContainer.innerHTML = `
            <h3>Статистика за ${currentDate}</h3>
            <table>
                <tr>
                    <th>Курьер</th>
                    <th>Всего</th>
                    <th>Отсканировано</th>
                    <th>Не отсканировано</th>
                </tr>
                ${stats.map(s => `
                    <tr>
                        <td>${s.courier}</td>
                        <td>${s.total}</td>
                        <td>${s.scanned}</td>
                        <td>${s.notScanned}</td>
                    </tr>
                `).join('')}
            </table>
        `;
        sidebarMenu.appendChild(statsContainer);
    }
});
