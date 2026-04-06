import {
    captureException,
    captureMessage,
    setContext as setLoggerContext,
    trackEvent,
} from './logger.js';
import {
    safeRequestCamera,
    safeCloseStream,
    safeAsyncCall,
    categorizeError,
    ERROR_CATEGORY,
    createErrorObject,
    getUriUserFriendlyMessage,
} from './error-handler.js';

const ZXING_SCRIPT_URL = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
const CAMERA_DIAGNOSTIC_WINDOW_MS = 60_000;
const CAMERA_DIAGNOSTIC_MAX_EVENTS = 12;
const SCAN_GATE_MIN_LOCK_MS = 800;
const SCAN_GATE_FORCE_UNLOCK_MS = 2500;
const SCAN_GATE_ABSENT_POLLS_TO_CLEAR = 3;
const SCAN_GATE_ABSENT_MIN_MS = 900;
const SCAN_GATE_DIFFERENT_POLLS_TO_ACCEPT = 2;
const CAMERA_WATCHDOG_INTERVAL_MS = 1000;
const CAMERA_FREEZE_THRESHOLD_MS = 2500;
const CAMERA_SESSION_ANOMALY_FALLBACK_THRESHOLD = 3;
const MOBILE_BARCODE_DETECTOR_CADENCE_MS = 100;
const MOBILE_BARCODE_DETECTOR_COOLDOWN_CADENCE_MS = 250;
const CAMERA_STREAM_FRAME_RATE = {
    ideal: 24,
    max: 30,
};
let barcodeDetectorSupportPromise = null;
let zxingLoadPromise = null;

function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function getZxingReader() {
    if (!window.ZXing?.BrowserMultiFormatReader) {
        throw new Error('ZXing не загружен');
    }

    return window.ZXing;
}

async function getBarcodeDetectorSupport() {
    if (!barcodeDetectorSupportPromise) {
        barcodeDetectorSupportPromise = (async () => {
            if (!window.BarcodeDetector) {
                return {
                    reason: 'api_missing',
                    supported: false,
                };
            }

            if (typeof window.BarcodeDetector.getSupportedFormats !== 'function') {
                return {
                    reason: 'formats_api_missing',
                    supported: false,
                };
            }

            try {
                const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
                const supportsQr = Array.isArray(supportedFormats)
                    && supportedFormats.includes('qr_code');

                return {
                    reason: supportsQr ? 'qr_supported' : 'qr_unsupported',
                    supported: supportsQr,
                    supportedFormats,
                };
            } catch (error) {
                captureMessage(
                    'BarcodeDetector capability check failed',
                    {
                        errorName: error?.name || 'UnknownError',
                        operation: 'barcode_detector_capability_check',
                        tags: {
                            scope: 'camera',
                        },
                    },
                    'warning',
                );

                return {
                    errorName: error?.name || 'UnknownError',
                    reason: 'capability_check_failed',
                    supported: false,
                };
            }
        })();
    }

    return barcodeDetectorSupportPromise;
}

async function loadZxingLibrary(trigger = 'scan_start') {
    if (window.ZXing?.BrowserMultiFormatReader) {
        return window.ZXing;
    }

    if (!zxingLoadPromise) {
        const loadStartedAt = performance.now();

        zxingLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = ZXING_SCRIPT_URL;
            script.async = true;
            script.onload = () => {
                if (!window.ZXing?.BrowserMultiFormatReader) {
                    reject(new Error('ZXing loaded without BrowserMultiFormatReader'));
                    return;
                }

                trackEvent('lazy_load_duration', {
                    durationMs: Math.round(performance.now() - loadStartedAt),
                    trigger,
                });
                resolve(window.ZXing);
            };
            script.onerror = () => {
                reject(new Error(`Failed to load ZXing from ${ZXING_SCRIPT_URL}`));
            };
            document.head.appendChild(script);
        }).catch((error) => {
            zxingLoadPromise = null;
            throw error;
        });
    }

    return zxingLoadPromise;
}

function createBarcodeDetector() {
    return new window.BarcodeDetector({
        formats: ['qr_code'],
    });
}

export function createCameraController({ state, dom, ui }) {
    const DEBUG_CAMERA = new URLSearchParams(window.location.search).has('debugCamera');
    const CAMERA_ID_STORAGE_KEY = 'selectedCameraId';
    const CAMERA_SIGNATURE_STORAGE_KEY = 'selectedCameraSignature';
    const IOS_FRONT_CAMERA_ID = '__ios_front_camera__';
    const IOS_BACK_CAMERA_ID = '__ios_back_camera__';
    let scanResultHandler = null;
    const batteryProfileName = (() => {
        const userAgent = navigator.userAgent || '';
        const hasTouch =
            (navigator.maxTouchPoints || 0) > 0
            || 'ontouchstart' in window;
        const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
        return hasTouch && isMobileUa ? 'balanced_mobile' : 'default';
    })();

    function getBatteryProfileName() {
        return batteryProfileName;
    }

    function getBarcodeDetectorCadenceMs() {
        if (getBatteryProfileName() !== 'balanced_mobile') {
            return 0;
        }

        const gate = ensureScannerGateState();
        return gate.mode === 'cooldown'
            ? MOBILE_BARCODE_DETECTOR_COOLDOWN_CADENCE_MS
            : MOBILE_BARCODE_DETECTOR_CADENCE_MS;
    }

    function getDecodeCadenceMsForBackend(backend) {
        return backend === 'barcode_detector' ? getBarcodeDetectorCadenceMs() : 0;
    }

    function buildBatteryTelemetryMeta(backend) {
        return {
            batteryProfile: getBatteryProfileName(),
            decodeCadenceMs: getDecodeCadenceMsForBackend(backend),
        };
    }

    function updateCameraSessionRuntimeMeta(backend = null) {
        const session = ensureCameraSessionState();
        const resolvedBackend = backend || session.currentBackend || null;

        session.batteryProfile = getBatteryProfileName();
        session.decodeCadenceMs = getDecodeCadenceMsForBackend(resolvedBackend);
        return session;
    }

    function recordWarmupDecision({ skipped, reason = null }) {
        const session = updateCameraSessionRuntimeMeta();
        session.warmupSkipped = Boolean(skipped);
        session.warmupSkipReason = skipped ? (reason || 'unknown') : null;
    }

    function evaluateWarmupPolicy(support) {
        if (support?.supported) {
            return {
                reason: 'native_backend',
                shouldWarmup: false,
            };
        }

        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

        if (!connection) {
            return {
                reason: null,
                shouldWarmup: true,
            };
        }

        if (connection.saveData === true) {
            return {
                reason: 'save_data',
                shouldWarmup: false,
            };
        }

        if (['slow-2g', '2g'].includes(connection.effectiveType)) {
            return {
                reason: 'slow_network',
                shouldWarmup: false,
            };
        }

        return {
            reason: null,
            shouldWarmup: true,
        };
    }

    function registerBarcodeDetectCall() {
        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.barcodeDetectCalls += 1;
        }
    }

    function scheduleBarcodeDetectorTick(callback, delayMs = 0) {
        if (delayMs > 0) {
            window.setTimeout(() => {
                void callback();
            }, delayMs);
            return;
        }

        window.requestAnimationFrame(() => {
            void callback();
        });
    }

    function ensureScannerGateState() {
        if (!state.scannerGate) {
            state.scannerGate = {
                absentSince: 0,
                absentPolls: 0,
                cooldownMinUntil: 0,
                differentCandidatePolls: 0,
                differentCandidateText: '',
                forceUnlockAt: 0,
                lastAcceptedText: '',
                lastSeenText: '',
                mode: 'open',
                sameCodeVisible: false,
                stuckReported: false,
            };
        }

        return state.scannerGate;
    }

    function ensureCameraSessionState() {
        if (!state.cameraSession) {
            state.cameraSession = {
                anomalyCount: 0,
                batteryProfile: getBatteryProfileName(),
                currentBackend: null,
                decodeCadenceMs: 0,
                fallbackCount: 0,
                freezeDetections: 0,
                lastStartSource: 'unknown',
                muteEvents: 0,
                preferredBackend: 'auto',
                qrClearedCount: 0,
                sameCodeCollisions: 0,
                unmuteEvents: 0,
                watchdogRecoveries: 0,
                warmupSkipped: false,
                warmupSkipReason: null,
            };
        }

        return state.cameraSession;
    }

    function ensureWatchdogState() {
        if (!state.cameraWatchdog) {
            state.cameraWatchdog = {
                freezeRecoveryInProgress: false,
                intervalId: null,
                lastVideoTime: 0,
                stagnantSince: 0,
            };
        }

        return state.cameraWatchdog;
    }

    function debugCamera(event, payload = {}) {
        if (!DEBUG_CAMERA) {
            return;
        }

        console.log(`[camera-debug][camera] ${event}`, payload);
    }

    function createScanTelemetry(backend) {
        return {
            backend,
            failedFrames: 0,
            firstSuccessTracked: false,
            startedAt: performance.now(),
        };
    }

    function clearCameraDiagnosticTimer() {
        if (state.cameraDiagnostic?.timerId) {
            window.clearTimeout(state.cameraDiagnostic.timerId);
            state.cameraDiagnostic.timerId = null;
        }
    }

    function buildCameraDiagnosticEventLabel(eventType, meta = {}, elapsedMs = 0) {
        const suffix = Object.entries(meta)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .slice(0, 3)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ');

        return `${Math.max(0, Math.round(elapsedMs))}ms ${eventType}${suffix ? ` (${suffix})` : ''}`;
    }

    function getCurrentVideoTrackSnapshot() {
        const activeStream = state.stream || dom.videoElement?.srcObject || null;
        const [videoTrack] = activeStream?.getVideoTracks?.() || [];
        const settings = typeof videoTrack?.getSettings === 'function'
            ? videoTrack.getSettings()
            : null;

        return {
            hasStream: Boolean(activeStream),
            trackEnabled: videoTrack?.enabled ?? null,
            trackMuted: videoTrack?.muted ?? null,
            trackReadyState: videoTrack?.readyState || 'none',
            trackSettingsFrameRate: settings?.frameRate ?? null,
            trackSettingsHeight: settings?.height ?? null,
            trackSettingsWidth: settings?.width ?? null,
            videoReadyState: dom.videoElement?.readyState ?? null,
        };
    }

    function getCameraSessionSnapshot() {
        const session = updateCameraSessionRuntimeMeta(
            ensureCameraSessionState().currentBackend,
        );

        return {
            anomalyCount: session.anomalyCount,
            batteryProfile: session.batteryProfile,
            currentBackend: session.currentBackend,
            decodeCadenceMs: session.decodeCadenceMs,
            fallbackCount: session.fallbackCount,
            freezeDetections: session.freezeDetections,
            lastStartSource: session.lastStartSource,
            muteEvents: session.muteEvents,
            preferredBackend: session.preferredBackend,
            qrClearedCount: session.qrClearedCount,
            sameCodeCollisions: session.sameCodeCollisions,
            unmuteEvents: session.unmuteEvents,
            watchdogRecoveries: session.watchdogRecoveries,
            warmupSkipped: session.warmupSkipped,
            warmupSkipReason: session.warmupSkipReason,
        };
    }

    function scheduleCameraDiagnosticFlush() {
        clearCameraDiagnosticTimer();

        if (!state.cameraDiagnostic?.active) {
            return;
        }

        state.cameraDiagnostic.timerId = window.setTimeout(() => {
            flushCameraDiagnostic('minute_elapsed', {
                continueWindow: true,
            });
        }, CAMERA_DIAGNOSTIC_WINDOW_MS);
    }

    function ensureCameraDiagnosticSession(trigger = 'scanner_start') {
        if (state.cameraDiagnostic?.active) {
            return state.cameraDiagnostic;
        }

        state.cameraDiagnosticSequence = (state.cameraDiagnosticSequence || 0) + 1;

        state.cameraDiagnostic = {
            active: true,
            backendsSeen: {},
            counts: {
                barcodeDetectCalls: 0,
                failedFramesTotal: 0,
                fallbackCount: 0,
                freezeDetections: 0,
                hardStops: 0,
                muteEvents: 0,
                pauseCount: 0,
                qrClearedCount: 0,
                restartAttempts: 0,
                restartRecovered: 0,
                restartScheduled: 0,
                resumeSuccess: 0,
                scanSuccesses: 0,
                sameCodeCollisions: 0,
                startFailures: 0,
                startRequests: 0,
                startSuccesses: 0,
                trackEnded: 0,
                unmuteEvents: 0,
                watchdogRecoveries: 0,
            },
            events: [],
            id: `camdiag-${Date.now().toString(36)}-${state.cameraDiagnosticSequence}`,
            lastBackend: null,
            startedAtPerf: performance.now(),
            startedAtTimestamp: Date.now(),
            timerId: null,
            trigger,
        };

        recordCameraDiagnosticEvent('window_started', {
            trigger,
        });
        scheduleCameraDiagnosticFlush();

        return state.cameraDiagnostic;
    }

    function recordCameraDiagnosticEvent(eventType, meta = {}) {
        const diagnostic = state.cameraDiagnostic?.active
            ? state.cameraDiagnostic
            : null;

        if (!diagnostic) {
            return;
        }

        const elapsedMs = performance.now() - diagnostic.startedAtPerf;

        diagnostic.events.push(
            buildCameraDiagnosticEventLabel(eventType, meta, elapsedMs),
        );

        if (diagnostic.events.length > CAMERA_DIAGNOSTIC_MAX_EVENTS) {
            diagnostic.events.shift();
        }
    }

    function flushCameraDiagnostic(reason, options = {}) {
        const diagnostic = state.cameraDiagnostic?.active
            ? state.cameraDiagnostic
            : null;

        if (!diagnostic) {
            return;
        }

        clearCameraDiagnosticTimer();

        const durationMs = Math.round(performance.now() - diagnostic.startedAtPerf);
        const currentTrack = options.trackSnapshot || getCurrentVideoTrackSnapshot();
        const cameraSession = options.sessionSnapshot || getCameraSessionSnapshot();
        const scannerGate = ensureScannerGateState();
        const eventMeta = {
            barcodeDetectCalls: diagnostic.counts.barcodeDetectCalls,
            batteryProfile: cameraSession.batteryProfile || getBatteryProfileName(),
            currentGateMode: scannerGate.mode,
            decodeCadenceMs: cameraSession.decodeCadenceMs ?? 0,
            diagnosticId: diagnostic.id,
            durationMs,
            failedFramesTotal: diagnostic.counts.failedFramesTotal,
            fallbackCount: diagnostic.counts.fallbackCount,
            freezeDetections: diagnostic.counts.freezeDetections,
            hardStops: diagnostic.counts.hardStops,
            lastBackend: diagnostic.lastBackend || 'unknown',
            pauseCount: diagnostic.counts.pauseCount,
            qrClearedCount: diagnostic.counts.qrClearedCount,
            reason,
            restartAttempts: diagnostic.counts.restartAttempts,
            restartRecovered: diagnostic.counts.restartRecovered,
            restartScheduled: diagnostic.counts.restartScheduled,
            resumeSuccess: diagnostic.counts.resumeSuccess,
            scanSuccesses: diagnostic.counts.scanSuccesses,
            sameCodeCollisions: diagnostic.counts.sameCodeCollisions,
            startSource: cameraSession.lastStartSource,
            startFailures: diagnostic.counts.startFailures,
            startRequests: diagnostic.counts.startRequests,
            startSuccesses: diagnostic.counts.startSuccesses,
            startedAtTimestamp: diagnostic.startedAtTimestamp,
            trackEnded: diagnostic.counts.trackEnded,
            trigger: diagnostic.trigger,
            muteEvents: diagnostic.counts.muteEvents,
            unmuteEvents: diagnostic.counts.unmuteEvents,
            visibilityState: document.visibilityState || 'unknown',
            watchdogRecoveries: diagnostic.counts.watchdogRecoveries,
            warmupSkipped: cameraSession.warmupSkipped,
            warmupSkipReason: cameraSession.warmupSkipReason,
            ...currentTrack,
            timeline: diagnostic.events.reduce((accumulator, entry, index) => {
                accumulator[`e${String(index + 1).padStart(2, '0')}`] = entry;
                return accumulator;
            }, {}),
        };

        diagnostic.active = false;
        state.cameraDiagnostic = null;
        trackEvent('camera_diagnostic_window', eventMeta, 'info');

        if (
            options.continueWindow
            && (state.scannerActive || state.scannerStarting || state.scanPause?.active || scannerGate.mode === 'cooldown')
        ) {
            ensureCameraDiagnosticSession('rolling_window');
        }
    }

    function registerFailedFrame(telemetry) {
        if (!telemetry || telemetry.firstSuccessTracked) {
            return;
        }

        telemetry.failedFrames += 1;

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.failedFramesTotal += 1;
        }
    }

    function trackFirstScanMetrics(telemetry) {
        if (!telemetry || telemetry.firstSuccessTracked) {
            return;
        }

        telemetry.firstSuccessTracked = true;

        trackEvent('time_to_first_scan', {
            backend: telemetry.backend,
            ...buildBatteryTelemetryMeta(telemetry.backend),
            durationMs: Math.round(performance.now() - telemetry.startedAt),
        });
        trackEvent('failed_frames', {
            backend: telemetry.backend,
            ...buildBatteryTelemetryMeta(telemetry.backend),
            count: telemetry.failedFrames,
        });
        recordCameraDiagnosticEvent('first_scan_metrics', {
            backend: telemetry.backend,
            failedFrames: telemetry.failedFrames,
        });
    }

    function trackScannerBackend(backend, meta = {}) {
        const session = updateCameraSessionRuntimeMeta(backend);

        session.currentBackend = backend;

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.backendsSeen[backend] = true;
            state.cameraDiagnostic.lastBackend = backend;
        }

        recordCameraDiagnosticEvent('backend_selected', {
            backend,
            reason: meta.reason || null,
        });
        trackEvent('scanner_backend', {
            backend,
            ...buildBatteryTelemetryMeta(backend),
            ...meta,
        });
    }

    function setQrViewportForScannerState() {
        const gate = ensureScannerGateState();

        if (state.scanPause?.active) {
            ui.setQrViewportState('paused');
            return;
        }

        if (state.scannerStarting) {
            ui.setQrViewportState('loading');
            return;
        }

        if (!isScannerActive()) {
            ui.setQrViewportState('idle');
            return;
        }

        ui.setQrViewportState(gate.mode === 'cooldown' ? 'cooldown' : 'scanning');
    }

    function resetScannerGate(reason = 'manual_reset') {
        const gate = ensureScannerGateState();

        gate.absentPolls = 0;
        gate.absentSince = 0;
        gate.cooldownMinUntil = 0;
        gate.differentCandidatePolls = 0;
        gate.differentCandidateText = '';
        gate.forceUnlockAt = 0;
        gate.lastAcceptedText = '';
        gate.lastSeenText = '';
        gate.mode = 'open';
        gate.sameCodeVisible = false;
        gate.stuckReported = false;

        recordCameraDiagnosticEvent('gate_reset', {
            reason,
        });
        setQrViewportForScannerState();
    }

    function enterScannerCooldown(acceptedText, reason = 'accepted_scan') {
        const gate = ensureScannerGateState();
        const now = Date.now();

        gate.absentPolls = 0;
        gate.absentSince = 0;
        gate.cooldownMinUntil = now + SCAN_GATE_MIN_LOCK_MS;
        gate.differentCandidatePolls = 0;
        gate.differentCandidateText = '';
        gate.forceUnlockAt = now + SCAN_GATE_FORCE_UNLOCK_MS;
        gate.lastAcceptedText = String(acceptedText || '').trim();
        gate.lastSeenText = gate.lastAcceptedText;
        gate.mode = 'cooldown';
        gate.sameCodeVisible = true;
        gate.stuckReported = false;

        recordCameraDiagnosticEvent('cooldown_entered', {
            reason,
        });
        setQrViewportForScannerState();
    }

    function markQrCleared(reason = 'qr_cleared') {
        const gate = ensureScannerGateState();
        const session = ensureCameraSessionState();

        session.qrClearedCount += 1;

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.qrClearedCount += 1;
        }

        trackEvent('camera_qr_cleared', {
            reason,
            screen: state.activeRootScreen,
            selectedCameraId: state.selectedCameraId || 'none',
        });
        recordCameraDiagnosticEvent('qr_cleared', {
            reason,
        });

        gate.absentPolls = 0;
        gate.absentSince = 0;
        gate.differentCandidatePolls = 0;
        gate.differentCandidateText = '';
        gate.lastSeenText = '';
        gate.mode = 'open';
        gate.sameCodeVisible = false;
        gate.stuckReported = false;
        setQrViewportForScannerState();
    }

    function noteCameraSessionAnomaly(reason, meta = {}) {
        const session = ensureCameraSessionState();

        session.anomalyCount += 1;
        recordCameraDiagnosticEvent('session_anomaly', {
            reason,
            count: session.anomalyCount,
        });

        if (
            session.preferredBackend !== 'zxing'
            && session.anomalyCount >= CAMERA_SESSION_ANOMALY_FALLBACK_THRESHOLD
        ) {
            session.preferredBackend = 'zxing';
            session.fallbackCount += 1;

            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.fallbackCount += 1;
            }

            trackEvent('camera_backend_fallback_triggered', {
                anomalyCount: session.anomalyCount,
                ...buildBatteryTelemetryMeta(session.currentBackend || 'unknown'),
                currentBackend: session.currentBackend || 'unknown',
                preferredBackend: session.preferredBackend,
                reason,
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
            }, 'warning');
            recordCameraDiagnosticEvent('backend_fallback', {
                reason,
            });

            if (
                state.scannerActive
                && !state.scannerStarting
                && !state.scanPause?.active
                && session.currentBackend === 'barcode_detector'
            ) {
                state.decodeRunId += 1;
                resetCodeReader({ discardInstance: true });
                void startZxingDecodeLoop(
                    state.scanSessionId,
                    state.selectedCameraId,
                    createScanTelemetry('zxing'),
                );
            }
        }
    }

    function resetCameraSession(reason = 'manual_reset') {
        state.cameraSession = {
            anomalyCount: 0,
            batteryProfile: getBatteryProfileName(),
            currentBackend: null,
            decodeCadenceMs: 0,
            fallbackCount: 0,
            freezeDetections: 0,
            lastStartSource: 'unknown',
            muteEvents: 0,
            preferredBackend: 'auto',
            qrClearedCount: 0,
            sameCodeCollisions: 0,
            unmuteEvents: 0,
            watchdogRecoveries: 0,
            warmupSkipped: false,
            warmupSkipReason: null,
        };
        recordCameraDiagnosticEvent('camera_session_reset', {
            reason,
        });
    }

    function isRecoverableCameraStartError(error) {
        return [
            'AbortError',
            'NotReadableError',
            'TrackStartError',
        ].includes(error?.name);
    }

    function switchTelemetryBackend(telemetry, backend) {
        if (!telemetry) {
            return createScanTelemetry(backend);
        }

        telemetry.backend = backend;
        return telemetry;
    }

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

    function isHomeScreenActive() {
        return state.activeRootScreen === 'home';
    }

    function syncCameraSelectValue(cameraId) {
        if (!dom.cameraSelect) {
            return;
        }

        const hasOption = Array.from(dom.cameraSelect.options).some(
            (option) => option.value === cameraId,
        );

        dom.cameraSelect.value = hasOption ? cameraId : '';
    }

    function normalizeCameraLabel(label = '') {
        return String(label)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
    }

    function getCameraFacingKey(label = '') {
        const normalizedLabel = normalizeCameraLabel(label);

        if (/front|user/.test(normalizedLabel)) {
            return 'front';
        }

        if (/ultra/.test(normalizedLabel)) {
            return 'ultra';
        }

        if (/wide/.test(normalizedLabel)) {
            return 'wide';
        }

        if (/macro/.test(normalizedLabel)) {
            return 'macro';
        }

        if (/tele/.test(normalizedLabel)) {
            return 'tele';
        }

        if (/back|rear|environment/.test(normalizedLabel)) {
            return 'back';
        }

        return 'unknown';
    }

    function getCameraSignature(camera) {
        if (!camera) {
            return '';
        }

        if (isIosVirtualCameraId(camera.deviceId)) {
            return camera.deviceId;
        }

        const normalizedLabel = normalizeCameraLabel(camera.label);

        if (!normalizedLabel) {
            return '';
        }

        return `${getCameraFacingKey(normalizedLabel)}|${normalizedLabel}`;
    }

    function getStoredCameraSignature() {
        if (isIOS()) {
            return null;
        }

        return state.selectedCameraSignature
            || localStorage.getItem(CAMERA_SIGNATURE_STORAGE_KEY)
            || null;
    }

    function resolveStoredCameraId(cameras, preferredCameraId = null) {
        if (!Array.isArray(cameras) || cameras.length === 0) {
            return null;
        }

        if (
            preferredCameraId &&
            cameras.some((camera) => camera.deviceId === preferredCameraId)
        ) {
            return preferredCameraId;
        }

        const storedSignature = getStoredCameraSignature();

        if (!storedSignature) {
            return null;
        }

        const exactSignatureMatch = cameras.find(
            (camera) => getCameraSignature(camera) === storedSignature,
        );

        if (exactSignatureMatch) {
            return exactSignatureMatch.deviceId;
        }

        const [storedFacingKey] = storedSignature.split('|');

        if (!storedFacingKey || storedFacingKey === 'unknown') {
            return null;
        }

        return cameras.find(
            (camera) => getCameraFacingKey(camera.label) === storedFacingKey,
        )?.deviceId || null;
    }

    function syncSelectedCamera(cameraId, options = {}) {
        state.selectedCameraId = cameraId || null;
        const matchedCamera =
            options.camera
            || state.availableCameras.find(
                (camera) => camera.deviceId === state.selectedCameraId,
            )
            || null;
        const nextSignature = options.signature !== undefined
            ? options.signature
            : matchedCamera
              ? getCameraSignature(matchedCamera)
              : isIosVirtualCameraId(state.selectedCameraId)
                ? state.selectedCameraId
                : state.selectedCameraSignature;
        state.selectedCameraSignature = nextSignature || null;

        if (state.selectedCameraId) {
            localStorage.setItem(CAMERA_ID_STORAGE_KEY, state.selectedCameraId);
        } else {
            localStorage.removeItem(CAMERA_ID_STORAGE_KEY);
        }

        if (state.selectedCameraSignature) {
            localStorage.setItem(
                CAMERA_SIGNATURE_STORAGE_KEY,
                state.selectedCameraSignature,
            );
        } else {
            localStorage.removeItem(CAMERA_SIGNATURE_STORAGE_KEY);
        }

        syncCameraSelectValue(state.selectedCameraId);
        setLoggerContext({
            selectedCameraId: state.selectedCameraId || 'none',
        });
    }

    function resetSelectedCamera(reason) {
        debugCamera('reset_selected_camera', {
            reason,
            previousSelectedCameraId: state.selectedCameraId,
        });
        syncSelectedCamera(null, { signature: null });
    }

    function isIosVirtualCameraId(cameraId) {
        return cameraId === IOS_FRONT_CAMERA_ID || cameraId === IOS_BACK_CAMERA_ID;
    }

    function buildIosVirtualCameras(existingCameras = []) {
        const frontCamera = existingCameras.find((camera) =>
            /front|user/i.test(camera.label || ''),
        );
        const backCamera = existingCameras.find((camera) =>
            /back|rear|environment/i.test(camera.label || ''),
        );

        return [
            {
                deviceId: IOS_BACK_CAMERA_ID,
                label: backCamera?.label || 'camera facing back',
            },
            {
                deviceId: IOS_FRONT_CAMERA_ID,
                label: frontCamera?.label || 'camera facing front',
            },
        ];
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
        setQrViewportForScannerState();
    }

    function clearScanPause() {
        const pauseState = ensurePauseState();
        clearPauseTimer();
        pauseState.active = false;
        pauseState.reason = null;
        ui.hideScanPauseOverlay();
        setQrViewportForScannerState();
    }

    function pauseScanning(reason) {
        setScanPause(reason);
        setScannerPhase('paused_after_scan');
        ui.setLoading(false);

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.pauseCount += 1;
        }

        recordCameraDiagnosticEvent('pause', {
            reason,
        });
    }

    function hasLiveVideoTrack(stream) {
        return Boolean(
            stream?.getVideoTracks?.().some(
                (track) => track.readyState === 'live' && track.enabled !== false,
            ),
        );
    }

    async function resumePausedScannerIfPossible() {
        if (!state.scanPause?.active || !isScannerActive() || !dom.videoElement) {
            return false;
        }

        const activeStream = state.stream || dom.videoElement.srcObject;

        if (!hasLiveVideoTrack(activeStream)) {
            return false;
        }

        if (!dom.videoElement.srcObject && activeStream) {
            dom.videoElement.srcObject = activeStream;
        }

        try {
            await dom.videoElement.play();
        } catch (error) {
            debugCamera('resume_paused_scanner_play_failed', {
                message: error?.message,
                name: error?.name,
            });
            return false;
        }

        clearScanPause();
        state.pendingCameraRecovery = null;
        setScannerPhase('scanning');
        setQrViewportForScannerState();
        ui.setLoading(false);

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.resumeSuccess += 1;
        }

        recordCameraDiagnosticEvent('resume_success', {
            scannerPhase: state.scannerPhase,
        });

        return true;
    }

    function detachVideoTrackObservers() {
        if (typeof state.videoTrackCleanup === 'function') {
            state.videoTrackCleanup();
        }

        state.videoTrackCleanup = null;
        state.observedVideoTrackId = null;
    }

    function handleVideoTrackEnded(sessionId, track) {
        if (!isCurrentSession(sessionId)) {
            return;
        }

        debugCamera('video_track_ended', {
            readyState: track?.readyState,
            selectedCameraId: state.selectedCameraId,
            sessionId,
        });

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.trackEnded += 1;
        }

        recordCameraDiagnosticEvent('track_ended', {
            readyState: track?.readyState || 'unknown',
        });

        trackEvent(
            'camera_video_track_ended',
            {
                readyState: track?.readyState || 'unknown',
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
            },
            'warning',
        );

        if (!state.autoRestartAllowed) {
            return;
        }

        noteCameraSessionAnomaly('video_track_ended');
        state.pendingCameraRecovery = {
            errorName: 'TrackEndedError',
            retryDelayMs: 900,
        };

        stopQrScanner({ reason: 'video_track_ended' });
        trackEvent(
            'camera_restart_scheduled_after_error',
            {
                errorName: 'TrackEndedError',
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
            },
            'warning',
        );
        ui.showCameraNotice(
            'warning',
            'Камера прервалась, повторный запуск...',
            {
                duration: 1800,
            },
        );
        scheduleRestartIfAllowed(state.pendingCameraRecovery.retryDelayMs);
    }

    function stopCameraWatchdog() {
        const watchdog = ensureWatchdogState();

        if (watchdog.intervalId) {
            window.clearInterval(watchdog.intervalId);
            watchdog.intervalId = null;
        }

        watchdog.lastVideoTime = 0;
        watchdog.stagnantSince = 0;
        watchdog.freezeRecoveryInProgress = false;
    }

    async function tryRecoverFrozenVideo(sessionId) {
        const watchdog = ensureWatchdogState();

        if (watchdog.freezeRecoveryInProgress || !isCurrentSession(sessionId)) {
            return;
        }

        watchdog.freezeRecoveryInProgress = true;
        const activeStream = state.stream || dom.videoElement?.srcObject || null;

        try {
            if (!dom.videoElement || !activeStream) {
                noteCameraSessionAnomaly('freeze_without_stream');
                return;
            }

            if (dom.videoElement.srcObject !== activeStream) {
                dom.videoElement.srcObject = activeStream;
            }

            try {
                await dom.videoElement.play();
                const session = ensureCameraSessionState();
                session.watchdogRecoveries += 1;

                if (state.cameraDiagnostic?.active) {
                    state.cameraDiagnostic.counts.watchdogRecoveries += 1;
                }

                recordCameraDiagnosticEvent('freeze_recovered_play', {
                    sessionId,
                });
                return;
            } catch (error) {
                noteCameraSessionAnomaly('freeze_play_failed', {
                    errorName: error?.name || 'UnknownError',
                });
                recordCameraDiagnosticEvent('freeze_play_failed', {
                    errorName: error?.name || 'UnknownError',
                });
            }

            resetCodeReader({ discardInstance: true });
            state.decodeRunId += 1;
            await startDecodeLoop(sessionId, state.selectedCameraId);
            recordCameraDiagnosticEvent('freeze_soft_decode_restart', {
                sessionId,
            });
            return;
        } catch (error) {
            noteCameraSessionAnomaly('freeze_soft_restart_failed', {
                errorName: error?.name || 'UnknownError',
            });
            captureMessage(
                'Frozen video recovery failed',
                {
                    errorName: error?.name || 'UnknownError',
                    operation: 'recover_frozen_video',
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
        } finally {
            watchdog.freezeRecoveryInProgress = false;
        }

        state.pendingCameraRecovery = {
            errorName: 'VideoFreezeError',
            retryDelayMs: 900,
        };
        stopQrScanner({ reason: 'video_freeze_recovery' });
        scheduleRestartIfAllowed(state.pendingCameraRecovery.retryDelayMs);
    }

    function handleFrozenVideo(sessionId) {
        if (!isCurrentSession(sessionId)) {
            return;
        }

        const session = ensureCameraSessionState();
        session.freezeDetections += 1;

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.freezeDetections += 1;
        }

        trackEvent('camera_freeze_detected', {
            screen: state.activeRootScreen,
            selectedCameraId: state.selectedCameraId || 'none',
            sessionId,
        }, 'warning');
        recordCameraDiagnosticEvent('freeze_detected', {
            sessionId,
        });
        noteCameraSessionAnomaly('video_freeze');
        void tryRecoverFrozenVideo(sessionId);
    }

    function startCameraWatchdog(sessionId) {
        stopCameraWatchdog();
        const watchdog = ensureWatchdogState();

        watchdog.lastVideoTime = dom.videoElement?.currentTime || 0;
        watchdog.intervalId = window.setInterval(() => {
            if (!isCurrentSession(sessionId) || !dom.videoElement) {
                stopCameraWatchdog();
                return;
            }

            if (
                document.visibilityState !== 'visible'
                || !isHomeScreenActive()
                || state.scannerStarting
                || state.scanPause?.active
            ) {
                watchdog.lastVideoTime = dom.videoElement.currentTime || 0;
                watchdog.stagnantSince = 0;
                return;
            }

            const activeStream = state.stream || dom.videoElement.srcObject || null;

            if (!hasLiveVideoTrack(activeStream) || dom.videoElement.style.display === 'none') {
                watchdog.lastVideoTime = dom.videoElement.currentTime || 0;
                watchdog.stagnantSince = 0;
                return;
            }

            const currentTime = dom.videoElement.currentTime || 0;

            if (currentTime > watchdog.lastVideoTime + 0.01) {
                watchdog.lastVideoTime = currentTime;
                watchdog.stagnantSince = 0;
                return;
            }

            if (!watchdog.stagnantSince) {
                watchdog.stagnantSince = Date.now();
                return;
            }

            if (Date.now() - watchdog.stagnantSince >= CAMERA_FREEZE_THRESHOLD_MS) {
                watchdog.stagnantSince = 0;
                handleFrozenVideo(sessionId);
            }
        }, CAMERA_WATCHDOG_INTERVAL_MS);
    }

    function attachVideoTrackObservers(stream, sessionId) {
        detachVideoTrackObservers();

        const [videoTrack] = stream?.getVideoTracks?.() || [];

        if (!videoTrack) {
            return;
        }

        const handleEnded = () => {
            handleVideoTrackEnded(sessionId, videoTrack);
        };
        const handleMute = () => {
            const session = ensureCameraSessionState();
            session.muteEvents += 1;

            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.muteEvents += 1;
            }

            trackEvent('camera_track_muted', {
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
                sessionId,
            }, 'warning');
            recordCameraDiagnosticEvent('track_muted', {
                sessionId,
            });
        };
        const handleUnmute = () => {
            const session = ensureCameraSessionState();
            session.unmuteEvents += 1;

            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.unmuteEvents += 1;
            }

            trackEvent('camera_track_unmuted', {
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
                sessionId,
            });
            recordCameraDiagnosticEvent('track_unmuted', {
                sessionId,
            });
        };

        videoTrack.addEventListener('ended', handleEnded);
        videoTrack.addEventListener('mute', handleMute);
        videoTrack.addEventListener('unmute', handleUnmute);
        state.observedVideoTrackId = videoTrack.id || null;
        state.videoTrackCleanup = () => {
            videoTrack.removeEventListener('ended', handleEnded);
            videoTrack.removeEventListener('mute', handleMute);
            videoTrack.removeEventListener('unmute', handleUnmute);
        };
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
            captureMessage(
                'QR reader reset failed',
                {
                    operation: 'reset_code_reader',
                    screen: state.activeRootScreen,
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
        } finally {
            if (discardInstance) {
                state.codeReader = null;
            }
        }
    }

    async function getVideoInputsWithWarmup() {
        const readVideoInputs = async () => {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter((device) => device.kind === 'videoinput');
        };

        let cameras = await readVideoInputs();

        if (isIOS()) {
            return buildIosVirtualCameras(cameras);
        }

        if (cameras.length > 0) {
            return cameras;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            return cameras;
        }

        let tempStream = null;

        try {
            tempStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                },
            });
        } catch (error) {
            console.warn('Не удалось прогреть список камер:', error);
            captureMessage(
                'Camera warmup failed',
                {
                    operation: 'warmup_camera_list',
                    screen: state.activeRootScreen,
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
            return cameras;
        } finally {
            tempStream?.getTracks?.().forEach((track) => track.stop());
        }

        try {
            cameras = await readVideoInputs();
        } catch (error) {
            console.warn('Не удалось обновить список камер после прогрева:', error);
            captureMessage(
                'Camera list refresh after warmup failed',
                {
                    operation: 'refresh_camera_list_after_warmup',
                    screen: state.activeRootScreen,
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
        }

        return cameras;
    }

    async function requestCameraStream(cameraIdToUse) {
        // КРИТИЧНО: Безопасный запрос камеры с обработкой всех типов ошибок
        // - Разрешения: PermissionDeniedError, NotAllowedError
        // - Устройство: NotFoundError, NotReadableError, OverconstrainedError
        // - Таймаут: автоматический retry с exponential backoff
        // - Cleanup: гарантированное закрытие потока при ошибке

        const fallbackConstraints = {
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 480, max: 480 },
                height: { ideal: 480, max: 480 },
                aspectRatio: 1,
                frameRate: CAMERA_STREAM_FRAME_RATE,
            },
        };

        const exactCameraConstraints = (deviceId) => ({
            video: {
                deviceId: { exact: deviceId },
                facingMode: { ideal: 'environment' },
                width: { ideal: 480, max: 480 },
                height: { ideal: 480, max: 480 },
                aspectRatio: 1,
                frameRate: CAMERA_STREAM_FRAME_RATE,
            },
        });

        // На iOS используем facingMode вместо deviceId
        if (isIOS()) {
            const facingMode =
                cameraIdToUse === IOS_FRONT_CAMERA_ID ? 'user' : 'environment';

            try {
                const stream = await safeRequestCamera(
                    {
                        video: {
                            facingMode: { ideal: facingMode },
                            width: { ideal: 480, max: 480 },
                            height: { ideal: 480, max: 480 },
                            aspectRatio: 1,
                            frameRate: CAMERA_STREAM_FRAME_RATE,
                        },
                    },
                    {
                        timeout: 5000,
                        retries: 2,
                        platform: 'ios',
                        facingMode,
                    }
                );

                trackEvent('camera_stream_acquired', {
                    platform: 'ios',
                    facingMode,
                    screen: state.activeRootScreen,
                });

                return stream;
            } catch (error) {
                const category = categorizeError(error);
                debugCamera('ios_camera_request_failed', {
                    facingMode,
                    errorName: error?.name,
                    category,
                });

                throw createErrorObject(category, error, {
                    operation: 'request_camera_stream',
                    platform: 'ios',
                    facingMode,
                });
            }
        }

        // Пытаемся с конкретной камерой если указана
        if (cameraIdToUse) {
            try {
                const stream = await safeRequestCamera(
                    exactCameraConstraints(cameraIdToUse),
                    {
                        timeout: 5000,
                        retries: 1,
                        deviceId: cameraIdToUse,
                        fallback: true,
                    }
                );

                trackEvent('camera_stream_acquired_exact', {
                    deviceId: cameraIdToUse,
                    screen: state.activeRootScreen,
                });

                return stream;
            } catch (error) {
                const category = categorizeError(error);

                debugCamera('exact_camera_request_failed', {
                    cameraIdToUse,
                    errorName: error?.name,
                    category,
                });

                // Ошибки разрешений пробрасываем сразу
                if (category === ERROR_CATEGORY.PERMISSION) {
                    throw error;
                }

                // Для других ошибок пытаемся fallback и сбрасываем выбранную камеру
                resetSelectedCamera('exact_camera_request_failed');
                captureMessage(
                    'Exact camera request failed, switching to fallback',
                    {
                        deviceId: cameraIdToUse,
                        category,
                        errorName: error?.name,
                        operation: 'request_camera_stream',
                        tags: { scope: 'camera' },
                    },
                    'warning'
                );
            }
        }

        // Fallback: запрашиваем любую камеру
        debugCamera('request_camera_stream_fallback', {
            selectedCameraId: state.selectedCameraId,
        });

        try {
            const stream = await safeRequestCamera(
                fallbackConstraints,
                {
                    timeout: 5000,
                    retries: 2,
                    fallback: true,
                }
            );

            trackEvent('camera_stream_acquired_fallback', {
                screen: state.activeRootScreen,
            });

            return stream;
        } catch (error) {
            const category = categorizeError(error);

            captureException(error, {
                operation: 'request_camera_stream_fallback',
                category,
                screen: state.activeRootScreen,
                tags: { scope: 'camera' },
            });

            throw createErrorObject(category, error, {
                operation: 'request_camera_stream_final',
                isLastAttempt: true,
            });
        }
    }

    function observeNoDetectionFrame() {
        const gate = ensureScannerGateState();

        if (gate.mode !== 'cooldown' || state.scanPause?.active) {
            return;
        }

        const now = Date.now();
        gate.absentPolls += 1;
        gate.differentCandidatePolls = 0;
        gate.differentCandidateText = '';
        gate.lastSeenText = '';
        gate.absentSince = gate.absentSince || now;

        if (
            gate.absentPolls >= SCAN_GATE_ABSENT_POLLS_TO_CLEAR
            && (now - gate.absentSince) >= SCAN_GATE_ABSENT_MIN_MS
        ) {
            markQrCleared('qr_absent');
        }
    }

    async function acceptDetectionCandidate(decodedText, telemetry) {
        const gate = ensureScannerGateState();
        const normalizedText = String(decodedText || '').trim();

        if (!normalizedText || state.isHandlingDetection) {
            return;
        }

        state.isHandlingDetection = true;
        trackFirstScanMetrics(telemetry);
        enterScannerCooldown(normalizedText, 'accepted_scan');

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.scanSuccesses += 1;
        }

        recordCameraDiagnosticEvent('scan_success', {
            backend: telemetry?.backend || 'unknown',
        });

        try {
            const result = await Promise.resolve(scanResultHandler?.(normalizedText));

            if (result?.status === 'selection_required') {
                pauseScanning('selection_modal');
                gate.mode = 'blocked_modal';
                recordCameraDiagnosticEvent('selection_required', {
                    backend: telemetry?.backend || 'unknown',
                });
                return;
            }

            setQrViewportForScannerState();
        } catch (scanError) {
            console.error('Scan result handler failed:', scanError);
            captureException(scanError, {
                operation: 'scan_result_handler',
                screen: state.activeRootScreen,
                tags: {
                    scope: 'scanner',
                },
            });
        } finally {
            state.isHandlingDetection = false;
        }
    }

    async function handleDetectionCandidate(decodedText, telemetry) {
        const gate = ensureScannerGateState();
        const normalizedText = String(decodedText || '').trim();

        if (!normalizedText || state.scanPause?.active || state.isProcessing) {
            return;
        }

        gate.lastSeenText = normalizedText;

        if (gate.mode !== 'cooldown') {
            await acceptDetectionCandidate(normalizedText, telemetry);
            return;
        }

        if (normalizedText === gate.lastAcceptedText) {
            gate.sameCodeVisible = true;
            gate.absentPolls = 0;
            gate.absentSince = 0;
            gate.differentCandidatePolls = 0;
            gate.differentCandidateText = '';

            const session = ensureCameraSessionState();
            session.sameCodeCollisions += 1;

            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.sameCodeCollisions += 1;
            }

            if (!gate.stuckReported && Date.now() >= gate.forceUnlockAt) {
                gate.stuckReported = true;
                trackEvent('camera_qr_still_visible', {
                    screen: state.activeRootScreen,
                    selectedCameraId: state.selectedCameraId || 'none',
                }, 'warning');
                recordCameraDiagnosticEvent('qr_still_visible', {
                    backend: telemetry?.backend || 'unknown',
                });
                noteCameraSessionAnomaly('same_qr_persisted');
            }

            return;
        }

        if (Date.now() < gate.cooldownMinUntil) {
            return;
        }

        if (gate.differentCandidateText === normalizedText) {
            gate.differentCandidatePolls += 1;
        } else {
            gate.differentCandidateText = normalizedText;
            gate.differentCandidatePolls = 1;
        }

        if (gate.differentCandidatePolls >= SCAN_GATE_DIFFERENT_POLLS_TO_ACCEPT) {
            await acceptDetectionCandidate(normalizedText, telemetry);
        }
    }

    function resumeAfterSelection(options = {}) {
        const gate = ensureScannerGateState();

        if (state.scanPause?.reason !== 'selection_modal' && gate.mode !== 'blocked_modal') {
            return;
        }

        clearScanPause();
        setScannerPhase('scanning');
        ui.setLoading(false);

        if (gate.lastAcceptedText) {
            enterScannerCooldown(
                gate.lastAcceptedText,
                options.cancelled ? 'selection_closed' : (options.source || 'selection_resolved'),
            );
        } else {
            resetScannerGate(options.source || 'selection_resolved');
        }

        trackEvent('camera_auto_resume_started', {
            source: options.source || 'selection_resolved',
            selectedCameraId: state.selectedCameraId || 'none',
        });
    }

    function legacyHandleDecodedText(decodedText, telemetry) {
        trackFirstScanMetrics(telemetry);
        pauseScanning('scan_result');

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.scanSuccesses += 1;
        }

        recordCameraDiagnosticEvent('scan_success', {
            backend: telemetry?.backend || 'unknown',
        });

        Promise.resolve(scanResultHandler?.(decodedText)).catch((scanError) => {
            console.error('Ошибка обработки скана:', scanError);
            captureException(scanError, {
                operation: 'scan_result_handler',
                screen: state.activeRootScreen,
                tags: {
                    scope: 'scanner',
                },
            });
        });
    }

    async function startZxingDecodeLoop(sessionId, cameraIdToUse, telemetry) {
        try {
            await loadZxingLibrary('scan_start');
        } catch (error) {
            console.error('ZXing не загружен, требуется интернет:', error);
            ui.showScanResult('error', 'Требуется интернет для первого сканирования', '', '');
            captureMessage(
                'ZXing library failed to load - offline or network error',
                {
                    errorName: error?.name || 'UnknownError',
                    operation: 'load_zxing_library',
                    tags: {
                        scope: 'camera',
                        offline: !navigator.onLine,
                    },
                },
                'warning',
            );
            return;
        }

        if (!isCurrentSession(sessionId) || !dom.videoElement) {
            return;
        }

        const ZXing = getZxingReader();
        const codeReader = ensureCodeReader();
        const decodeRunId = (state.decodeRunId || 0) + 1;
        state.decodeRunId = decodeRunId;

        debugCamera('decode_loop_start', {
            backend: 'zxing',
            sessionId,
            decodeRunId,
            cameraIdToUse,
            activeRootScreen: state.activeRootScreen,
        });

        const decodeDeviceId = isIOS() ? undefined : (cameraIdToUse || undefined);

        codeReader.decodeFromVideoDevice(
            decodeDeviceId,
            dom.videoElement.id,
            (result, error) => {
                if (
                    !isCurrentSession(sessionId) ||
                    !isCurrentDecodeRun(decodeRunId)
                ) {
                    return;
                }

                if (result) {
                    void handleDetectionCandidate(result.getText(), telemetry);
                    return;
                }

                if (error instanceof ZXing.NotFoundException) {
                    observeNoDetectionFrame();
                    registerFailedFrame(telemetry);
                    return;
                }

                if (error) {
                    console.error('Ошибка сканирования:', error);
                    captureException(error, {
                        operation: 'decode_from_video_device',
                        screen: state.activeRootScreen,
                        selectedCameraId: state.selectedCameraId || 'none',
                        tags: {
                            scope: 'scanner',
                        },
                    });
                }
            },
        );
    }

    async function startBarcodeDetectorLoop(sessionId, cameraIdToUse, telemetry) {
        if (!dom.videoElement) {
            return;
        }

        let detector = null;

        try {
            detector = createBarcodeDetector();
        } catch (error) {
            captureMessage(
                'BarcodeDetector initialization failed',
                {
                    errorName: error?.name || 'UnknownError',
                    operation: 'barcode_detector_init',
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
            trackScannerBackend('zxing', {
                reason: 'barcode_detector_init_failed',
            });
            await startZxingDecodeLoop(
                sessionId,
                cameraIdToUse,
                switchTelemetryBackend(telemetry, 'zxing'),
            );
            return;
        }

        const decodeRunId = (state.decodeRunId || 0) + 1;
        state.decodeRunId = decodeRunId;
        let fallbackScheduled = false;

        debugCamera('decode_loop_start', {
            backend: 'barcode_detector',
            sessionId,
            decodeRunId,
            cameraIdToUse,
            activeRootScreen: state.activeRootScreen,
        });

        const tick = async () => {
            if (
                !isCurrentSession(sessionId) ||
                !isCurrentDecodeRun(decodeRunId) ||
                !dom.videoElement
            ) {
                return;
            }

            const cadenceMs = getBarcodeDetectorCadenceMs();

            if (
                state.scanPause?.active ||
                state.isProcessing ||
                dom.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
            ) {
                scheduleBarcodeDetectorTick(tick, cadenceMs);
                return;
            }

            try {
                registerBarcodeDetectCall();
                const barcodes = await detector.detect(dom.videoElement);

                if (
                    !isCurrentSession(sessionId) ||
                    !isCurrentDecodeRun(decodeRunId)
                ) {
                    return;
                }

                const decodedBarcode = barcodes.find(
                    (barcode) => typeof barcode.rawValue === 'string' && barcode.rawValue,
                );

                if (decodedBarcode) {
                    await handleDetectionCandidate(decodedBarcode.rawValue, telemetry);
                    scheduleBarcodeDetectorTick(tick, getBarcodeDetectorCadenceMs());
                    return;
                }

                observeNoDetectionFrame();
                registerFailedFrame(telemetry);
                scheduleBarcodeDetectorTick(tick, getBarcodeDetectorCadenceMs());
            } catch (error) {
                console.warn('BarcodeDetector detect failed, switching to ZXing:', error);
                captureMessage(
                    'BarcodeDetector detect failed',
                    {
                        errorName: error?.name || 'UnknownError',
                        operation: 'barcode_detector_detect',
                        tags: {
                            scope: 'camera',
                        },
                    },
                    'warning',
                );

                if (fallbackScheduled) {
                    return;
                }

                fallbackScheduled = true;
                noteCameraSessionAnomaly('barcode_detector_runtime_failure');
                trackScannerBackend('zxing', {
                    reason: 'barcode_detector_runtime_fallback',
                });
                await startZxingDecodeLoop(
                    sessionId,
                    cameraIdToUse,
                    switchTelemetryBackend(telemetry, 'zxing'),
                );
            }
        };

        scheduleBarcodeDetectorTick(tick, getBarcodeDetectorCadenceMs());
    }

    async function startDecodeLoop(sessionId, cameraIdToUse) {
        const support = await getBarcodeDetectorSupport();
        const session = ensureCameraSessionState();

        if (session.preferredBackend === 'zxing') {
            trackScannerBackend('zxing', {
                reason: 'session_forced_fallback',
            });
            await startZxingDecodeLoop(
                sessionId,
                cameraIdToUse,
                createScanTelemetry('zxing'),
            );
            return;
        }

        if (support.supported) {
            trackScannerBackend('barcode_detector', {
                reason: support.reason,
            });
            await startBarcodeDetectorLoop(
                sessionId,
                cameraIdToUse,
                createScanTelemetry('barcode_detector'),
            );
            return;
        }

        trackScannerBackend('zxing', {
            reason: support.reason,
        });
        await startZxingDecodeLoop(
            sessionId,
            cameraIdToUse,
            createScanTelemetry('zxing'),
        );
    }

    async function updateCameraList() {
        if (!dom.cameraSelect || !navigator.mediaDevices?.enumerateDevices) {
            return [];
        }

        try {
            state.availableCameras = await getVideoInputsWithWarmup();
            debugCamera('update_camera_list', {
                availableCameras: state.availableCameras.map((camera) => ({
                    deviceId: camera.deviceId,
                    label: camera.label,
                })),
                selectedCameraId: state.selectedCameraId,
            });

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
            } else {
                const restoredCameraId = resolveStoredCameraId(
                    state.availableCameras,
                    state.selectedCameraId,
                );

                if (restoredCameraId) {
                    syncSelectedCamera(restoredCameraId, {
                        camera: state.availableCameras.find(
                            (camera) => camera.deviceId === restoredCameraId,
                        ),
                    });
                    dom.cameraSelect.value = restoredCameraId;
                }
            }

            if (state.availableCameras.length === 0) {
                dom.cameraSelect.style.display = 'none';
            }

            return state.availableCameras;
        } catch (error) {
            console.error('Ошибка обновления списка камер:', error);
            captureException(error, {
                operation: 'update_camera_list',
                screen: state.activeRootScreen,
                tags: {
                    scope: 'camera',
                },
            });
            dom.cameraSelect.style.display = 'none';
            return [];
        }
    }

    async function pickCameraId(preferredCameraId) {
        const cameras =
            state.availableCameras.length > 0
                ? state.availableCameras
                : await updateCameraList();

        if (isIOS()) {
            if (
                (preferredCameraId === IOS_BACK_CAMERA_ID ||
                    preferredCameraId === IOS_FRONT_CAMERA_ID) &&
                cameras.some((camera) => camera.deviceId === preferredCameraId)
            ) {
                return preferredCameraId;
            }

            return cameras.find((camera) => camera.deviceId === IOS_BACK_CAMERA_ID)
                ?.deviceId || cameras[0]?.deviceId || null;
        }

        const restoredCameraId = resolveStoredCameraId(cameras, preferredCameraId);

        if (restoredCameraId) {
            debugCamera('pick_camera_id_preferred', {
                preferredCameraId,
                resolvedCameraId: restoredCameraId,
                matched: true,
            });
            return restoredCameraId;
        }

        if (preferredCameraId) {
            resetSelectedCamera('stale_selected_camera');
        }

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

        debugCamera('pick_camera_id_fallback', {
            preferredCameraId,
            resolvedCameraId: camera?.deviceId || null,
            availableCameras: cameras.map((item) => ({
                deviceId: item.deviceId,
                label: item.label,
            })),
        });

        return camera ? camera.deviceId : null;
    }

    function clearVideoStream() {
        detachVideoTrackObservers();
        stopCameraWatchdog();

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
                captureMessage(
                    'Video element pause failed',
                    {
                        operation: 'pause_video_element',
                        screen: state.activeRootScreen,
                        tags: {
                            scope: 'camera',
                        },
                    },
                    'warning',
                );
            }

            dom.videoElement.srcObject = null;
        }
    }

    function stopQrScanner(options = {}) {
        const diagnosticSnapshot = {
            sessionSnapshot: getCameraSessionSnapshot(),
            trackSnapshot: getCurrentVideoTrackSnapshot(),
        };

        debugCamera('stop_qr_scanner', {
            reason: options.reason || (options.manual ? 'manual' : 'stop'),
            manual: Boolean(options.manual),
            preservePause: Boolean(options.preservePause),
            activeRootScreen: state.activeRootScreen,
            scannerPhase: state.scannerPhase,
            scannerActive: state.scannerActive,
            scannerStarting: state.scannerStarting,
            selectedCameraId: state.selectedCameraId,
            hasStream: Boolean(state.stream),
        });

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.hardStops += 1;
        }

        recordCameraDiagnosticEvent('stop', {
            manual: options.manual ? 'yes' : 'no',
            preservePause: options.preservePause ? 'yes' : 'no',
            reason: options.reason || (options.manual ? 'manual' : 'stop'),
        });

        if (options.manual) {
            setAutoRestartAllowed(false);
            state.pendingCameraRecovery = null;
        }

        state.stopReason = options.reason || (options.manual ? 'manual' : 'stop');
        state.scannerStarting = false;
        state.decodeRunId += 1;
        cancelPendingRestart();
        resetScannerGate(options.reason || 'stop');

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
            setQrViewportForScannerState();
        }

        ui.setLoading(false);

        if (
            options.manual
            || options.reason === 'camera_switch'
            || options.reason === 'app_hidden'
            || options.reason === 'app_pagehide'
            || String(options.reason || '').startsWith('nav_to_')
        ) {
            resetCameraSession(options.reason || 'stop');
        }

        if (
            options.manual
            || options.reason === 'app_hidden'
            || options.reason === 'app_pagehide'
            || String(options.reason || '').startsWith('nav_to_')
            || options.reason === 'manual_input'
            || options.reason === 'manual_input_submit'
            || options.reason === 'camera_stop_button'
        ) {
            flushCameraDiagnostic(options.reason || 'manual_stop', diagnosticSnapshot);
        }
    }

    async function restartQrScannerIfAllowed() {
        if (!isHomeScreenActive()) {
            debugCamera('restart_blocked_non_home', {
                activeRootScreen: state.activeRootScreen,
                scannerPhase: state.scannerPhase,
                selectedCameraId: state.selectedCameraId,
            });
            return;
        }

        if (!state.autoRestartAllowed || state.scannerStarting || isScannerActive()) {
            if (!state.autoRestartAllowed || state.scannerStarting) {
                return;
            }

            if (await resumePausedScannerIfPossible()) {
                return;
            }

            if (isScannerActive()) {
                if (!state.scanPause?.active) {
                    return;
                }

                stopQrScanner({ reason: 'restart_after_scan_with_dead_stream' });
            } else {
                return;
            }
        }

        const recoveryContext = state.pendingCameraRecovery || null;

        if (recoveryContext) {
            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.restartAttempts += 1;
            }

            recordCameraDiagnosticEvent('restart_attempt', {
                errorName: recoveryContext.errorName || 'UnknownError',
            });
            trackEvent(
                'camera_restart_attempt_after_error',
                {
                    errorName: recoveryContext.errorName || 'UnknownError',
                    retryDelayMs: recoveryContext.retryDelayMs || 0,
                    screen: state.activeRootScreen,
                    selectedCameraId: state.selectedCameraId || 'none',
                },
                'warning',
            );
        }

        clearScanPause();
        await startQrScanner(state.selectedCameraId, {
            recoveryContext,
            startSource: recoveryContext ? 'recovery_restart' : 'auto_resume',
        });
    }

    function scheduleRestartIfAllowed(delayMs) {
        cancelPendingRestart();

        if (!state.autoRestartAllowed) {
            return;
        }

        if (!state.scanPause?.active) {
            setScanPause('scan_result');
        }

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.restartScheduled += 1;
        }

        recordCameraDiagnosticEvent('restart_scheduled', {
            delayMs,
            pendingError: state.pendingCameraRecovery?.errorName || null,
        });

        state.restartTimerId = window.setTimeout(async () => {
            state.restartTimerId = null;
            await restartQrScannerIfAllowed();
        }, delayMs);
    }

    async function startQrScanner(cameraIdOverride, options = {}) {
        const startSource = options.startSource || 'programmatic';
        debugCamera('start_qr_scanner_enter', {
            cameraIdOverride,
            allowOffHome: Boolean(options.allowOffHome),
            activeRootScreen: state.activeRootScreen,
            scannerPhase: state.scannerPhase,
            scannerActive: state.scannerActive,
            scannerStarting: state.scannerStarting,
            selectedCameraId: state.selectedCameraId,
            hasStream: Boolean(state.stream),
        });

        ensureCameraDiagnosticSession(
            options.recoveryContext ? 'recovery_restart' : 'scan_start',
        );
        ensureCameraSessionState().lastStartSource = startSource;

        if (state.cameraDiagnostic?.active) {
            state.cameraDiagnostic.counts.startRequests += 1;
        }

        recordCameraDiagnosticEvent('start_requested', {
            startSource,
            selectedCameraId: cameraIdOverride || state.selectedCameraId || 'auto',
        });

        if (!isHomeScreenActive() && !options.allowOffHome) {
            debugCamera('start_qr_scanner_blocked_non_home', {
                cameraIdOverride,
                allowOffHome: Boolean(options.allowOffHome),
                activeRootScreen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId,
            });
            ui.setLoading(false);
            return;
        }

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
            trackEvent('camera_start_ignored_active_session', {
                reason: 'already_starting',
                selectedCameraId: state.selectedCameraId || 'none',
                source: startSource,
            });
            ui.setLoading(false);
            return;
        }

        if (isScannerActive() && hasLiveVideoTrack(state.stream || dom.videoElement?.srcObject)) {
            const gateMode = ensureScannerGateState().mode;

            if (gateMode === 'cooldown' && startSource === 'user_tap') {
                markQrCleared('user_rearm');
            }

            trackEvent('camera_start_ignored_active_session', {
                reason: gateMode === 'cooldown'
                    ? 'cooldown_active'
                    : 'already_active',
                selectedCameraId: state.selectedCameraId || 'none',
                source: startSource,
            });
            setQrViewportForScannerState();
            ui.setVideoVisible(true);
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
            if (isIOS()) {
                cameraIdToUse = await pickCameraId(cameraIdToUse);

                if (cameraIdToUse) {
                    syncSelectedCamera(cameraIdToUse);
                }

                state.stream = await requestCameraStream(cameraIdToUse);
                debugCamera('get_user_media_success', {
                    platform: 'ios',
                    selectedCameraId: state.selectedCameraId,
                    requestedCameraId: cameraIdToUse,
                });
            } else {
                cameraIdToUse = await pickCameraId(cameraIdToUse);

                if (cameraIdToUse) {
                    syncSelectedCamera(cameraIdToUse);
                }

                state.stream = await requestCameraStream(cameraIdToUse);

                if (!cameraIdToUse) {
                    const refreshedCameras = await updateCameraList();
                    const fallbackCamera =
                        refreshedCameras.find((camera) => /back/i.test(camera.label || '')) ||
                        refreshedCameras[0] ||
                        null;

                    if (fallbackCamera?.deviceId) {
                        syncSelectedCamera(fallbackCamera.deviceId);
                    }
                }

                debugCamera('get_user_media_success', {
                    platform: 'default',
                    selectedCameraId: state.selectedCameraId,
                    requestedCameraId: cameraIdToUse,
                });
            }

            if (!isCurrentSession(sessionId)) {
                state.scannerStarting = false;
                setScannerPhase('idle');
                clearVideoStream();
                return;
            }

            dom.videoElement.setAttribute('playsinline', 'true');
            dom.videoElement.setAttribute('autoplay', 'true');
            dom.videoElement.muted = true;
            dom.videoElement.srcObject = state.stream;
            attachVideoTrackObservers(state.stream, sessionId);
            dom.videoElement.style.objectFit = 'cover';
            dom.videoElement.style.width = '100%';
            dom.videoElement.style.height = '100%';
            dom.videoElement.style.aspectRatio = '1/1';
            await dom.videoElement.play();
            debugCamera('video_play_success', {
                selectedCameraId: state.selectedCameraId,
                activeRootScreen: state.activeRootScreen,
            });

            if (!isCurrentSession(sessionId)) {
                state.scannerStarting = false;
                setScannerPhase('idle');
                clearVideoStream();
                return;
            }

            resetCodeReader({ discardInstance: true });

            state.scannerActive = true;
            state.scannerStarting = false;
            setScannerPhase('scanning');
            resetScannerGate(options.recoveryContext ? 'recovery_restart' : startSource);
            setQrViewportForScannerState();
            ui.setLoading(false);
            startCameraWatchdog(sessionId);

            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.startSuccesses += 1;
            }

            recordCameraDiagnosticEvent('start_succeeded', {
                cameraId: state.selectedCameraId || 'auto',
                source: startSource,
                sessionId,
            });

            if (options.recoveryContext) {
                if (state.cameraDiagnostic?.active) {
                    state.cameraDiagnostic.counts.restartRecovered += 1;
                }

                recordCameraDiagnosticEvent('restart_recovered', {
                    errorName: options.recoveryContext.errorName || 'UnknownError',
                });
                trackEvent(
                    'camera_restart_recovered',
                    {
                        errorName: options.recoveryContext.errorName || 'UnknownError',
                        screen: state.activeRootScreen,
                        selectedCameraId: state.selectedCameraId || 'none',
                    },
                    'info',
                );
                state.pendingCameraRecovery = null;
            }

            await startDecodeLoop(sessionId, cameraIdToUse);
            debugCamera('start_qr_scanner_ready', {
                sessionId,
                selectedCameraId: state.selectedCameraId,
                scannerPhase: state.scannerPhase,
                scannerActive: state.scannerActive,
            });
        } catch (error) {
            state.scannerStarting = false;
            setScannerPhase('idle');
            console.error('Ошибка камеры:', error);
            if (state.cameraDiagnostic?.active) {
                state.cameraDiagnostic.counts.startFailures += 1;
            }

            recordCameraDiagnosticEvent('start_failed', {
                errorName: error?.name || 'UnknownError',
            });
            captureException(error, {
                operation: 'start_qr_scanner',
                screen: state.activeRootScreen,
                selectedCameraId: state.selectedCameraId || 'none',
                tags: {
                    scope: 'camera',
                },
            });
            trackEvent(
                'camera_start_failed',
                {
                    errorName: error?.name || 'UnknownError',
                    screen: state.activeRootScreen,
                    selectedCameraId: state.selectedCameraId || 'none',
                },
                'error',
            );
            noteCameraSessionAnomaly('camera_start_failed', {
                errorName: error?.name || 'UnknownError',
            });
            if (
                error?.name === 'NotAllowedError'
                || error?.name === 'PermissionDeniedError'
            ) {
                trackEvent(
                    'camera_permission_denied',
                    {
                        screen: state.activeRootScreen,
                        selectedCameraId: state.selectedCameraId || 'none',
                    },
                    'warning',
                );
            }
            debugCamera('start_qr_scanner_error', {
                message: error?.message,
                selectedCameraId: state.selectedCameraId,
                activeRootScreen: state.activeRootScreen,
            });
            stopQrScanner({ reason: 'camera_error' });

            if (isRecoverableCameraStartError(error)) {
                state.pendingCameraRecovery = {
                    errorName: error?.name || 'UnknownError',
                    retryDelayMs: 1400,
                };
                trackEvent(
                    'camera_restart_scheduled_after_error',
                    {
                        errorName: error?.name || 'UnknownError',
                        screen: state.activeRootScreen,
                        selectedCameraId: state.selectedCameraId || 'none',
                    },
                    'warning',
                );
                ui.showCameraNotice(
                    'warning',
                    'Камера временно недоступна, повторный запуск...',
                    {
                        duration: 2200,
                    },
                );
                scheduleRestartIfAllowed(state.pendingCameraRecovery.retryDelayMs);
                return;
            }

            state.pendingCameraRecovery = null;

            ui.showCameraNotice(
                'error',
                error?.message || 'Ошибка запуска камеры',
                {
                    duration: 4200,
                },
            );
        }
    }

    async function handleCameraSelection(cameraId, options = {}) {
        const restartIfActive =
            Boolean(options.restartIfActive) &&
            isScannerActive();

        syncSelectedCamera(cameraId || null);
        trackEvent('camera_changed', {
            cameraId: cameraId || 'none',
            source: options.source || 'unknown',
        });
        debugCamera('handle_camera_selection', {
            cameraId,
            selectedCameraId: state.selectedCameraId,
            restartIfActive,
            source: options.source || 'unknown',
            activeRootScreen: state.activeRootScreen,
        });

        if (!restartIfActive) {
            return;
        }

        stopQrScanner({ reason: 'camera_switch' });
        await startQrScanner(state.selectedCameraId, {
            allowOffHome: true,
            startSource: 'camera_change',
        });
    }

    async function warmupScannerBackend() {
        const support = await getBarcodeDetectorSupport();
        const warmupPolicy = evaluateWarmupPolicy(support);

        if (support.supported) {
            recordWarmupDecision({
                skipped: true,
                reason: warmupPolicy.reason || 'native_backend',
            });
            return {
                backend: 'barcode_detector',
                reason: support.reason,
            };
        }

        if (!warmupPolicy.shouldWarmup) {
            recordWarmupDecision({
                skipped: true,
                reason: warmupPolicy.reason,
            });
            return {
                backend: 'zxing',
                reason: warmupPolicy.reason,
                skipped: true,
            };
        }

        recordWarmupDecision({
            skipped: false,
        });

        try {
            await loadZxingLibrary('warmup');
            return {
                backend: 'zxing',
                reason: support.reason,
            };
        } catch (error) {
            captureMessage(
                'ZXing warmup failed',
                {
                    errorName: error?.name || 'UnknownError',
                    operation: 'warmup_zxing',
                    tags: {
                        scope: 'camera',
                    },
                },
                'warning',
            );
            return {
                backend: 'zxing',
                error,
                reason: 'warmup_failed',
            };
        }
    }

    return {
        cancelPendingRestart,
        handleCameraSelection,
        isScannerActive,
        restartQrScannerIfAllowed,
        resumeAfterSelection,
        scheduleRestartIfAllowed,
        setAutoRestartAllowed,
        setScanResultHandler,
        startQrScanner,
        stopQrScanner,
        updateCameraList,
        warmupScannerBackend,
    };
}
