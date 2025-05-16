// main.js

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getDatabase, ref, push, set, get, query } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { BrowserMultiFormatReader, NotFoundException } from 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.0.10/esm/index.min.js';
import { database } from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded');
  let stream = null;
  let codeReader = null;
  let lastScanTime = 0;
  const scanDelay = 2000;
  let isProcessing = false;

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

  // Message display
  window.showMessage = (status, message, courier = '', previous = '', raw = '') => {
    console.log('Show message', status, message);
    resultDiv.className = `scan-result ${status}`;
    const idMatch = message.match(/\d{10}/);
    const id = idMatch ? idMatch[0] : message;

    resultTransferId.textContent = id;
    resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
    resultPrevious.textContent = previous;
    resultStatus.textContent = status === 'already_scanned' ? 'Повторное сканирование' :
      status === 'success' ? 'Успешно' : status === 'not_found' ? 'Не найдено' : message;
    resultRawData.textContent = raw ? `Сырые данные: ${raw}` : '';
    resultDiv.style.display = 'flex';

    setTimeout(() => {
      resultDiv.style.display = 'none';
      if (['success', 'already_scanned'].includes(status)) startQrScanner();
    }, 5000);
  };

  // Handlers
  inputModeButton?.addEventListener('click', () => {
    console.log('Manual mode');
    inputModeButton.classList.add('active');
    manualSubmitButton.classList.add('active');
    inputModeButton.style.display = 'none';
    manualInputContainer.style.display = 'flex';
    stopQrScanner();
    manualTransferIdInput.focus();
  });

  manualSubmitButton?.addEventListener('click', () => {
    console.log('Manual submit');
    const val = manualTransferIdInput.value.trim();
    if (/^\d{4}$/.test(val) || /^\d{10}$/.test(val)) processTransferId(val);
    else showMessage('error', 'Неверный формат ID');
  });

  scanButton?.addEventListener('click', () => {
    console.log('Scan button');
    scanButton.classList.add('released');
    startQrScanner();
    setTimeout(() => scanButton.classList.remove('released'), 500);
  });

  // QR Scanner
  async function startQrScanner() {
    try {
      console.log('Starting scanner');
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      const camera = cameras.find(c => c.label?.toLowerCase().includes('back')) || cameras[0];
      if (!camera) return showMessage('error', 'Камеры не найдены');

      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'environment' } } });
      videoElement.srcObject = stream;
      await videoElement.play();

      if (!codeReader) codeReader = new BrowserMultiFormatReader();
      codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
        if (result) {
          console.log('Decoded', result.getText());
          const raw = result.getText();
          const ex = raw.match(/\d{10}/)?.[0];
          if (ex) processTransferId(ex, raw);
          else showMessage('error', 'Неверный формат QR', '', '', raw);
          codeReader.reset();
          stopQrScanner();
        }
        if (err && !(err instanceof NotFoundException)) console.error(err);
      });
    } catch (e) {
      console.error(e);
      showMessage('error', e.message);
    }
  }

  function stopQrScanner() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; videoElement.srcObject = null; }
    codeReader?.reset();
    loadingIndicator.style.display = 'none';
  }

  // Process ID
  async function processTransferId(id, raw = '') {
    if (isProcessing) return;
    isProcessing = true;
    loadingIndicator.style.display = 'block';
    try {
      const snap = await get(query(ref(database, 'deliveries')));
      let found = false, courier = '';
      snap.forEach(s => { if (s.val().id === id) { found = true; courier = s.val().courier_name; }});
      if (!found) return showMessage('not_found', id, '', '', raw);

      const scanSnap = await get(query(ref(database, 'scans')));
      let dup = false, prev = '';
      scanSnap.forEach(s => { if (s.val().delivery_id === id) { dup = true; prev = s.val().courier_name; }});
      if (dup) showMessage('already_scanned', id, courier, `Ранее: ${prev}`, raw);
      else {
        await set(push(ref(database, 'scans')), { delivery_id: id, courier_name: courier, timestamp: Date.now() });
        showMessage('success', id, courier, '', raw);
      }
    } catch (e) { console.error(e); showMessage('error', 'Ошибка при поиске', '', '', raw); }
    finally { loadingIndicator.style.display = 'none'; isProcessing = false; }
  }
});
