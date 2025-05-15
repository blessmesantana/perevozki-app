import { database } from './firebase.js';
import { ref, push, set, get, query } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

document.addEventListener("DOMContentLoaded", function () {
    // Проверка загрузки DOM
    console.log('DOM fully loaded');

    // Выбор элементов DOM
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

    // Проверка наличия ключевых элементов
    if (!qrIcon) console.error('qrIcon is null');
    if (!loadingIndicator) console.error('loadingIndicator is null');
    if (!videoElement) console.error('videoElement is null');
    if (!resultDiv) console.error('resultDiv is null');

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;

    // Функция для показа сообщений
    function showMessage(status, message, courier = '', previousCourier = '', rawData = '') {
        if (!resultDiv) {
            console.error('resultDiv is null');
            return;
        }
        resultDiv.className = `scan-result ${status}`;
        resultTransferId.textContent = message;
        resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
        resultPrevious.textContent = previousCourier ? `Предыдущий курьер: ${previousCourier}` : '';
        resultStatus.textContent = status;
        resultRawData.textContent = rawData ? `Сырые данные: ${rawData}` : '';
        resultDiv.style.display = 'flex';
        setTimeout(() => {
            resultDiv.style.display = 'none';
            if (status === 'success' || status === 'already_scanned') {
                startQrScanner();
            }
        }, 5000);
    }

    // Обработчики событий
    if (inputModeButton) {
        inputModeButton.addEventListener('click', () => {
            console.log('Input mode button clicked');
            manualInputContainer.style.display = 'flex';
            stopQrScanner();
            inputModeButton.style.display = 'none';
            manualTransferIdInput.focus();
        });
    }

    if (manualSubmitButton) {
        manualSubmitButton.addEventListener('click', () => {
            const transferId = manualTransferIdInput.value.trim();
            if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
                processTransferId(transferId);
            } else {
                showMessage('error', 'Неверный формат ID');
            }
        });
    }

    if (scanButton) {
        scanButton.addEventListener('click', () => {
            console.log('Scan button clicked');
            startQrScanner();
        });
    }

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebarMenu.style.display = sidebarMenu.style.display === 'block' ? 'none' : 'block';
        });
    }

    if (addDataButton) {
        addDataButton.addEventListener('click', () => {
            rawDataInput.style.display = 'block';
            submitRawDataButton.style.display = 'block';
            statsContainer.style.display = 'none';
        });
    }

    if (submitRawDataButton) {
        submitRawDataButton.addEventListener('click', async () => {
            const rawData = rawDataInput.value.trim();
            if (!rawData) {
                showMessage('error', 'Введите данные');
                return;
            }
            const { courierName, deliveryIds } = parseRawData(rawData);
            if (!courierName || deliveryIds.length === 0) {
                showMessage('error', 'Неверный формат данных');
                return;
            }
            await saveCourierAndDeliveries(courierName, deliveryIds);
            rawDataInput.value = '';
        });
    }

    if (showStatsButton) {
        showStatsButton.addEventListener('click', async () => {
            rawDataInput.style.display = 'none';
            submitRawDataButton.style.display = 'none';
            statsContainer.style.display = 'block';
            await loadStats();
        });
    }

    // Вспомогательные функции
    function parseRawData(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return { courierName: '', deliveryIds: [] };
        const courierName = lines[0].match(/^[А-Яа-яA-Za-z]+/)?.[0] || '';
        const deliveryIds = lines.slice(1).filter(line => /^\d{10}$/.test(line));
        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        try {
            const couriersRef = ref(database, 'couriers');
            const newCourierRef = push(couriersRef);
            await set(newCourierRef, { name: courierName, timestamp: Date.now() });
            const courierId = newCourierRef.key;
            const deliveriesRef = ref(database, 'deliveries');
            for (const id of deliveryIds) {
                const newDeliveryRef = push(deliveriesRef);
                await set(newDeliveryRef, { id, courier_id: courierId, courier_name: courierName, timestamp: Date.now() });
            }
            showMessage('success', 'Данные сохранены');
        } catch (e) {
            console.error('Ошибка сохранения:', e);
            showMessage('error', 'Ошибка сохранения');
        }
    }

    async function startQrScanner() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const camera = devices.find(device => device.kind === 'videoinput' && device.label.toLowerCase().includes('back')) || devices.find(device => device.kind === 'videoinput');
            if (!camera) {
                showMessage('error', 'Камера не найдена');
                if (qrIcon) qrIcon.style.display = 'block';
                return;
            }
            stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camera.deviceId } });
            if (videoElement) {
                videoElement.srcObject = stream;
                await videoElement.play();
            }
            if (qrIcon) qrIcon.style.display = 'none';
            codeReader = new ZXing.BrowserMultiFormatReader();
            codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
                if (result) {
                    onScanSuccess(result.text);
                    codeReader.reset();
                    stopQrScanner();
                }
                if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error('Ошибка сканирования:', err);
                }
            });
        } catch (err) {
            console.error('Ошибка камеры:', err);
            showMessage('error', 'Ошибка камеры');
            if (qrIcon) qrIcon.style.display = 'block';
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
        if (qrContainer) {
            qrContainer.classList.remove('flash');
            setTimeout(() => qrContainer.classList.add('flash'), 0);
        }
    }

    async function processTransferId(transferId) {
        if (isProcessing) return;
        isProcessing = true;
        if (loadingIndicator) loadingIndicator.style.display = 'block';
        try {
            const cleanedId = transferId.replace(/[^\d]/g, '');
            if (cleanedId.length !== 4 && cleanedId.length !== 10) {
                showMessage('error', 'Неверный формат ID');
                return;
            }
            const deliveriesRef = ref(database, 'deliveries');
            const snapshot = await get(query(deliveriesRef));
            let found = false;
            let courierName = '';
            snapshot.forEach(childSnapshot => {
                const data = childSnapshot.val();
                if (data.id === cleanedId) {
                    courierName = data.courier_name;
                    found = true;
                }
            });
            if (found) {
                const scansRef = ref(database, 'scans');
                const scansSnapshot = await get(query(scansRef));
                let duplicate = false;
                let prevCourier = '';
                scansSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    if (scanData.delivery_id === cleanedId) {
                        duplicate = true;
                        prevCourier = scanData.courier_name;
                    }
                });
                if (duplicate) {
                    showMessage('already_scanned', cleanedId, courierName, `Ранее сканировал: ${prevCourier}`);
                } else {
                    const newScanRef = push(scansRef);
                    await set(newScanRef, { delivery_id: cleanedId, courier_name: courierName, timestamp: Date.now() });
                    showMessage('success', cleanedId, courierName);
                }
            } else {
                showMessage('not_found', cleanedId);
            }
        } catch (e) {
            console.error('Ошибка поиска:', e);
            showMessage('error', 'Ошибка при поиске');
        } finally {
            isProcessing = false;
            if (loadingIndicator) loadingIndicator.style.display = 'none';
        }
    }

    async function loadStats() {
        statsList.innerHTML = '';
        try {
            const scansRef = ref(database, 'scans');
            const snapshot = await get(query(scansRef));
            if (snapshot.exists()) {
                snapshot.forEach(childSnapshot => {
                    const scanData = childSnapshot.val();
                    const li = document.createElement('li');
                    const date = new Date(scanData.timestamp).toLocaleString('ru-RU');
                    li.textContent = `ID: ${scanData.delivery_id}, Курьер: ${scanData.courier_name}, Время: ${date}`;
                    statsList.appendChild(li);
                });
            } else {
                const li = document.createElement('li');
                li.textContent = 'Сканирований пока нет.';
                statsList.appendChild(li);
            }
        } catch (e) {
            console.error('Ошибка загрузки статистики:', e);
            const li = document.createElement('li');
            li.textContent = 'Ошибка загрузки статистики.';
            statsList.appendChild(li);
        }
    }

    function stopQrScanner() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            if (videoElement) videoElement.srcObject = null;
        }
        if (codeReader) codeReader.reset();
        if (qrIcon) qrIcon.style.display = 'block';
        if (loadingIndicator) loadingIndicator.style.display = 'none';
    }
});
