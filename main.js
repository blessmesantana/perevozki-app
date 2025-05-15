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

    let deliveriesCache = {};
    let couriersCache = {};

    // Показ сообщения
    window.showMessage = function (status, message, courier, previousCourier, rawData) {
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
        resultDiv.classList.add('show');

        setTimeout(() => {
            resultDiv.classList.remove('show');
            if (status === 'success' || status === 'already_scanned') {
                startQrScanner();
            }
        }, 5000);
    }

    // Обработчики событий
    if (inputModeButton) {
        inputModeButton.addEventListener('click', () => {
            inputModeButton.classList.add('active');
            manualSubmitButton.classList.add('active');
            inputModeButton.style.display = 'none';
            manualInputContainer.style.display = 'flex';
            stopQrScanner();
            manualTransferIdInput.focus();
        });
    }

    if (manualSubmitButton) {
        manualSubmitButton.addEventListener('click', () => {
            const transferId = manualTransferIdInput.value.trim();
            if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
                processTransferId(transferId);
            } else {
                showMessage('error', 'Неверный формат ID', '', '', '');
            }
        });
    }

    if (manualTransferIdInput) {
        manualTransferIdInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') manualSubmitButton.click();
        });
    }

    if (scanButton) {
        scanButton.addEventListener('click', () => {
            scanButton.classList.add('released');
            startQrScanner();
            setTimeout(() => scanButton.classList.remove('released'), 500);
        });
    }

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebarMenu.style.display = sidebarMenu.style.display === 'block' ? 'none' : 'block';
        });
    }

    if (addDataButton) {
        addDataButton.addEventListener('click', async () => {
            sidebarMenu.style.display = 'block';
            rawDataInput.style.display = 'block';
            submitRawDataButton.style.display = 'block';
            statsContainer.style.display = 'none';
        });
    }

    if (submitRawDataButton) {
        submitRawDataButton.addEventListener('click', async () => {
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
    }

    if (showStatsButton) {
        showStatsButton.addEventListener('click', async () => {
            rawDataInput.style.display = 'none';
            submitRawDataButton.style.display = 'none';
            statsContainer.style.display = 'block';
            await loadStats();
        });
    }

    // Функции
    function parseRawData(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return { courierName: '', deliveryIds: [] };

        // Извлекаем фамилию из первой строки, убираем всё после первого пробела или дефиса
        const firstLine = lines[0];
        const courierNameMatch = firstLine.match(/^[А-Яа-яA-Za-z]+/);
        const courierName = courierNameMatch ? courierNameMatch[0] : '';

        // Извлекаем только 10-значные числа
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

    async function initializeData() {
        try {
            const deliveriesSnapshot = await get(ref(database, 'deliveries'));
            if (deliveriesSnapshot.exists()) {
                deliveriesCache = deliveriesSnapshot.val();
            }

            const couriersSnapshot = await get(ref(database, 'couriers'));
            if (couriersSnapshot.exists()) {
                couriersCache = couriersSnapshot.val();
            }

            console.log("Данные о доставках и курьерах загружены и кэшированы.");
        } catch (error) {
            console.error("Ошибка при загрузке данных:", error);
            showMessage("Ошибка при загрузке данных. Пожалуйста, попробуйте позже.", true);
        }
    }

    async function startQrScanner() {
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
                    facingMode: { exact: "environment" } // Приоритет задней камеры
                }
            });

            videoElement.srcObject = stream;
            await videoElement.play();

            if (!codeReader) {
                codeReader = new ZXing.BrowserMultiFormatReader();
            }

            codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
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
            console.error('Ошибка камеры:', err.name, err.message, err.constraint);
            showMessage('error', 'Ошибка камеры: ' + err.message, '', '', '');
            qrIcon.style.display = 'block';
        }
    }

    function onScanSuccess(decodedText) {
        const now = Date.now();
        if (now - lastScanTime < scanDelay) return;
        lastScanTime = now;

        navigator.vibrate?.(200);
        flashFrame();
        processTransferId(decodedText); // Вызываем processTransferId с результатом сканирования
    }

    function flashFrame() {
        qrContainer.classList.add('flash');
        setTimeout(() => qrContainer.classList.remove('flash'), 300);
    }

    async function processTransferId(transferId) {
        if (isProcessing) return;
        isProcessing = true;
        loadingIndicator.style.display = 'block';

        try {
            const cleanedId = transferId.replace(/\D/g, '');

            // Получаем данные из кэша
            const delivery = deliveriesCache[cleanedId];
            const courier = couriersCache[delivery ? delivery.courier_id : null];

            if (delivery) {
                // Отображаем данные из кэша
                resultTransferId.textContent = `ID передачи: ${cleanedId}`;
                resultCourier.textContent = `Курьер: ${courier ? courier.courier_name : 'Не назначен'}`;
                resultPrevious.textContent = `Предыдущее местоположение: ${delivery.previous_location || 'Неизвестно'}`;
                resultStatus.textContent = `Статус: ${delivery.status}`;
                resultRawData.textContent = JSON.stringify(delivery, null, 2);

                flashFrame(qrContainer, 'green-border');

                // Записываем информацию о сканировании в БД
                try {
                    const scansRef = ref(database, 'scans');
                    await push(scansRef, {
                        delivery_id: cleanedId,
                        courier_name: courier ? courier.courier_name : 'Не назначен',
                        timestamp: Date.now()
                    });
                    console.log("Информация о сканировании сохранена.");
                } catch (e) {
                    console.error("Ошибка при сохранении информации о сканировании:", e);
                    showMessage("Ошибка при сохранении информации о сканировании.", true);
                }

            } else {
                // Отображаем сообщение, что не найдено
                resultTransferId.textContent = `ID передачи: ${cleanedId} не найден`;
                resultCourier.textContent = '';
                resultPrevious.textContent = '';
                resultStatus.textContent = '';
                resultRawData.textContent = '';
                flashFrame(qrContainer, 'red-border');
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
        // Очищаем список более эффективно
        while (statsList.firstChild) {
            statsList.removeChild(statsList.firstChild);
        }

        try {
            const scansRef = ref(database, 'scans');
            const scansQuery = query(scansRef);
            const scansSnapshot = await get(scansQuery);

            if (scansSnapshot.exists()) {
                const fragment = document.createDocumentFragment(); // Используем DocumentFragment
                scansSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    const li = document.createElement('li');
                    const date = new Date(scanData.timestamp).toLocaleString('ru-RU');
                    li.textContent = `ID: ${scanData.delivery_id}, Курьер: ${scanData.courier_name}, Время: ${date}`;
                    fragment.appendChild(li);
                });
                statsList.appendChild(fragment); // Добавляем все элементы за один раз
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
            videoElement.srcObject = null;
        }
        if (codeReader) codeReader.reset();
        qrIcon.style.display = 'block';
        loadingIndicator.style.display = 'none';
    }

    // Загружаем данные при инициализации
    initializeData();
});
