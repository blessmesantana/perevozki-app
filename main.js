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
    const qrResultOverlay = document.getElementById('qr-result-overlay');

    const inputModeButton = document.getElementById('inputModeButton');
    const manualInputContainer = document.getElementById('manualInputContainer');
    const manualTransferIdInput = document.getElementById('manualTransferId');
    const manualSubmitButton = document.getElementById('manualSubmitButton');
    const scanButton = document.getElementById('scanButton');
    const qrContainer = document.querySelector('.qr-container');
    const videoElement = document.getElementById('qr-video');
    const qrIcon = document.querySelector('.qr-icon');
    const loadingIndicator = document.getElementById('loadingIndicator');

    if (qrIcon) qrIcon.style.display = 'block'; // Показываем иконку при загрузке

    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarMenu = document.getElementById('sidebarMenu');
    const addDataButton = document.getElementById('addDataButton');
    const submitRawDataButton = document.getElementById('submitRawDataButton');
    const showStatsButton = document.getElementById('showStatsButton');
    const statsContainer = document.getElementById('statsContainer');
    const statsList = document.getElementById('statsList');
    const rawDataInput = document.getElementById('rawData');

    const sidebarDataForm = document.getElementById('sidebarDataForm');
    const sidebarDataInput = document.getElementById('sidebarDataInput');
    const sidebarShowStatsButton = document.getElementById('sidebarShowStatsButton');
    const sidebarMenuNav = document.querySelector('nav#sidebarMenu');
    const sidebarStatsList = document.createElement('ul');
    sidebarStatsList.style.width = '100%';
    sidebarStatsList.style.background = '#3f51b5';
    sidebarStatsList.style.borderRadius = '5px';
    sidebarStatsList.style.padding = '10px';
    sidebarStatsList.style.marginTop = '10px';
    sidebarStatsList.style.maxHeight = '200px';
    sidebarStatsList.style.overflowY = 'auto';
    let sidebarStatsVisible = false;

    let stream = null;
    let codeReader = null;
    let lastScanTime = 0;
    const scanDelay = 2000;
    let isProcessing = false;

    // Dynamically adjust the overlay width to match the button
    if (inputModeButton && qrResultOverlay) {
        const buttonWidth = inputModeButton.offsetWidth;
        qrResultOverlay.style.width = `${buttonWidth}px`;
    }

    // === ФУНКЦИЯ ДЛЯ СИНХРОНИЗАЦИИ ШИРИНЫ МОДАЛЬНЫХ ОКОН ===
    function setModalContentWidth(modalContent) {
        if (!inputModeButton || !modalContent) return;
        const buttonWidth = inputModeButton.offsetWidth;
        modalContent.style.width = buttonWidth + 'px';
        modalContent.style.minWidth = buttonWidth + 'px';
        modalContent.style.maxWidth = buttonWidth + 'px';
    }

    function syncOverlayStyles() {
        if (inputModeButton && qrResultOverlay) {
            const buttonStyles = window.getComputedStyle(inputModeButton);
            qrResultOverlay.style.width = buttonStyles.width;
            qrResultOverlay.style.borderRadius = buttonStyles.borderRadius;
            qrResultOverlay.style.padding = buttonStyles.padding;
            qrResultOverlay.style.fontFamily = buttonStyles.fontFamily;
            qrResultOverlay.style.fontSize = buttonStyles.fontSize;
            qrResultOverlay.style.fontWeight = buttonStyles.fontWeight;
            qrResultOverlay.style.boxShadow = buttonStyles.boxShadow;
            qrResultOverlay.style.margin = buttonStyles.margin;
        }
    }

    // Показ сообщения
    window.showMessage = function(status, message, courier, previousCourier, rawData) {
        if (!qrResultOverlay) return;
        let text = '';
        let colorClass = '';
        if (status === 'already_scanned') {
            text = courier ? courier : '';
            colorClass = 'already_scanned';
        } else if (status === 'success') {
            text = courier ? courier : '';
            colorClass = 'success';
        } else if (status === 'not_found') {
            text = courier ? courier : '';
            colorClass = 'error';
        } else if (status === 'error') {
            text = message;
            colorClass = 'error';
        } else {
            text = message;
            colorClass = '';
        }
        qrResultOverlay.innerHTML = `<div class='qr-overlay-box'>${text.trim()}</div>`;
        qrResultOverlay.className = `show ${colorClass}`;
        setTimeout(() => {
            qrResultOverlay.className = '';
        }, 2200);
        resultDiv.style.display = 'none';
    }

    // Обработчики событий
    if (inputModeButton) {
        inputModeButton.addEventListener('click', () => {
            inputModeButton.classList.add('active');
            manualInputContainer.classList.add('active');
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

    if (sidebarDataForm && sidebarDataInput) {
        sidebarDataForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = sidebarDataInput.value.trim();
            if (!text) {
                showMessage('error', 'Введите данные', '', '', '');
                return;
            }
            const { courierName, deliveryIds } = parseRawData(text);
            if (!courierName) {
                showMessage('error', 'Не найдено имя курьера', '', '', '');
                return;
            }
            if (deliveryIds.length === 0) {
                showMessage('error', 'Не найдены номера передач', '', '', '');
                return;
            }
            await saveCourierAndDeliveries(courierName, deliveryIds);
            sidebarDataInput.value = '';
        });
    }

    if (sidebarShowStatsButton) sidebarShowStatsButton.remove();
    if (sidebarStatsList) sidebarStatsList.remove();

    // Переименовываем кнопку и переносим в неё функционал показа передач по курьеру
    const processButton = document.createElement('button');
    processButton.textContent = 'Процесс сканирования';
    processButton.id = 'processScanButton';
    processButton.style.background = 'none';
    processButton.style.color = '#fff';
    processButton.style.border = 'none';
    processButton.style.fontSize = '13px';
    processButton.style.fontWeight = '500';
    processButton.style.fontFamily = 'Inter, sans-serif';
    processButton.style.textAlign = 'center';
    processButton.style.borderRadius = '18px';
    processButton.style.transition = 'background 0.2s';
    processButton.style.letterSpacing = 'normal';
    processButton.style.cursor = 'pointer';
    processButton.style.marginTop = '1px';
    processButton.style.padding = '12px 0 10px 0';
    processButton.style.width = '100%';
    sidebarMenuNav.appendChild(processButton);

    // === КНОПКА "АРХИВ" В САЙДБАРЕ ===
    const archiveButton = document.createElement('button');
    archiveButton.id = 'archiveButton';
    archiveButton.style.background = 'none';
    archiveButton.style.color = '#fff';
    archiveButton.style.border = 'none';
    archiveButton.style.fontSize = '13px';
    archiveButton.style.fontWeight = '500';
    archiveButton.style.fontFamily = 'Inter, sans-serif';
    archiveButton.style.textAlign = 'center';
    archiveButton.style.borderRadius = '18px';
    archiveButton.style.transition = 'background 0.2s';
    archiveButton.style.letterSpacing = 'normal';
    archiveButton.style.cursor = 'pointer';
    archiveButton.style.marginTop = 'auto';
    archiveButton.style.marginBottom = '8px';
    archiveButton.style.padding = '12px 0 10px 0';
    archiveButton.style.width = '100%';
    archiveButton.style.display = 'flex';
    archiveButton.style.alignItems = 'center';
    archiveButton.style.justifyContent = 'center';
    // SVG иконка архива (простая папка)
    archiveButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right:7px;"><path d="M2 6.5V16a2 2 0 002 2h12a2 2 0 002-2V6.5M2 6.5L4.5 3h11L18 6.5M2 6.5h16" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Архив`;
    // Вставляем в самый низ сайдбара
    sidebarMenuNav.appendChild(archiveButton);

    // === МОДАЛЬНОЕ ОКНО АРХИВА ===
    let archiveModal = null;
    let archiveModalContent = null;
    archiveButton.addEventListener('click', async () => {
        if (archiveModal) archiveModal.remove();
        archiveModal = document.createElement('div');
        archiveModal.style.position = 'fixed';
        archiveModal.style.top = '0';
        archiveModal.style.left = '0';
        archiveModal.style.width = '100vw';
        archiveModal.style.height = '100vh';
        archiveModal.style.background = 'rgba(0,0,0,0.7)';
        archiveModal.style.display = 'flex';
        archiveModal.style.alignItems = 'center';
        archiveModal.style.justifyContent = 'center';
        archiveModal.style.zIndex = '9999';
        archiveModal.addEventListener('click', () => archiveModal.remove());

        const modalContent = document.createElement('div');
        modalContent.style.background = '#3f51b5';
        modalContent.style.borderRadius = '32px';
        modalContent.style.padding = '32px 24px';
        modalContent.style.color = 'white';
        modalContent.style.textAlign = 'center';
        modalContent.style.position = 'relative';
        modalContent.style.fontFamily = 'Inter, sans-serif';
        modalContent.style.fontSize = '13px';
        modalContent.classList.add('archive-modal-content');
        archiveModalContent = modalContent;
        setModalContentWidth(modalContent);
        // Не закрывать модалку при клике внутри окна
        modalContent.addEventListener('click', e => e.stopPropagation());

        // === Ширина модального окна архива ===
        function setArchiveModalWidth() {
            if (inputModeButton) {
                const w = inputModeButton.offsetWidth;
                modalContent.style.width = w + 'px';
                modalContent.style.minWidth = w + 'px';
                modalContent.style.maxWidth = w + 'px';
            } else {
                modalContent.style.minWidth = '260px';
                modalContent.style.maxWidth = '90vw';
            }
        }
        setArchiveModalWidth();
        window.addEventListener('resize', setArchiveModalWidth);

        // Заголовок
        const title = document.createElement('div');
        title.textContent = 'Архив передач по дате';
        title.style.fontSize = '13px';
        title.style.fontWeight = '500';
        title.style.marginBottom = '18px';
        title.style.fontFamily = 'Inter, sans-serif';
        modalContent.appendChild(title);

        // === ВЫБОР ДАТЫ ===
        // Получаем список дат из архива (пусть структура: archive/YYYY-MM-DD/deliveries, archive/YYYY-MM-DD/scans)
        const archiveRef = ref(database, 'archive');
        const archiveSnap = await get(archiveRef);
        let dateList = [];
        if (archiveSnap.exists()) {
            archiveSnap.forEach(child => {
                dateList.push(child.key); // YYYY-MM-DD
            });
        }
        dateList = dateList.sort((a, b) => b.localeCompare(a)); // новые сверху
        if (dateList.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'Архив пуст.';
            empty.style.margin = '20px 0';
            modalContent.appendChild(empty);
        } else {
            // === КАЛЕНДАРЬ ===
            const dateInput = document.createElement('input');
            dateInput.type = 'date';
            dateInput.style.width = '100%';
            dateInput.style.marginBottom = '18px';
            dateInput.style.fontSize = '13px';
            dateInput.style.padding = '7px 0 7px 10px';
            dateInput.style.borderRadius = '10px';
            dateInput.style.border = 'none';
            dateInput.style.background = '#3f51b5';
            dateInput.style.color = '#fff';
            dateInput.style.fontFamily = 'Inter, sans-serif';
            dateInput.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)';
            dateInput.style.outline = 'none';
            dateInput.style.textAlign = 'left';
            dateInput.classList.add('archive-date-input');
            // Ограничим выбор только существующими датами
            dateInput.min = dateList[dateList.length-1];
            dateInput.max = dateList[0];
            dateInput.value = dateList[0];
            modalContent.appendChild(dateInput);

            // Контейнер для данных архива
            const archiveDataDiv = document.createElement('div');
            archiveDataDiv.style.marginTop = '10px';
            archiveDataDiv.style.textAlign = 'left';
            archiveDataDiv.classList.add('archive-data-div');
            modalContent.appendChild(archiveDataDiv);

            async function loadArchiveForDate(date) {
                archiveDataDiv.innerHTML = '';
                // Получаем данные архива для выбранной даты
                const deliveriesSnap = await get(ref(database, `archive/${date}/deliveries`));
                const scansSnap = await get(ref(database, `archive/${date}/scans`));
                let deliveries = [];
                let scans = [];
                if (deliveriesSnap.exists()) deliveries = deliveriesSnap.val();
                if (scansSnap.exists()) scans = scansSnap.val();
                // Преобразуем в массивы объектов
                deliveries = Array.isArray(deliveries) ? deliveries : (deliveries ? Object.values(deliveries) : []);
                scans = Array.isArray(scans) ? scans : (scans ? Object.values(scans) : []);
                // Формируем списки
                const scannedIds = new Set(scans.map(s => s.delivery_id || s.id));
                const notScanned = deliveries.filter(d => !scannedIds.has(d.id));
                const scannedList = deliveries.filter(d => scannedIds.has(d.id));
                // Заголовки и списки
                const notScannedTitle = document.createElement('div');
                notScannedTitle.textContent = `Неотсканированные (${notScanned.length}):`;
                notScannedTitle.className = 'archive-section-title';
                archiveDataDiv.appendChild(notScannedTitle);
                notScanned.forEach(d => {
                    const el = document.createElement('div');
                    el.textContent = `${d.id} (${d.courier_name})`;
                    el.className = 'archive-list-item not-scanned';
                    archiveDataDiv.appendChild(el);
                });
                const scannedTitle = document.createElement('div');
                scannedTitle.textContent = `Отсканированные (${scannedList.length}):`;
                scannedTitle.className = 'archive-section-title';
                archiveDataDiv.appendChild(scannedTitle);
                scannedList.forEach(d => {
                    const el = document.createElement('div');
                    el.textContent = `${d.id} (${d.courier_name})`;
                    el.className = 'archive-list-item scanned';
                    archiveDataDiv.appendChild(el);
                });
                if (notScanned.length === 0 && scannedList.length === 0) {
                    archiveDataDiv.innerHTML = '<div class="archive-empty">Нет данных за выбранную дату.</div>';
                }
            }

            // При выборе даты
            dateInput.addEventListener('change', e => {
                loadArchiveForDate(e.target.value);
            });
            // По умолчанию — первая дата
            loadArchiveForDate(dateInput.value);
        }

        // === КНОПКА ПЕРЕНОСА В АРХИВ ===
        const moveToArchiveBtn = document.createElement('button');
        moveToArchiveBtn.textContent = 'Перенести в архив';
        moveToArchiveBtn.style.background = '#ea1e63';
        moveToArchiveBtn.style.color = '#fff';
        moveToArchiveBtn.style.border = 'none';
        moveToArchiveBtn.style.borderRadius = '18px';
        moveToArchiveBtn.style.fontSize = '13px';
        moveToArchiveBtn.style.fontWeight = '500';
        moveToArchiveBtn.style.fontFamily = 'Inter, sans-serif';
        moveToArchiveBtn.style.padding = '12px 0 10px 0';
        moveToArchiveBtn.style.width = '100%';
        moveToArchiveBtn.style.marginTop = '18px';
        moveToArchiveBtn.style.cursor = 'pointer';
        moveToArchiveBtn.classList.add('archive-move-btn');
        modalContent.appendChild(moveToArchiveBtn);

        moveToArchiveBtn.addEventListener('click', async () => {
            // Окно подтверждения
            const confirmModal = document.createElement('div');
            confirmModal.style.position = 'fixed';
            confirmModal.style.top = '0';
            confirmModal.style.left = '0';
            confirmModal.style.width = '100vw';
            confirmModal.style.height = '100vh';
            confirmModal.style.background = 'rgba(0,0,0,0.7)';
            confirmModal.style.display = 'flex';
            confirmModal.style.alignItems = 'center';
            confirmModal.style.justifyContent = 'center';
            confirmModal.style.zIndex = '10000';
            confirmModal.addEventListener('click', () => confirmModal.remove());

            const confirmBox = document.createElement('div');
            confirmBox.style.background = '#3f51b5';
            confirmBox.style.borderRadius = '24px';
            confirmBox.style.padding = '28px 20px';
            confirmBox.style.color = 'white';
            confirmBox.style.textAlign = 'center';
            confirmBox.style.position = 'relative';
            confirmBox.style.fontFamily = 'Inter, sans-serif';
            confirmBox.style.fontSize = '15px';
            confirmBox.classList.add('archive-confirm-box');
            // === Ширина окна подтверждения ===
            function setConfirmBoxWidth() {
                if (inputModeButton) {
                    const w = inputModeButton.offsetWidth;
                    confirmBox.style.width = w + 'px';
                    confirmBox.style.minWidth = w + 'px';
                    confirmBox.style.maxWidth = w + 'px';
                } else {
                    confirmBox.style.minWidth = '220px';
                    confirmBox.style.maxWidth = '90vw';
                }
            }
            setConfirmBoxWidth();
            window.addEventListener('resize', setConfirmBoxWidth);

            confirmBox.innerHTML = '<div style="margin-bottom:18px;">Вы уверены, что хотите перенести все данные в архив?<br><span style="font-size:13px;opacity:0.7;">(deliveries и scans будут очищены)</span></div>';
            const yesBtn = document.createElement('button');
            yesBtn.textContent = 'Да, перенести';
            yesBtn.style.background = '#ea1e63';
            yesBtn.style.color = '#fff';
            yesBtn.style.border = 'none';
            yesBtn.style.borderRadius = '18px';
            yesBtn.style.fontSize = '13px';
            yesBtn.style.fontWeight = '500';
            yesBtn.style.fontFamily = 'Inter, sans-serif';
            yesBtn.style.padding = '10px 0';
            yesBtn.style.width = '100%';
            yesBtn.style.cursor = 'pointer';
            yesBtn.style.marginBottom = '10px';
            yesBtn.classList.add('archive-confirm-btn');
            const noBtn = document.createElement('button');
            noBtn.textContent = 'Отмена';
            noBtn.style.background = 'none';
            noBtn.style.color = '#fff';
            noBtn.style.border = '1px solid #fff';
            noBtn.style.borderRadius = '18px';
            noBtn.style.fontSize = '13px';
            noBtn.style.fontWeight = '500';
            noBtn.style.fontFamily = 'Inter, sans-serif';
            noBtn.style.padding = '10px 0';
            noBtn.style.width = '100%';
            noBtn.style.cursor = 'pointer';
            noBtn.classList.add('archive-cancel-btn');
            confirmBox.appendChild(yesBtn);
            confirmBox.appendChild(noBtn);
            confirmModal.appendChild(confirmBox);
            document.body.appendChild(confirmModal);
            noBtn.addEventListener('click', () => confirmModal.remove());
            yesBtn.addEventListener('click', async () => {
                yesBtn.disabled = true;
                yesBtn.textContent = 'Перенос...';
                // Получаем все deliveries и scans
                try {
                    const [delSnap, scanSnap] = await Promise.all([
                        get(ref(database, 'deliveries')),
                        get(ref(database, 'scans'))
                    ]);
                    const deliveries = [];
                    if (delSnap.exists()) delSnap.forEach(child => deliveries.push(child.val()));
                    const scans = [];
                    if (scanSnap.exists()) scanSnap.forEach(child => scans.push(child.val()));
                    // Дата для архива
                    const now = new Date();
                    const pad = n => n.toString().padStart(2, '0');
                    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
                    // Записываем в archive
                    await set(ref(database, `archive/${dateStr}/deliveries`), deliveries);
                    await set(ref(database, `archive/${dateStr}/scans`), scans);
                    // Очищаем deliveries и scans
                    await set(ref(database, 'deliveries'), null);
                    await set(ref(database, 'scans'), null);
                    yesBtn.textContent = 'Готово!';
                    setTimeout(() => {
                        confirmModal.remove();
                        archiveModal.remove();
                        window.showMessage('success', '', '', '', 'Данные перенесены в архив!');
                    }, 1200);
                } catch (e) {
                    yesBtn.textContent = 'Ошибка!';
                    yesBtn.style.background = '#ea1e63';
                    setTimeout(() => confirmModal.remove(), 2000);
                }
            });
        });

        archiveModal.appendChild(modalContent);
        document.body.appendChild(archiveModal);
    });

    // Модальное окно для вывода статистики по курьеру (оставляем как было)
    let courierStatsModal = null;
    let courierStatsModalContent = null;
    function showCourierStatsModal(courierName) {
        if (courierStatsModal) courierStatsModal.remove();
        courierStatsModal = document.createElement('div');
        courierStatsModal.style.position = 'fixed';
        courierStatsModal.style.top = '0';
        courierStatsModal.style.left = '0';
        courierStatsModal.style.width = '100vw';
        courierStatsModal.style.height = '100vh';
        courierStatsModal.style.background = 'rgba(0,0,0,0.7)';
        courierStatsModal.style.display = 'flex';
        courierStatsModal.style.alignItems = 'center';
        courierStatsModal.style.justifyContent = 'center';
        courierStatsModal.style.zIndex = '9999';
        courierStatsModal.addEventListener('click', () => courierStatsModal.remove());

        const modalContent = document.createElement('div');
        modalContent.style.background = '#3f51b5';
        modalContent.style.borderRadius = '32px';
        modalContent.style.padding = '32px 24px';
        modalContent.style.color = 'white';
        modalContent.style.textAlign = 'center';
        modalContent.style.position = 'relative';
        modalContent.style.fontFamily = 'Inter, sans-serif';
        modalContent.style.fontSize = '13px';
        courierStatsModalContent = modalContent;
        setModalContentWidth(modalContent);

        const title = document.createElement('div');
        title.textContent = courierName;
        title.style.fontSize = '13px';
        title.style.fontWeight = '500';
        title.style.marginBottom = '18px';
        title.style.fontFamily = 'Inter, sans-serif';
        modalContent.appendChild(title);

        // Добавим кнопку закрытия для удобства
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.top = '12px';
        closeBtn.style.right = '18px';
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#fff';
        closeBtn.style.fontSize = '22px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontFamily = 'Inter, sans-serif';
        closeBtn.addEventListener('click', () => courierStatsModal.remove());
        modalContent.appendChild(closeBtn);

        // Получаем все передачи и сканы для этого курьера
        Promise.all([
            get(query(ref(database, 'deliveries'))),
            get(query(ref(database, 'scans')))
        ]).then(([deliveriesSnap, scansSnap]) => {
            const allDeliveries = [];
            if (deliveriesSnap.exists()) {
                deliveriesSnap.forEach(child => {
                    const d = child.val();
                    if (d.courier_name === courierName) allDeliveries.push(d.id);
                });
            }
            const scanned = new Set();
            if (scansSnap.exists()) {
                scansSnap.forEach(child => {
                    const s = child.val();
                    if (s.courier_name === courierName) scanned.add(s.delivery_id);
                });
            }
            // Неотсканированные сверху, отсканированные снизу (opacity 0.6)
            const notScanned = allDeliveries.filter(id => !scanned.has(id));
            const scannedList = allDeliveries.filter(id => scanned.has(id));
            const list = document.createElement('div');
            list.style.display = 'flex';
            list.style.flexDirection = 'column';
            list.style.gap = '6px';
            notScanned.forEach(id => {
                const el = document.createElement('div');
                el.textContent = id;
                el.style.fontSize = '13px';
                el.style.opacity = '1';
                el.style.transition = 'opacity 0.3s';
                el.style.fontFamily = 'Inter, sans-serif';
                list.appendChild(el);
            });
            scannedList.forEach(id => {
                const el = document.createElement('div');
                el.textContent = id;
                el.style.fontSize = '13px';
                el.style.opacity = '0.6';
                el.style.transition = 'opacity 0.3s';
                el.style.fontFamily = 'Inter, sans-serif';
                list.appendChild(el);
            });
            modalContent.appendChild(list);
        });

        courierStatsModal.appendChild(modalContent);
        document.body.appendChild(courierStatsModal);
    }

    processButton.addEventListener('click', async () => {
        // Получаем список всех курьеров
        const couriersSnap = await get(query(ref(database, 'couriers')));
        let couriers = [];
        if (couriersSnap.exists()) {
            couriersSnap.forEach(child => {
                const c = child.val();
                if (c.name) couriers.push(c.name);
            });
        }
        couriers = [...new Set(couriers)];
        // Показываем выбор курьера
        const selectModal = document.createElement('div');
        selectModal.style.position = 'fixed';
        selectModal.style.top = '0';
        selectModal.style.left = '0';
        selectModal.style.width = '100vw';
        selectModal.style.height = '100vh';
        selectModal.style.background = 'rgba(0,0,0,0.7)';
        selectModal.style.display = 'flex';
        selectModal.style.alignItems = 'center';
        selectModal.style.justifyContent = 'center';
        selectModal.style.zIndex = '9999';
        selectModal.addEventListener('click', () => selectModal.remove());
        const modalContent = document.createElement('div');
        modalContent.style.background = '#3f51b5';
        modalContent.style.borderRadius = '32px';
        modalContent.style.padding = '32px 24px';
        modalContent.style.color = 'white';
        modalContent.style.textAlign = 'center';
        modalContent.style.position = 'relative';
        modalContent.style.fontFamily = 'Inter, sans-serif';
        modalContent.style.fontSize = '13px';
        setModalContentWidth(modalContent);

        const title = document.createElement('div');
        title.textContent = 'Выберите курьера';
        title.style.fontSize = '13px';
        title.style.fontWeight = '500';
        title.style.marginBottom = '18px';
        title.style.fontFamily = 'Inter, sans-serif';
        modalContent.appendChild(title);
        couriers.forEach(name => {
            const btn = document.createElement('button');
            btn.textContent = name;
            btn.style.display = 'block';
            btn.style.width = '100%';
            btn.style.margin = '8px 0';
            btn.style.padding = '10px 0';
            btn.style.background = '#ea1e63';
            btn.style.color = 'white';
            btn.style.border = 'none';
            btn.style.borderRadius = '18px';
            btn.style.fontSize = '13px';
            btn.style.fontWeight = '500';
            btn.style.fontFamily = 'Inter, sans-serif';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', () => {
                selectModal.remove();
                showCourierStatsModal(name);
            });
            modalContent.appendChild(btn);
        });
        selectModal.appendChild(modalContent);
        document.body.appendChild(selectModal);
    });

    // === ОБНОВЛЕНИЕ ШИРИНЫ И СТИЛЕЙ МОДАЛОК И ВСПЛЫВАЮЩИХ ОКОН ПРИ РЕСАЙЗЕ ===
    function updateAllModalWidths() {
        setModalContentWidth(archiveModalContent);
        setModalContentWidth(courierStatsModalContent);
        // Для selectModal ищем по классу, т.к. он создается динамически
        const selectModalContent = document.querySelector('.select-modal-content');
        if (selectModalContent) setModalContentWidth(selectModalContent);
        // Для всплывающего окна результата
        syncOverlayStyles();
    }
    window.addEventListener('resize', updateAllModalWidths);
    updateAllModalWidths();

    // Функции
    function parseRawData(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return { courierName: '', deliveryIds: [] };

        // Фамилия — только первое слово первой строки, только буквы (рус/лат)
        const firstLine = lines[0];
        const courierNameMatch = firstLine.match(/^([А-Яа-яA-Za-z]+)/);
        const courierName = courierNameMatch ? courierNameMatch[1] : '';

        // Все 10-значные числа из всех строк
        const deliveryIds = lines
            .map(line => line.match(/\b\d{10}\b/g))
            .filter(Boolean)
            .flat();

        return { courierName, deliveryIds };
    }

    async function saveCourierAndDeliveries(courierName, deliveryIds) {
        if (!courierName || deliveryIds.length === 0) {
            showMessage('error', 'Нет данных для сохранения', '', '', '');
            return;
        }

        try {
            console.log('Сохранение курьера:', courierName, 'и передач:', deliveryIds);

            const couriersRef = ref(database, 'couriers');
            const deliveriesRef = ref(database, 'deliveries');

            const newCourierRef = push(couriersRef);
            await set(newCourierRef, {
                name: courierName,
                timestamp: Date.now()
            });

            const courierId = newCourierRef.key;

            console.log('Курьер сохранен с ID:', courierId);

            for (const id of deliveryIds) {
                const newDeliveryRef = push(deliveriesRef);
                await set(newDeliveryRef, {
                    id,
                    courier_id: courierId,
                    courier_name: courierName,
                    timestamp: Date.now()
                });

                console.log('Передача сохранена с ID:', id);
            }

            showMessage('success', '', `Добавлен курьер: ${courierName}`, `Передач: ${deliveryIds.length}`);
        } catch (e) {
            console.error("Ошибка сохранения в Firebase: ", e);
            showMessage('error', 'Ошибка при сохранении', '', '', '');
        }
    }

    async function startQrScanner() {
        try {
            if (qrIcon) qrIcon.style.display = 'none'; // Скрываем иконку при открытии камеры
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
            // Из QR берем только первое 10-значное число
            const match = transferId.match(/\b\d{10}\b/);
            const cleanedId = match ? match[0] : '';

            if (!cleanedId) {
                showMessage('error', 'Неверный формат QR', '', '', '');
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
        console.log('Загрузка статистики...');
        try {
            const scansRef = ref(database, 'scans');
            const scansQuery = query(scansRef);
            const scansSnapshot = await get(scansQuery);

            if (scansSnapshot.exists()) {
                scansSnapshot.forEach(scanSnap => {
                    const scanData = scanSnap.val();
                    console.log('Сканирование:', scanData);
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
            console.log('Статистика загружена успешно.');
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
});
