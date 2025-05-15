// main.js
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

    // Debugging logs to ensure elements are found
    console.log('Input mode button:', inputModeButton);
    console.log('Scan button:', scanButton);

    // Показ сообщения
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

    // Обработчики событий
    if (inputModeButton) {
        inputModeButton.addEventListener('click', () => {
            console.log('Input mode button clicked');
            inputModeButton.classList.add('active');
            manualSubmitButton.classList.add('active');
            inputModeButton.style.display = 'none';
            manualInputContainer.style.display = 'flex';
            stopQrScanner();
            manualTransferIdInput.focus();
        });
    } else {
        console.error('Input mode button not found');
    }

    if (manualSubmitButton) {
        manualSubmitButton.addEventListener('click', () => {
            console.log('Manual submit button clicked');
            const transferId = manualTransferIdInput.value.trim();
            if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
                processTransferId(transferId);
            } else {
                showMessage('error', 'Неверный формат ID', '', '', '');
            }
        });
    } else {
        console.error('Manual submit button not found');
    }

    if (manualTransferIdInput) {
        manualTransferIdInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                console.log('Enter key pressed in manual input');
                manualSubmitButton.click();
            }
        });
    } else {
        console.error('Manual transfer ID input not found');
    }

    if (scanButton) {
        scanButton.addEventListener('click', () => {
            console.log('Scan button clicked');
            scanButton.classList.add('released');
            startQrScanner();
            setTimeout(() => scanButton.classList.remove('released'), 500);
        });
    } else {
        console.error('Scan button not found');
    }

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            console.log('Sidebar toggle clicked');
            sidebarMenu.style.display = sidebarMenu.style.display === 'block' ? 'none' : 'block';
        });
    } else {
        console.error('Sidebar toggle not found');
    }

    if (addDataButton) {
        addDataButton.addEventListener('click', async () => {
            console.log('Add data button clicked');
            sidebarMenu.style.display = 'block';
            rawDataInput.style.display = 'block';
            submitRawDataButton.style.display = 'block';
            statsContainer.style.display = 'none';
        });
    } else {
        console.error('Add data button not found');
    }

    if (submitRawDataButton) {
        submitRawDataButton.addEventListener('click', async () => {
            console.log('Submit raw data button clicked');
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
    } else {
        console.error('Submit raw data button not found');
    }

    if (showStatsButton) {
        showStatsButton.addEventListener('click', async () => {
            console.log('Show stats button clicked');
            rawDataInput.style.display = 'none';
            submitRawDataButton.style.display = 'none';
            statsContainer.style.display = 'block';
            await loadStats();
        });
    } else {
        console.error('Show stats button not found');
    }

    // Функции
    function parseRawData(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return { courierName: '', deliveryIds: [] };

        const firstLine = lines[0];
        const courierNameMatch = firstLine.match(/^[А-Яа-яA-Za-z]+/);
        const courierName = courierNameMatch ? courierNameMatch[0] : '';

        const deliveryIds = lines.filter(line => /^\d{10}$/.test(line));

        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        if (!courierName || deliveryIds.length === 0) {
            showMessage('error', 'Нет данных для сохранения', '', '', '');
            return;
        }

        try {
            const couriersRef = ref(database, 'couriers');
            const deliveriesRef = ref(database, 'deliveries');

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
        console.log('Starting QR scanner');
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(device => device.kind === 'videoinput');
            const camera = cameras.find(c => c.label.toLowerCase().includes('back')) || cameras[0] || null;

            if (!camera) {
                showMessage('error', 'Камеры не найдены на устройстве', '', '', '');
                qrIcon.style.display = 'block';
                return;
            }

            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { exact: "environment" }
                }
            });

            videoElement.srcObject = stream;
            await videoElement.play();

            qrContainer.querySelector('#qr-reader').classList.add('active');

            if (!codeReader) {
                codeReader = new ZXing.BrowserMultiFormatReader();
            }

            codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
                if (result) {
                    console.log('QR code scanned:', result.getText());
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
            console.error('Ошибка камеры:', err.name, err.message, err.constraint);
            if (err.name === 'NotAllowedError') {
                showMessage('error', 'Доступ к камере заблокирован. Разрешите доступ в настройках браузера.', '', '', '');
            } else {
                showMessage('error', 'Ошибка камеры: ' + err.message, '', '', '');
            }
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

            if (cleanedId.length !== 4 && cleanedId.length !== 10) {
                showMessage('error', 'Неверный формат ID', '', '', '');
                isProcessing = false;
                return;
            }

            const deliveriesQuery = query(ref(database, 'deliveries'));
            const snapshot = await get(deliveriesQuery);

            let found = false;
            let courierName = '';
            let courierId = '';

            if (snapshot.exists()) {
                snapshot.forEach(childSnapshot => {
                    const data = childSnapshot.val();
                    if (data.id === cleanedId) {
                        courierName = data.courier_name;
                        courierId = data.courier_id;
                        found = true;
                    }
                });
            }

            if (found) {
                const scansRef = ref(database, 'scans');
                const scansQuery = query(scansRef);
                const scansSnapshot = await get(scansQuery);
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
                    const scansRef = push(ref(database, 'scans'));
                    await set(scansRef, {
                        delivery_id: cleanedId,
                        courier_name: courierName,
                        timestamp: Date.now()
                    });
                    showMessage('success', cleanedId, courierName);
                }
            } else {
                showMessage('not_found', cleanedId);
            }
        } catch (e) {
            console.error('Ошибка поиска:', e);
            showMessage('error', 'Ошибка при поиске', '', '', '');
        } finally {
            loadingIndicator.style.display = 'none';
            isProcessing = false;
        }
    }

    async function loadStats() {
        statsList.innerHTML = '';
        try {
            const scansRef = ref(database, 'scans');
            const scansQuery = query(scansRef);
            const scansSnapshot = await get(scansQuery);

            if (scansSnapshot.exists()) {
                scansSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    const date = new Date(scanData.timestamp).toLocaleString('ru-RU');
                    const li = document.createElement('li');
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
        console.log('Stopping QR scanner');
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            videoElement.srcObject = null;
        }
        if (codeReader) codeReader.reset();
        qrContainer.querySelector('#qr-reader').classList.remove('active');
        qrIcon.style.display = 'block';
        loadingIndicator.style.display = 'none';
    }
});
```
