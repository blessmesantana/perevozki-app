function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function getZxingReader() {
    if (!window.ZXing?.BrowserMultiFormatReader) {
        throw new Error('ZXing не загружен');
    }

    return window.ZXing;
}

export function createCameraController({ state, dom, ui }) {
    let scanResultHandler = null;

    function setScannerPhase(phase) {
        state.scannerPhase = phase;
    }

    function setScanResultHandler(handler) {
        scanResultHandler = handler;
    }

    function setAutoRestartAllowed(isAllowed) {
        state.autoRestartAllowed = isAllowed;
    }

    function isScannerActive() {
        return Boolean(state.scannerActive);
    }

    function ensurePauseState() {
        if (!state.scanPause) {
            state.scanPause = {
                active: false,
                reason: null,
                timerId: null,
            };
        }

        return state.scanPause;
    }

    function clearPauseTimer() {
        const pauseState = ensurePauseState();

        if (pauseState.timerId) {
            window.clearTimeout(pauseState.timerId);
            pauseState.timerId = null;
        }
    }

    function cancelPendingRestart() {
        if (state.restartTimerId) {
            window.clearTimeout(state.restartTimerId);
            state.restartTimerId = null;
        }
    }

    function setScanPause(reason) {
        const pauseState = ensurePauseState();
        pauseState.active = true;
        pauseState.reason = reason || 'temporary';
        ui.showScanPauseOverlay();
        ui.setQrViewportState('paused');
    }

    function clearScanPause() {
        const pauseState = ensurePauseState();
        clearPauseTimer();
        pauseState.active = false;
        pauseState.reason = null;
        ui.hideScanPauseOverlay();

        if (!isScannerActive()) {
            ui.setQrViewportState('idle');
        }
    }

    function pauseScanning(reason) {
        setScanPause(reason);
        setScannerPhase('paused_after_scan');
        ui.setLoading(false);
    }

    function isCurrentSession(sessionId) {
        return sessionId === state.scanSessionId;
    }

    function isCurrentDecodeRun(decodeRunId) {
        return decodeRunId === state.decodeRunId;
    }

    function ensureCodeReader() {
        if (!state.codeReader) {
            const ZXing = getZxingReader();
            state.codeReader = new ZXing.BrowserMultiFormatReader();
        }

        return state.codeReader;
    }

    function resetCodeReader({ discardInstance = false } = {}) {
        try {
            if (state.codeReader) {
                state.codeReader.reset();
            }
        } catch (error) {
            console.warn('Ошибка сброса QR-ридера:', error);
        } finally {
            if (discardInstance) {
                state.codeReader = null;
            }
        }
    }

    function startDecodeLoop(sessionId, cameraIdToUse) {
        if (!dom.videoElement) {
            return;
        }

        const ZXing = getZxingReader();
        const codeReader = ensureCodeReader();
        const decodeRunId = (state.decodeRunId || 0) + 1;
        state.decodeRunId = decodeRunId;

        codeReader.decodeFromVideoDevice(
            cameraIdToUse || undefined,
            dom.videoElement.id,
            (result, error) => {
                if (
                    !isCurrentSession(sessionId) ||
                    !isCurrentDecodeRun(decodeRunId)
                ) {
                    return;
                }

                if (result) {
                    if (state.scanPause?.active || state.isProcessing) {
                        return;
                    }

                    const decodedText = result.getText();
                    pauseScanning('scan_result');
                    resetCodeReader();
                    stopQrScanner({
                        preservePause: true,
                        reason: 'scan_result',
                    });

                    Promise.resolve(scanResultHandler?.(decodedText)).catch(
                        (scanError) => {
                            console.error('Ошибка обработки скана:', scanError);
                        },
                    );
                    return;
                }

                if (error && !(error instanceof ZXing.NotFoundException)) {
                    console.error('Ошибка сканирования:', error);
                }
            },
        );
    }

    async function updateCameraList() {
        if (!dom.cameraSelect || !navigator.mediaDevices?.enumerateDevices) {
            return [];
        }

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            state.availableCameras = devices.filter(
                (device) => device.kind === 'videoinput',
            );

            dom.cameraSelect.innerHTML = '';

            state.availableCameras.forEach((camera, index) => {
                const option = document.createElement('option');
                option.value = camera.deviceId;
                option.textContent = camera.label || `Камера ${index + 1}`;
                dom.cameraSelect.appendChild(option);
            });

            if (
                state.selectedCameraId &&
                state.availableCameras.some(
                    (camera) => camera.deviceId === state.selectedCameraId,
                )
            ) {
                dom.cameraSelect.value = state.selectedCameraId;
            }

            dom.cameraSelect.style.display =
                state.availableCameras.length > 0 ? 'inline-block' : 'none';

            return state.availableCameras;
        } catch (error) {
            console.error('Ошибка обновления списка камер:', error);
            dom.cameraSelect.style.display = 'none';
            return [];
        }
    }

    async function pickCameraId(preferredCameraId) {
        if (preferredCameraId) {
            return preferredCameraId;
        }

        const cameras =
            state.availableCameras.length > 0
                ? state.availableCameras
                : await updateCameraList();

        let camera = cameras.find(
            (item) => item.label && /camera2 2,? facing back/i.test(item.label),
        );

        if (!camera) {
            camera = cameras.find(
                (item) => item.label && /back/i.test(item.label),
            );
        }

        if (!camera) {
            camera = cameras.find(
                (item) => item.label && /wide/i.test(item.label),
            );
        }

        if (!camera) {
            camera = cameras[0] || null;
        }

        return camera ? camera.deviceId : null;
    }

    function showCameraInitNoticeOnce() {
        if (state.cameraMessages.requestShown) {
            return;
        }

        const message = isIOS()
            ? 'Запрос доступа к камере (iOS)'
            : 'Запрос доступа к камере';

        ui.showCameraNotice('info', message);
        state.cameraMessages.requestShown = true;
    }

    function showCameraGrantedNoticeOnce() {
        if (state.cameraMessages.grantedShown) {
            return;
        }

        const message = isIOS()
            ? 'Доступ к камере получен (iOS)'
            : 'Доступ к камере получен';

        ui.showCameraNotice('info', message);
        state.cameraMessages.grantedShown = true;
    }

    function clearVideoStream() {
        if (state.stream) {
            state.stream.getTracks().forEach((track) => track.stop());
            state.stream = null;
        }

        if (dom.videoElement) {
            const currentStream = dom.videoElement.srcObject;

            if (currentStream?.getTracks) {
                currentStream.getTracks().forEach((track) => track.stop());
            }

            try {
                dom.videoElement.pause();
            } catch (error) {
                console.warn('Ошибка паузы видеоэлемента:', error);
            }

            dom.videoElement.srcObject = null;
        }
    }

    function stopQrScanner(options = {}) {
        if (options.manual) {
            setAutoRestartAllowed(false);
        }

        state.stopReason = options.reason || (options.manual ? 'manual' : 'stop');
        state.scannerStarting = false;
        state.decodeRunId += 1;
        cancelPendingRestart();

        if (options.preservePause) {
            clearPauseTimer();
        } else {
            clearScanPause();
        }

        state.scanSessionId += 1;
        resetCodeReader({ discardInstance: true });
        clearVideoStream();

        state.scannerActive = false;
        setScannerPhase(
            options.manual
                ? 'stopped_manual'
                : options.preservePause
                  ? 'paused_after_scan'
                  : 'idle',
        );

        if (!options.preservePause) {
            ui.setQrViewportState('idle');
        }

        ui.setLoading(false);
    }

    async function restartQrScannerIfAllowed() {
        if (!state.autoRestartAllowed || state.scannerStarting || isScannerActive()) {
            return;
        }

        clearScanPause();
        await startQrScanner(state.selectedCameraId);
    }

    function scheduleRestartIfAllowed(delayMs) {
        cancelPendingRestart();

        if (!state.autoRestartAllowed) {
            return;
        }

        if (!state.scanPause?.active) {
            setScanPause('scan_result');
        }

        state.restartTimerId = window.setTimeout(async () => {
            state.restartTimerId = null;
            await restartQrScannerIfAllowed();
        }, delayMs);
    }

    async function startQrScanner(cameraIdOverride) {
        cancelPendingRestart();
        clearScanPause();
        setAutoRestartAllowed(true);
        state.stopReason = null;
        setScannerPhase('starting');

        if (!dom.videoElement) {
            setScannerPhase('idle');
            ui.showCameraNotice('error', 'Видеоэлемент камеры не найден', {
                duration: 4000,
            });
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setScannerPhase('idle');
            ui.showCameraNotice('error', 'Камера не поддерживается устройством', {
                duration: 4000,
            });
            return;
        }

        if (state.scannerStarting) {
            ui.setLoading(false);
            return;
        }

        if (isScannerActive()) {
            stopQrScanner({ reason: 'restart_before_start' });
        }

        state.scannerStarting = true;
        ui.setLoading(true);
        ui.setQrViewportState('loading');
        ui.setVideoVisible(true);

        const sessionId = state.scanSessionId + 1;
        state.scanSessionId = sessionId;
        let cameraIdToUse = cameraIdOverride || state.selectedCameraId || null;

        try {
            showCameraInitNoticeOnce();

            if (isIOS()) {
                state.stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: { ideal: 'environment' },
                        width: { ideal: 480, max: 480 },
                        height: { ideal: 480, max: 480 },
                        aspectRatio: 1,
                    },
                });
            } else {
                cameraIdToUse = await pickCameraId(cameraIdToUse);

                if (!cameraIdToUse) {
                    throw new Error('Камеры не найдены на устройстве');
                }

                state.selectedCameraId = cameraIdToUse;
                state.stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        deviceId: { exact: cameraIdToUse },
                        facingMode: { ideal: 'environment' },
                        width: { ideal: 480, max: 480 },
                        height: { ideal: 480, max: 480 },
                        aspectRatio: 1,
                    },
                });
            }

            if (!isCurrentSession(sessionId)) {
                state.scannerStarting = false;
                setScannerPhase('idle');
                clearVideoStream();
                return;
            }

            showCameraGrantedNoticeOnce();

            dom.videoElement.setAttribute('playsinline', 'true');
            dom.videoElement.setAttribute('autoplay', 'true');
            dom.videoElement.muted = true;
            dom.videoElement.srcObject = state.stream;
            dom.videoElement.style.objectFit = 'cover';
            dom.videoElement.style.width = '100%';
            dom.videoElement.style.height = '100%';
            dom.videoElement.style.aspectRatio = '1/1';
            await dom.videoElement.play();

            if (!isCurrentSession(sessionId)) {
                state.scannerStarting = false;
                setScannerPhase('idle');
                clearVideoStream();
                return;
            }

            resetCodeReader({ discardInstance: true });
            ensureCodeReader();

            state.scannerActive = true;
            state.scannerStarting = false;
            setScannerPhase('scanning');
            ui.setQrViewportState('scanning');
            ui.setLoading(false);
            startDecodeLoop(sessionId, cameraIdToUse);
        } catch (error) {
            state.scannerStarting = false;
            setScannerPhase('idle');
            console.error('Ошибка камеры:', error);
            stopQrScanner({ reason: 'camera_error' });
            ui.showCameraNotice(
                'error',
                error?.message || 'Ошибка запуска камеры',
                {
                    duration: 4200,
                },
            );
        }
    }

    async function handleCameraSelection(cameraId) {
        state.selectedCameraId = cameraId || null;

        if (state.selectedCameraId) {
            localStorage.setItem('selectedCameraId', state.selectedCameraId);
        } else {
            localStorage.removeItem('selectedCameraId');
        }

        stopQrScanner({ reason: 'camera_switch' });
        await startQrScanner(state.selectedCameraId);
    }

    return {
        cancelPendingRestart,
        handleCameraSelection,
        isScannerActive,
        restartQrScannerIfAllowed,
        scheduleRestartIfAllowed,
        setAutoRestartAllowed,
        setScanResultHandler,
        startQrScanner,
        stopQrScanner,
        updateCameraList,
    };
}
