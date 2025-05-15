// main.js

// 1. Импорты
import { db } from './firebase.js';
import { collection, addDoc, query, where, getDocs } from 'firebase/firestore';

// 2. DOM элементы
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

let codeReader = null;
let stream = null;
let lastScanTime = 0;
const scanDelay = 2000; // Задержка между сканированиями в мс
let isProcessing = false;

// 3. Функция показа результата
function showMessage(status, transferId = '', courier = '', previousCourier = '') {
    resultTransferId.textContent = transferId || '';
    resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
    resultPrevious.textContent = previousCourier || '';
    resultStatus.textContent =
        status === 'already_scanned' ? 'Повторное сканирование' :
        status === 'success' ? 'Успешно' :
        status === 'not_found' ? 'Не найдено' :
        'Ошибка';

    resultDiv.className = `scan-result ${status}`;
    resultDiv.style.display = 'flex';

    setTimeout(() => {
        resultDiv.style.display = 'none';
        if (status === 'success' || status === 'already_scanned') {
            startQrScanner();
        }
    }, 5000);
}

// 4. Вибрация после сканирования
function vibrateDevice(duration = 200) {
    if ('vibrate' in navigator) {
        navigator.vibrate(duration);
    }
}

// 5. Получение доступных камер
async function getAvailableCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter(device => device.kind === 'videoinput');
        return cameras.length > 0 ? cameras[0] : null;
    } catch (err) {
        console.error('Не удалось получить список камер', err);
        return null;
    }
}

// 6. Инициализация сканера ZXing
async function startQrScanner() {
    try {
        const camera = await getAvailableCameras();
        if (!camera) {
            showMessage('error', '', 'Камера не найдена');
            qrIcon.style.display = 'block';
            return;
        }

        stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: camera.deviceId } },
        });

        videoElement.srcObject = stream;
        await videoElement.play();

        qrIcon.style.display = 'none';

        if (!codeReader) {
            codeReader = new ZXing.BrowserMultiFormatReader();
        }

        codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
            if (result) {
                onScanSuccess(result.getText());
                stopQrScanner();
            }

            if (err && !(err instanceof ZXing.NotFoundException)) {
                console.error('Ошибка сканирования:', err);
            }
        });
    } catch (err) {
        console.error('Ошибка запуска камеры:', err);
        showMessage('error', '', 'Ошибка камеры');
        qrIcon.style.display = 'block';
    }
}

// 7. Обработка успешного сканирования
function onScanSuccess(decodedText) {
    const now = Date.now();
    if (now - lastScanTime < scanDelay) return;
    lastScanTime = now;

    vibrateDevice();
    flashFrame();

    processTransferId(decodedText);
}

// 8. Анимация рамки вокруг QR
function flashFrame() {
    qrContainer.classList.remove('flash');
    setTimeout(() => qrContainer.classList.add('flash'), 0);
}

// 9. Остановка сканера
function stopQrScanner() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        videoElement.srcObject = null;
    }
    if (codeReader) {
        codeReader.reset();
    }
    qrIcon.style.display = 'block';
    loadingIndicator.style.display = 'none';
}

// 10. Обработка ID передачи
async function processTransferId(transferId) {
    if (isProcessing) return;
    isProcessing = true;

    loadingIndicator.style.display = 'block';

    try {
        const cleanedId = transferId.replace(/[^\d]/g, '');

        if (cleanedId.length !== 4 && cleanedId.length !== 10) {
            showMessage('error', cleanedId, '', '');
            isProcessing = false;
            return;
        }

        const q = query(collection(db, 'deliveries'), where('id', '==', cleanedId));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            const data = doc.data();

            const courierName = data.courier_name || 'Неизвестный курьер';
            const duplicateCheck = query(collection(db, 'scans'), where('delivery_id', '==', cleanedId));
            const duplicateSnapshot = await getDocs(duplicateCheck);

            if (!duplicateSnapshot.empty) {
                const prevScan = duplicateSnapshot.docs[0].data();
                showMessage('already_scanned', cleanedId, courierName, `Ранее сканировал: ${prevScan.courier_name}`);
            } else {
                await addDoc(collection(db, 'scans'), {
                    delivery_id: cleanedId,
                    courier_name: courierName,
                    timestamp: new Date(),
                });
                showMessage('success', cleanedId, courierName);
            }
        } else {
            showMessage('not_found', cleanedId);
        }
    } catch (e) {
        console.error('Ошибка базы данных:', e);
        showMessage('error', cleanedId);
    } finally {
        loadingIndicator.style.display = 'none';
        isProcessing = false;
    }
}

// 11. Парсинг сырых данных
function parseRawData(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const courierName = lines[0];
    const deliveryIds = lines.filter(line => /^\d{10}$/.test(line));
    return { courierName, deliveryIds };
}

// 12. Обработка события кнопок
document.getElementById('scanButton').addEventListener('click', () => {
    scanButton.classList.add('released');
    startQrScanner();
    setTimeout(() => scanButton.classList.remove('released'), 500);
});

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
        showMessage('error', transferId, 'Неверный формат ID');
    }
});

manualTransferIdInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') manualSubmitButton.click();
});
