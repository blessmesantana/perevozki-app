// main.js

import { database } from './firebase.js';
import { ref, push, set, get, query } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { BrowserMultiFormatReader, NotFoundException } from 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.0.10/esm/index.min.js';

document.addEventListener("DOMContentLoaded", () => {
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

  window.showMessage = (status, message, courier, previousCourier, rawData) => {
    resultDiv.className = `scan-result ${status}`;
    const match = message.match(/\d{10}/);
    const transferId = match ? match[0] : message;

    resultTransferId.textContent = transferId;
    resultCourier.textContent = courier ? `Курьер: ${courier}` : '';
    resultPrevious.textContent = previousCourier || '';
    resultStatus.textContent = status === 'already_scanned' ? 'Повторное сканирование' : status === 'success' ? 'Успешно' : status === 'not_found' ? 'Не найдено' : message;
    resultRawData.textContent = rawData ? `Сырые данные: ${rawData}` : '';
    resultDiv.style.display = 'flex';

    setTimeout(() => {
      resultDiv.style.display = 'none';
      if (status === 'success' || status === 'already_scanned') {
        startQrScanner();
      }
    }, 5000);
  };

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
    if (!rawData) return showMessage('error', 'Введите данные', '', '', '');

    const { courierName, deliveryIds } = parseRawData(rawData);
    if (!courierName || deliveryIds.length === 0) return showMessage('error', 'Проверьте данные', '', '', '');

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
    const courierName = lines[0]?.match(/^[А-Яа-яA-Za-z]+/)?.[0] || '';
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
        await set(newDeliveryRef, { id, courier_id: courierId, courier_name: courierName, timestamp: Date.now() });
      }

      showMessage('success', '', courierName, `Передач: ${deliveryIds.length}`);
    } catch (e) {
      console.error(e);
      showMessage('error', 'Ошибка при сохранении', '', '', '');
    }
  }

  async function startQrScanner() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      const camera = cameras.find(c => c.label?.toLowerCase().includes('back')) || cameras[0];

      if (!camera) return showMessage('error', 'Камеры не найдены', '', '', '');

      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" } } });
      videoElement.srcObject = stream;
      await videoElement.play();

      if (!codeReader) codeReader = new BrowserMultiFormatReader();
      codeReader.decodeFromVideoDevice(camera.deviceId, 'qr-video', (result, err) => {
        if (result) {
          const raw = result.getText();
          const extracted = raw.match(/\d{10}/)?.[0];
          if (extracted) onScanSuccess(extracted, raw);
          else showMessage('error', 'Неверный формат QR', '', '', raw);
          codeReader.reset();
          stopQrScanner();
        }
        if (err && !(err instanceof NotFoundException)) console.error(err);
      });
    } catch (err) {
      console.error(err);
      showMessage('error', err.message, '', '', '');
    }
  }

  function onScanSuccess(id, raw) {
    const now = Date.now();
    if (now - lastScanTime < scanDelay) return;
    lastScanTime = now;
    navigator.vibrate?.(200);
    qrContainer.classList.add('flash');
    processTransferId(id, raw);
  }

  async function processTransferId(id, raw = '') {
    if (isProcessing) return;
    isProcessing = true;
    loadingIndicator.style.display = 'block';

    try {
      const snapshot = await get(query(ref(database, 'deliveries')));
      let found = false;
      let courierName='', prev='';

      snapshot.forEach(s => { const d = s.val(); if (d.id === id) { found=true; courierName=d.courier_name; }});
      if (!found) return showMessage('not_found', id, '', '', raw);

      const scans = await get(query(ref(database, 'scans')));
      let dup=false;
      scans.forEach(s => { if (s.val().delivery_id===id) {dup=true; prev=s.val().courier_name;}});

      if (dup) showMessage('already_scanned', id, courierName, `Ранее: ${prev}`, raw);
      else {
        await set(push(ref(database, 'scans')), { delivery_id:id, courier_name:courierName, timestamp:Date.now() });
        showMessage('success', id, courierName, '', raw);
      }
    } catch (e) { console.error(e); showMessage('error','Ошибка при поиске','','',raw); }
    finally { loadingIndicator.style.display='none'; isProcessing=false; }
  }

  async function loadStats() {
    statsList.innerHTML='';
    try {
      const data = await get(query(ref(database,'scans')));
      if (!data.exists()) return statsList.innerHTML='<li>Сканирований нет</li>';
      data.forEach(s=>{ const d=s.val(); const li=document.createElement('li'); li.textContent=`ID:${d.delivery_id}, Курьер:${d.courier_name}, ${new Date(d.timestamp).toLocaleString()}`; statsList.appendChild(li); });
    } catch(e){ console.error(e); statsList.innerHTML='<li>Ошибка</li>'; }
  }

  function stopQrScanner() {
    if (stream) { stream.getTracks().forEach(t=>t.stop()); stream=null; videoElement.srcObject=null; }
    codeReader?.reset();
    loadingIndicator.style.display='none';
  }
});
