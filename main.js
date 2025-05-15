import { db } from './firebase.js';
import { collection, addDoc, query, where, getDocs } from 'firebase/firestore';

document.addEventListener("DOMContentLoaded", function () {
    // DOM элементы
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
    const addDataButton = document.getElementById('add-data-button');
    const rawDataInput = document.getElementById('raw-data');

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;

    // Проверка доступа к камере
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showMessage('error', 'Камера недоступна на этом устройстве', '', '', '');
        return;
    }

    // Обработчики событий
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
        startQrScanner();
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

    // Основные функции
    function showMessage(status, message, courier, previousCourier, rawData) {
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

    async function getAvailableCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(device => device.kind === 'videoinput');
            return cameras.length > 0 ? cameras[0] : null;
        } catch (err) {
            console.error('Ошибка получения камер:', err);
            showMessage('error', 'Не удалось получить список камер', '', '', '');
            return null;
        }
    }

    async function startQrScanner() {
        try {
            inputModeButton.classList.remove('active');
            manualSubmitButton.classList.remove('active');
            inputModeButton.style.display = 'flex';
            manualInputContainer.style.display = 'none';
            loadingIndicator.style.display = 'none';
            qrIcon.style.display = 'none';

            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
                videoElement.srcObject = null;
            }

            const selectedCamera = await getAvailableCameras();
            if (!selectedCamera) {
                showMessage('error', 'Камеры не найдены на устройстве', '', '', '');
                qrIcon.style.display = 'block';
                return;
            }

            stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: selectedCamera.deviceId } },
            });
            videoElement.srcObject = stream;
            await videoElement.play();

            if (!codeReader) {
                codeReader = new ZXing.BrowserMultiFormatReader();
            }

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
            console.error('Ошибка запуска камеры:', err);
            showMessage('error', 'Ошибка камеры', '', '', '');
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

            const q = query(collection(db, 'deliveries'), where('id', '==', cleanedId));
            const snapshot = await getDocs(q);

            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                const data = doc.data();
                const courierName = data.courier_name;
                
                const duplicateCheck = query(collection(db, 'scans'), where('delivery_id', '==', cleanedId));
                const duplicateSnapshot = await getDocs(duplicateCheck);

                if (!duplicateSnapshot.empty) {
                    const prevScan = duplicateSnapshot.docs[0].data();
                    showMessage('already_scanned', cleanedId, courierName, `Ранее сканировал: ${prevScan.courier_name}`, transferId);
                } else {
                    await addDoc(collection(db, 'scans'), {
                        delivery_id: cleanedId,
                        courier_name: courierName,
                        timestamp: new Date()
                    });
                    showMessage('success', cleanedId, courierName, '', transferId);
                }
            } else {
                showMessage('not_found', cleanedId, '', '', '');
            }
        } catch (e) {
            console.error('Ошибка базы данных:', e);
            showMessage('error', 'Ошибка при поиске', '', '', '');
        } finally {
            loadingIndicator.style.display = 'none';
            isProcessing = false;
        }
    }

    function parseRawData(text) {
        const lines = text
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        const courierName = lines[0];
        const deliveryIds = lines
            .slice(1)
            .filter(line => /^\d{10}$/.test(line));
        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        if (!courierName || deliveryIds.length === 0) {
            showMessage('error', 'Нет данных для сохранения', '', '', '');
            return;
        }

        try {
            const courierQuery = query(collection(db, 'couriers'), where('name', '==', courierName));
            const courierSnapshot = await getDocs(courierQuery);
            let courierId;

            if (!courierSnapshot.empty) {
                courierId = courierSnapshot.docs[0].id;
                showMessage('already_scanned', 'Курьер уже существует', '', `Добавлено: ${deliveryIds.length} передач`, '');
            } else {
                const courierRef = await addDoc(collection(db, 'couriers'), {
                    name: courierName,
                    created_at: new Date()
                });
                courierId = courierRef.id;
                showMessage('success', `Добавлен курьер: ${courierName}`, '', `Передач: ${deliveryIds.length}`, '');
            }

            for (const id of deliveryIds) {
                const deliveryQuery = query(collection(db, 'deliveries'), where('id', '==', id));
                const deliverySnapshot = await getDocs(deliveryQuery);
                
                if (deliverySnapshot.empty) {
                    await addDoc(collection(db, 'deliveries'), {
                        id,
                        courier_id: courierId,
                        courier_name: courierName,
                        created_at: new Date()
                    });
                }
            }
        } catch (e) {
            console.error("Ошибка сохранения в Firestore: ", e);
            showMessage('error', 'Ошибка при сохранении', '', '', '');
        }
    }
});
