import { database } from './firebase.js';
import { 
    ref, push, set, get, query, orderByChild, equalTo 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js ";

document.addEventListener("DOMContentLoaded", function () {
    // Инициализация элементов DOM
    const elements = {
        resultDiv: document.getElementById('result'),
        resultTransferId: document.getElementById('resultTransferId'),
        resultCourier: document.getElementById('resultCourier'),
        resultPrevious: document.getElementById('resultPrevious'),
        resultStatus: document.getElementById('resultStatus'),
        resultRawData: document.getElementById('resultRawData'),
        inputModeButton: document.getElementById('inputModeButton'),
        manualInputContainer: document.getElementById('manualInputContainer'),
        manualTransferIdInput: document.getElementById('manualTransferId'),
        manualSubmitButton: document.getElementById('manualSubmitButton'),
        scanButton: document.getElementById('scanButton'),
        qrContainer: document.querySelector('.qr-container'),
        videoElement: document.getElementById('qr-video'),
        qrIcon: document.querySelector('.qr-icon'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        sidebarToggle: document.getElementById('sidebarToggle'),
        sidebarMenu: document.getElementById('sidebarMenu'),
        addDataButton: document.getElementById('addDataButton'),
        submitRawDataButton: document.getElementById('submitRawDataButton'),
        showStatsButton: document.getElementById('showStatsButton'),
        statsContainer: document.getElementById('statsContainer'),
        statsList: document.getElementById('statsList'),
        rawDataInput: document.getElementById('rawData')
    };

    // Проверка наличия ключевых элементов
    Object.entries(elements).forEach(([key, value]) => {
        if (!value) console.error(`${key} is null`);
    });

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;

    // Функция показа сообщений
    function showMessage(status, message, courier = '', previousCourier = '', rawData = '') {
        if (!elements.resultDiv) return;
        elements.resultDiv.className = `scan-result ${status}`;
        elements.resultTransferId.textContent = message;
        elements.resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
        elements.resultPrevious.textContent = previousCourier ? `Ранее сканировал: ${previousCourier}` : '';
        elements.resultStatus.textContent = status;
        elements.resultRawData.textContent = rawData ? `Сырые данные: ${rawData}` : '';
        elements.resultDiv.style.display = 'flex';
        setTimeout(() => {
            elements.resultDiv.style.display = 'none';
            if (status === 'success' || status === 'already_scanned') {
                startQrScanner();
            }
        }, 5000);
    }

    // Инициализация ZXing
    async function initZXing() {
        try {
            if (typeof ZXing === 'undefined') {
                throw new Error('Библиотека ZXing не загружена');
            }
            codeReader = new ZXing.BrowserMultiFormatReader();
        } catch (error) {
            console.error('Ошибка инициализации ZXing:', error);
            showMessage('error', 'Ошибка сканера: библиотека ZXing не загружена');
        }
    }

    // Обработчики событий
    if (elements.inputModeButton) {
        elements.inputModeButton.addEventListener('click', () => {
            if (elements.manualInputContainer) {
                elements.manualInputContainer.style.display = 'flex';
            }
            stopQrScanner();
            if (elements.inputModeButton) {
                elements.inputModeButton.style.display = 'none';
            }
            if (elements.manualTransferIdInput) {
                elements.manualTransferIdInput.focus();
            }
        });
    }

    if (elements.manualSubmitButton) {
        elements.manualSubmitButton.addEventListener('click', () => {
            const transferId = elements.manualTransferIdInput?.value.trim() || '';
            const cleanedId = transferId.replace(/[^\d]/g, '');
            if (/^\d{4}$/.test(cleanedId) || /^\d{10}$/.test(cleanedId)) {
                processTransferId(cleanedId);
            } else {
                showMessage('error', 'Неверный формат ID');
                if (elements.manualTransferIdInput) {
                    elements.manualTransferIdInput.value = '';
                    elements.manualTransferIdInput.focus();
                }
            }
        });
    }

    if (elements.scanButton) {
        elements.scanButton.addEventListener('click', () => {
            startQrScanner();
        });
    }

    // Основная логика обработки ID
    async function processTransferId(transferId) {
        if (isProcessing) return;
        isProcessing = true;
        if (elements.loadingIndicator) elements.loadingIndicator.style.display = 'block';
        try {
            const cleanedId = transferId.replace(/[^\d]/g, '');
            if (cleanedId.length !== 4 && cleanedId.length !== 10) {
                showMessage('error', 'Неверный формат ID');
                return;
            }
            // Поиск доставки по ID
            const deliveriesRef = ref(database, 'deliveries');
            const deliveryQuery = query(deliveriesRef, orderByChild('id'), equalTo(cleanedId));
            const deliverySnapshot = await get(deliveryQuery);
            if (!deliverySnapshot.exists()) {
                showMessage('not_found', cleanedId);
                return;
            }
            let courierName = '';
            deliverySnapshot.forEach(childSnapshot => {
                const data = childSnapshot.val();
                if (data.id === cleanedId) {
                    courierName = data.courier_name;
                }
            });
            // Проверка дубликатов
            const scansRef = ref(database, 'scans');
            const scanQuery = query(scansRef, orderByChild('delivery_id'), equalTo(cleanedId));
            const scanSnapshot = await get(scanQuery);
            if (scanSnapshot.exists()) {
                let prevCourier = '';
                scanSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    if (scanData.delivery_id === cleanedId) {
                        prevCourier = scanData.courier_name;
                    }
                });
                showMessage('already_scanned', cleanedId, courierName, `Ранее сканировал: ${prevCourier}`);
                return;
            }
            // Сохранение нового сканирования
            const newScanRef = push(scansRef);
            await set(newScanRef, { 
                delivery_id: cleanedId, 
                courier_name: courierName, 
                timestamp: Date.now() 
            });
            showMessage('success', cleanedId, courierName);
        } catch (e) {
            console.error('Ошибка поиска:', e);
            showMessage('error', 'Ошибка при поиске');
        } finally {
            isProcessing = false;
            if (elements.loadingIndicator) elements.loadingIndicator.style.display = 'none';
        }
    }

    // Запуск сканера QR
    async function startQrScanner() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const camera = devices.find(device => 
                device.kind === 'videoinput' && 
                device.label.toLowerCase().includes('back')
            ) || devices.find(device => device.kind === 'videoinput');
            if (!camera) {
                showMessage('error', 'Камера не найдена');
                if (elements.qrIcon) elements.qrIcon.style.display = 'block';
                return;
            }
            stream = await navigator.mediaDevices.getUserMedia({ 
                video: { deviceId: camera.deviceId } 
            });
            if (elements.videoElement) {
                elements.videoElement.srcObject = stream;
                await elements.videoElement.play();
            }
            if (elements.qrIcon) elements.qrIcon.style.display = 'none';
            await initZXing();
            if (!codeReader) return;
            codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
                if (result) {
                    onScanSuccess(result.text);
                    if (codeReader) codeReader.reset();
                    stopQrScanner();
                }
                if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error('Ошибка сканирования:', err);
                    showMessage('error', 'Ошибка сканирования');
                }
            });
        } catch (err) {
            console.error('Ошибка камеры:', err);
            showMessage('error', 'Ошибка камеры');
            if (elements.qrIcon) elements.qrIcon.style.display = 'block';
        }
    }

    // Обработка успешного сканирования
    function onScanSuccess(decodedText) {
        const now = Date.now();
        if (now - lastScanTime < scanDelay) return;
        lastScanTime = now;
        if (navigator.vibrate) navigator.vibrate(200);
        flashFrame();
        processTransferId(decodedText);
    }

    // Валидация и сохранение данных
    function parseRawData(text) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return { courierName: '', deliveryIds: [] };
        const courierNameMatch = lines[0].match(/^[А-Яа-яЁёA-Za-z\s]+/);
        const courierName = courierNameMatch ? courierNameMatch[0] : '';
        const deliveryIds = lines.slice(1).filter(line => /^\d{10}$/.test(line.trim()));
        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        try {
            if (!courierName || deliveryIds.length === 0) {
                showMessage('error', 'Неверный формат данных');
                return;
            }
            const couriersRef = ref(database, 'couriers');
            const courierQuery = query(couriersRef, orderByChild('name'), equalTo(courierName));
            const courierSnapshot = await get(courierQuery);
            let courierId;
            if (courierSnapshot.exists()) {
                courierId = Object.keys(courierSnapshot.val())[0];
            } else {
                const newCourierRef = push(couriersRef);
                await set(newCourierRef, { 
                    name: courierName, 
                    timestamp: Date.now(),
                    delivery_count: deliveryIds.length 
                });
                courierId = newCourierRef.key;
            }
            const deliveriesRef = ref(database, 'deliveries');
            for (const id of deliveryIds) {
                const newDeliveryRef = push(deliveriesRef);
                await set(newDeliveryRef, { 
                    id, 
                    courier_id: courierId, 
                    courier_name: courierName, 
                    timestamp: Date.now() 
                });
            }
            showMessage('success', 'Данные сохранены');
            if (elements.rawDataInput) elements.rawDataInput.value = '';
        } catch (e) {
            console.error('Ошибка сохранения:', e);
            showMessage('error', 'Ошибка сохранения');
        }
    }

    // Загрузка статистики
    async function loadStats() {
        elements.statsList.innerHTML = '';
        try {
            const scansRef = ref(database, 'scans');
            const scanQuery = query(scansRef, orderByChild('timestamp'), equalTo(Date.now()));
            const snapshot = await get(scanQuery);
            if (snapshot.exists()) {
                snapshot.forEach(childSnapshot => {
                    const scanData = childSnapshot.val();
                    const li = document.createElement('li');
                    const date = new Date(scanData.timestamp).toLocaleString('ru-RU');
                    li.textContent = `ID: ${scanData.delivery_id}, Курьер: ${scanData.courier_name}, Время: ${date}`;
                    elements.statsList.appendChild(li);
                });
            } else {
                const li = document.createElement('li');
                li.textContent = 'Сканирований пока нет.';
                elements.statsList.appendChild(li);
            }
        } catch (e) {
            console.error('Ошибка загрузки статистики:', e);
            const li = document.createElement('li');
            li.textContent = 'Ошибка загрузки статистики.';
            elements.statsList.appendChild(li);
        }
    }

    // Остановка сканера
    function stopQrScanner() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            if (elements.videoElement) elements.videoElement.srcObject = null;
        }
        if (codeReader) {
            codeReader.reset();
            codeReader = null;
        }
        if (elements.qrIcon) elements.qrIcon.style.display = 'block';
        if (elements.loadingIndicator) elements.loadingIndicator.style.display = 'none';
    }

    // Вспышка
    function flashFrame() {
        if (elements.qrContainer) {
            elements.qrContainer.classList.remove('flash');
            setTimeout(() => elements.qrContainer.classList.add('flash'), 0);
        }
    }

    // Обработчики событий для бокового меню
    if (elements.sidebarToggle) {
        elements.sidebarToggle.addEventListener('click', () => {
            elements.sidebarMenu.style.display = elements.sidebarMenu.style.display === 'block' ? 'none' : 'block';
        });
    }

    if (elements.addDataButton) {
        elements.addDataButton.addEventListener('click', () => {
            elements.rawDataInput.style.display = 'block';
            elements.submitRawDataButton.style.display = 'block';
            elements.statsContainer.style.display = 'none';
        });
    }

    if (elements.submitRawDataButton) {
        elements.submitRawDataButton.addEventListener('click', async () => {
            const rawData = elements.rawDataInput?.value.trim() || '';
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
        });
    }

    if (elements.showStatsButton) {
        elements.showStatsButton.addEventListener('click', async () => {
            elements.rawDataInput.style.display = 'none';
            elements.submitRawDataButton.style.display = 'none';
            elements.statsContainer.style.display = 'block';
            await loadStats();
        });
    }
});
