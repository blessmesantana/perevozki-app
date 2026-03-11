import * as service from './firebase-service.js';
import { createCameraController } from './camera.js';
import { initializeSidebarAdmin } from './couriers.js';
import { parseRawData, saveCourierAndDeliveries } from './deliveries.js';
import { createScannerController } from './scanner.js';
import { createUiController } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
    const dom = {
        cameraIconButton: document.getElementById('cameraIconButton'),
        cameraStopButton: document.getElementById('cameraStopButton'),
        cameraSelect: document.getElementById('cameraSelect'),
        inputModeButton: document.getElementById('inputModeButton'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        manualInputContainer: document.getElementById('manualInputContainer'),
        manualSubmitButton: document.getElementById('manualSubmitButton'),
        manualTransferIdInput: document.getElementById('manualTransferId'),
        qrContainer: document.querySelector('.qr-container'),
        qrIcons: Array.from(document.querySelectorAll('.qr-icon')),
        qrResultOverlay: document.getElementById('qr-result-overlay'),
        qrSpinner: document.getElementById('qrSpinner'),
        resultCourier: document.getElementById('resultCourier'),
        resultDiv: document.getElementById('result'),
        resultPrevious: document.getElementById('resultPrevious'),
        resultRawData: document.getElementById('resultRawData'),
        resultStatus: document.getElementById('resultStatus'),
        resultTransferId: document.getElementById('resultTransferId'),
        scanButton: document.getElementById('scanButton'),
        sidebarDataForm: document.getElementById('sidebarDataForm'),
        sidebarDataInput: document.getElementById('sidebarDataInput'),
        sidebarMenu: document.getElementById('sidebarMenu'),
        sidebarMenuNav: document.querySelector('nav#sidebarMenu'),
        sidebarShowStatsButton: document.getElementById('sidebarShowStatsButton'),
        sidebarToggle: document.getElementById('sidebarToggle'),
        videoElement: document.getElementById('qr-video'),
    };

    const state = {
        availableCameras: [],
        autoRestartAllowed: true,
        cameraMessages: {
            grantedShown: false,
            requestShown: false,
        },
        codeReader: null,
        decodeRunId: 0,
        isProcessing: false,
        lastScanTime: 0,
        restartTimerId: null,
        scanPause: {
            active: false,
            reason: null,
            timerId: null,
        },
        scanSessionId: 0,
        scannerActive: false,
        scannerPhase: 'idle',
        scannerStarting: false,
        selectedCameraId: localStorage.getItem('selectedCameraId') || null,
        stopReason: null,
        stream: null,
    };

    const ui = createUiController({ dom });
    const camera = createCameraController({ state, dom, ui });
    const scanner = createScannerController({
        state,
        service,
        ui,
        camera,
    });

    camera.setScanResultHandler(scanner.handleScanSuccess);

    if (dom.sidebarShowStatsButton) {
        dom.sidebarShowStatsButton.remove();
    }

    initializeSidebarAdmin({
        dom,
        service,
        ui,
    });

    let cameraMenuVisible = false;

    function handleSidebarClose(event) {
        if (!dom.sidebarMenu || !dom.sidebarToggle) {
            return;
        }

        const sidebarLabel = document.querySelector('label[for="sidebarToggle"]');
        const isSidebarOpen = dom.sidebarToggle.checked;

        if (
            isSidebarOpen &&
            !dom.sidebarMenu.contains(event.target) &&
            (!sidebarLabel || !sidebarLabel.contains(event.target))
        ) {
            dom.sidebarToggle.checked = false;
        }
    }

    document.addEventListener('mousedown', handleSidebarClose);
    document.addEventListener('touchstart', handleSidebarClose);

    if (dom.scanButton) {
        dom.scanButton.addEventListener('click', async () => {
            dom.scanButton.classList.add('released');
            ui.clearScanResult();
            ui.hideManualInput();
            ui.setVideoVisible(true);
            ui.setQrViewportState('loading');
            await camera.startQrScanner(state.selectedCameraId);
            window.setTimeout(() => {
                dom.scanButton?.classList.remove('released');
            }, 500);
        });
    }

    if (dom.inputModeButton) {
        dom.inputModeButton.addEventListener('click', () => {
            ui.showManualInput();
            camera.stopQrScanner({ manual: true, reason: 'manual_input' });
            ui.setQrViewportState('idle');
            ui.setVideoVisible(false);
            ui.focusManualInput();
        });
    }

    if (dom.manualSubmitButton) {
        dom.manualSubmitButton.addEventListener('click', async () => {
            const transferId = dom.manualTransferIdInput?.value.trim() || '';

            camera.stopQrScanner({ manual: true, reason: 'manual_input_submit' });
            ui.setQrViewportState('idle');
            ui.setVideoVisible(false);

            if (/^\d{4}$/.test(transferId) || /^\d{10}$/.test(transferId)) {
                await scanner.processTransferId(transferId);
                return;
            }

            ui.showScanResult('error', 'Неверный формат ID', '', '', '');
        });
    }

    if (dom.manualTransferIdInput) {
        dom.manualTransferIdInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                dom.manualSubmitButton?.click();
            }
        });
    }

    if (dom.sidebarDataForm && dom.sidebarDataInput) {
        dom.sidebarDataForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const rawData = dom.sidebarDataInput.value.trim();

            if (!rawData) {
                ui.showScanResult('error', 'Введите данные', '', '', '');
                return;
            }

            let courierName = '';
            let deliveryIds = [];

            try {
                ({ courierName, deliveryIds } = parseRawData(rawData));
            } catch (error) {
                ui.showScanResult('error', 'Ошибка разбора данных', '', '', '');
                return;
            }

            if (!courierName) {
                ui.showScanResult('error', 'Не найдено имя курьера', '', '', '');
                return;
            }

            if (deliveryIds.length === 0) {
                ui.showScanResult('error', 'Не найдены номера передач', '', '', '');
                return;
            }

            try {
                await saveCourierAndDeliveries(service, courierName, deliveryIds);
                dom.sidebarDataInput.value = '';
                ui.showScanResult(
                    'success',
                    '',
                    `Добавлен курьер: ${courierName}`,
                    '',
                    '',
                );
            } catch (error) {
                console.error('Ошибка сохранения данных:', error);
                ui.showScanResult(
                    'error',
                    'Ошибка при сохранении',
                    '',
                    '',
                    '',
                );
            }
        });
    }

    if (dom.cameraIconButton && dom.cameraSelect) {
        dom.cameraIconButton.addEventListener('click', async () => {
            if (!cameraMenuVisible) {
                await camera.updateCameraList();
                dom.cameraSelect.style.display = 'inline-block';
                dom.cameraSelect.focus();
                cameraMenuVisible = true;
                return;
            }

            dom.cameraSelect.style.display = 'none';
            cameraMenuVisible = false;
        });

        dom.cameraSelect.addEventListener('change', async () => {
            cameraMenuVisible = false;
            dom.cameraSelect.style.display = 'none';
            await camera.handleCameraSelection(dom.cameraSelect.value);
        });
    }

    let lastCameraStopAt = 0;

    function handleCameraStop(event) {
        event?.preventDefault?.();
        const now = Date.now();

        if (now - lastCameraStopAt < 300) {
            return;
        }

        lastCameraStopAt = now;

        camera.cancelPendingRestart();
        camera.setAutoRestartAllowed(false);
        camera.stopQrScanner({ manual: true, reason: 'camera_stop_button' });

        if (dom.videoElement?.srcObject?.getTracks) {
            dom.videoElement.srcObject.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch (error) {
                    console.warn('Ошибка принудительной остановки камеры:', error);
                }
            });
        }

        if (dom.videoElement) {
            try {
                dom.videoElement.pause();
            } catch (error) {
                console.warn('Ошибка паузы видеоэлемента:', error);
            }

            dom.videoElement.srcObject = null;
            dom.videoElement.removeAttribute('src');

            try {
                dom.videoElement.load();
            } catch (error) {
                console.warn('Ошибка сброса videoElement:', error);
            }
        }

        state.stream = null;
        state.scannerActive = false;
        state.scannerStarting = false;
        ui.setQrViewportState('idle');
        ui.setVideoVisible(false);
        ui.clearScanResult();

        if (dom.cameraSelect) {
            dom.cameraSelect.style.display = 'none';
        }
        cameraMenuVisible = false;
    }

    if (dom.cameraStopButton) {
        dom.cameraStopButton.addEventListener('pointerup', handleCameraStop);
        dom.cameraStopButton.addEventListener('click', handleCameraStop);
    }
});
