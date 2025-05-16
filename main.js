// main.js

import { database } from './firebase.js';
import { ref, push, set, get, query } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { BrowserMultiFormatReader, NotFoundException } from 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.0.10/esm/index.min.js';

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
    const submitRawDataButton = document.getElementById('submitRawDataButton');
    const showStatsButton = document.getElementById('showStatsButton');
    const statsContainer = document.getElementById('statsContainer');
    const statsList = document.getElementById('statsList');
    const rawDataInput = document.getElementById('rawData');

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;

    window.showMessage = function (status, message, courier, previousCourier, rawData) {
        resultDiv.className = `scan-result ${status}`;
        let transferId = message;
        const match = message.match(/\d{10}/);
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

    inputModeButton?.addEventListener('click', () => {
        inputModeButton.classList.add('active');
        manualSubmitButton.classList.add('active');
        inputModeButton.style.display = 'none';
        manualInputContainer.style.display = 'flex';
        stopQrScanner();
        manualTransferIdInput.focus();
    });

    manualSubmitButton?.addEventListener('click', () => {
        const transferId = manualTransferIdInput.value.trim();
        if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
            processTransferId(transferId);
        } else {
            showMessage('error', 'Неверный формат ID', '', '', '');
        }
    });

    manualTransferIdInput?.addEventListener('keypress', e => {
        if (e.key === 'Enter') manualSubmitButton.click();
    });

    scanButton?.addEventListener('click', () => {
        scanButton.classList.add('released');
        startQrScanner();
        setTimeout(() => scanButton.classList.remove('released'), 500);
    });

    sidebarToggle?.addEventListener('click', () => {
        sidebarMenu.style.display = sidebarMenu.style.display === 'block' ? 'none' : 'block';
    });

    addDataButton?.addEventListener('click', () => {
        sidebarMenu.style.display = 'block';
        rawDataInput.style.display = 'block';
        submitRawDataButton.style.display = 'block';
        statsContainer.style.display = 'none';
    });

    submitRawDataButton?.addEventListener('click', async () => {
        const rawData = rawDataInput.value.trim();
        if (!rawData) {
            showMessage('error', 'Введите данные', '', '', '');
            return;
        }

        const { courierName, deliveryIds } = parseRawData(rawData);
        if (!courierName || deliveryIds.length === 0) {
            showMessage('error', 'Проверьте данные', '', '', '');
            return;
        }

        await saveCourierAndDeliveries(courierName, deliveryIds);
        rawDataInput.value = '';
    });

    showStatsButton?.addEventListener('click', async () => {
        rawDataInput.style.display = 'none';
        submitRawDataButton.style.display = 'none';
        statsContainer.style.display = 'block';
        await loadStats();
    });

    function parseRawData(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const firstLine = lines[0] || '';
        const courierName = firstLine.match(/^[А-Яа-яA-Za-z]+/)?.[0] || '';
        const deliveryIds = lines.map(l => l.match(/\d{10}/)?.[0]).filter(Boolean);
        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        try {
            const couriersRef = ref(database, 'couriers');
            const deliveriesRef = ref(database, 'deliveries');
            const newCourierRef = push(couriersRef);
            await set(newCourierRef, { name: courierName, timestamp: Date.now() });

            const courierId = newCourierRef.key;
            for (const id of deliveryIds) {
                const newDeliveryRef = push(deliveriesRef);
                await set(newDeliveryRef, {
                    id,
                    courier_id: courierId,
                    courier_name: courierName,
                    timestamp: Date.now()
                });
            }
            showMessage('success', '', `Добавлен курьер: ${courierName}`, `Передач: ${deliveryIds.length}`);
        } catch (e) {
            console.error("Ошибка сохранения в Firebase: ", e);
            showMessage('error', 'Ошибка при сохранении', '', '', '');
        }
    }

    async function startQrScanner() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(d => d.kind === 'videoinput');
            const camera = cameras.find(c => c.label?.toLowerCase().includes('back')) || cameras[0];

            if (!camera) {
                showMessage('error', 'Камеры не найдены', '', '', '');
                return;
            }

            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { exact: "environment" } }
            });

            videoElement.srcObject = stream;
            await videoElement.play();

            if (!codeReader) codeReader = new BrowserMultiFormatReader();

            codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
                if (result) {
                    const decoded = result.getText();
                    const extractedId = decoded.match(/\d{10}/)?.[0];
                    if (extractedId) {
                        onScanSuccess(extractedId, decoded);
                    } else {
                        showMessage('error', 'Неверный формат QR', '', '', decoded);
                    }
                    codeReader.reset();
                    stopQrScanner();
                }
                if (err && !(err instanceof NotFoundException)) {
                    console.error('Ошибка сканирования:', err);
                    showMessage('error', 'Ошибка сканирования QR', '', '', '');
                }
            });
        } catch (err) {
            console.error('Ошибка камеры:', err);
            showMessage('error', 'Ошибка камеры: ' + err.message, '', '', '');
            qrIcon.style.display = 'block';
        }
    }

    function onScanSuccess(transferId, rawData) {
        const now = Date.now();
        if (now - lastScanTime < scanDelay) return;
        lastScanTime = now;

        navigator.vibrate?.(200);
        flashFrame();
        processTransferId(transferId, rawData);
    }

    function flashFrame() {
        qrContainer.classList.remove('flash');
        setTimeout(() => qrContainer.classList.add('flash'), 0);
    }

    async function processTransferId(transferId, rawData = '') {
        if (isProcessing) return;
        isProcessing = true;
        loadingIndicator.style.display = 'block';

        try {
            const cleanedId = transferId.replace(/[^\d]/g, '');
            if (!/^\d{10}$/.test(cleanedId)) {
                showMessage('error', 'Неверный ID', '', '', rawData);
                return;
            }

            const deliveriesQuery = query(ref(database, 'deliveries'));
            const snapshot = await get(deliveriesQuery);

            let found = false;
            let courierName = '', courierId = '';

            snapshot.forEach(child => {
                const data = child.val();
                if (data.id === cleanedId) {
                    courierName = data.courier_name;
                    courierId = data.courier_id;
                    found = true;
                }
            });

            if (found) {
                const scansSnapshot = await get(query(ref(database, 'scans')));
                let duplicate = false;
                let prevCourier = '';

                scansSnapshot.forEach(scan => {
                    const scanData = scan.val();
                    if (scanData.delivery_id === cleanedId) {
                        duplicate = true;
                        prevCourier = scanData.courier_name;
                    }
                });

                if (duplicate) {
                    showMessage('already_scanned', cleanedId, courierName, `Ранее сканировал: ${prevCourier}`, rawData);
                } else {
                    const newScanRef = push(ref(database, 'scans'));
                    await set(newScanRef, {
                        delivery_id: cleanedId,
                        courier_name: courierName,
                        timestamp: Date.now()
                    });
                    showMessage('success', cleanedId, courierName, '', rawData);
                }
            } else {
                showMessage('not_found', cleanedId, '', '', rawData);
            }
        } catch (e) {
            console.error('Ошибка поиска:', e);
            showMessage('error', 'Ошибка при поиске', '', '', rawData);
        } finally {
            loadingIndicator.style.display = 'none';
            isProcessing = false;
        }
    }

    async function loadStats() {
        statsList.innerHTML = '';
        try {
            const snapshot = await get(query(ref(database, 'scans')));
            if (snapshot.exists()) {
                snapshot.forEach(scan => {
                    const scanData = scan.val();
                    const li = document.createElement('li');
                    const date = new Date(scanData.timestamp).toLocaleString('ru-RU');
                    li.textContent = `ID: ${scanData.delivery_id}, Курьер: ${scanData.courier_name}, Время: ${date}`;
                    statsList.appendChild(li);
                });
            } else {
                statsList.innerHTML = '<li>Сканирований пока нет.</li>';
            }
        } catch (e) {
            console.error('Ошибка загрузки статистики:', e);
            statsList.innerHTML = '<li>Ошибка загрузки статистики.</li>';
        }
    }

    function stopQrScanner() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            videoElement.srcObject = null;
        }
        codeReader?.reset();
        qrIcon.style.display = 'block';
        loadingIndicator.style.display = 'none';
    }
});
