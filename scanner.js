import {
    captureException,
    trackEvent,
} from './logger.js';
import {
    createCallGuard,
    getUriUserFriendlyMessage,
    ERROR_CATEGORY,
} from './error-handler.js';

export function createScannerController({
    state,
    service,
    ui,
    camera,
}) {
    const SCAN_VIBRATION_MS = 100;
    const SCAN_VIBRATION_THROTTLE_MS = 1500;

    // КРИТИЧНО: Guard для предотвращения concurrent обработки скана
    // Гарантирует что обработка одного кода завершится перед началом следующей
    const processGuard = createCallGuard();

    // КРИТИЧНО: Guard для ручной отправки формы
    // Предотвращает duplicate submit если пользователь несколько раз нажимает кнопку
    const submitGuard = createCallGuard();

    function triggerScanFeedback(status) {
        if (!['success', 'already_scanned', 'not_found'].includes(status)) {
            return;
        }

        const now = Date.now();

        if (now - (state.lastScanFeedbackAt || 0) < SCAN_VIBRATION_THROTTLE_MS) {
            ui.flashFrame();
            return;
        }

        state.lastScanFeedbackAt = now;
        navigator.vibrate?.(SCAN_VIBRATION_MS);
        ui.flashFrame();
    }

    async function processDeliveryScan(delivery) {
        const duplicateScan = await service.findScanByDeliveryId(delivery.id);

        if (duplicateScan) {
            ui.showScanResult(
                'already_scanned',
                delivery.id,
                delivery.courier_name,
                `Ранее сканировал: ${duplicateScan.courier_name || ''}`,
            );
            return {
                status: 'already_scanned',
                delivery,
            };
        }

        const savedScan = await service.saveScan(delivery.id, delivery.courier_name, Date.now());
        ui.showScanResult('success', delivery.id, delivery.courier_name);

        if (savedScan?.offlineQueued) {
            ui.showToast('Скан сохранён офлайн и будет отправлен позже', {
                duration: 2200,
            });
        }

        return {
            status: 'success',
            delivery,
        };
    }

    async function processTransferId(transferId, options = {}) {
        // КРИТИЧНО: Используем guard для предотвращения concurrent обработки
        // Возвращаем null если уже обрабатываем перевод - предотвращаем дублирование
        return processGuard.execute(
            async () => {
                ui.setLoading(true);

                try {
                    const matchedResult = await service.findMatchingDeliveriesByTransferId(
                        transferId,
                    );

                    if (!matchedResult.cleanedId) {
                        ui.showScanResult('error', 'Неверный формат QR', '', '', '');
                        trackEvent(
                            'manual_submit_invalid',
                            {
                                inputLength: String(transferId || '').length,
                                source: options.resumeAfterSelection ? 'scan' : 'manual',
                            },
                            'warning',
                        );
                        return {
                            status: 'invalid',
                        };
                    }

                    if (matchedResult.matches.length === 0) {
                        ui.showScanResult('not_found', matchedResult.cleanedId);
                        trackEvent('delivery_not_found', {
                            source: options.resumeAfterSelection ? 'scan' : 'manual',
                            transferId: matchedResult.cleanedId,
                        });
                        return {
                            status: 'not_found',
                            cleanedId: matchedResult.cleanedId,
                        };
                    }

                    if (matchedResult.matches.length === 1) {
                        return processDeliveryScan(matchedResult.matches[0]);
                    }

                    ui.showTransferSelectModal(
                        matchedResult.matches,
                        async (selected) => {
                            try {
                                await processDeliveryScan(selected);
                            } finally {
                                camera.resumeAfterSelection?.({
                                    cancelled: false,
                                    source: 'selection_resolved',
                                });
                            }
                        },
                        () => {
                            camera.resumeAfterSelection?.({
                                cancelled: true,
                                source: 'selection_closed',
                            });
                        },
                    );

                    return {
                        status: 'selection_required',
                        cleanedId: matchedResult.cleanedId,
                    };
                } catch (error) {
                    console.error('Ошибка при поиске передачи:', error);
                    captureException(error, {
                        operation: 'process_transfer_id',
                        source: options.resumeAfterSelection ? 'scan' : 'manual',
                        transferId: transferId || '',
                        tags: {
                            scope: 'scanner',
                        },
                    });

                    // user-friendly сообщение об ошибке
                    const errorMessage = error?.message?.includes('network')
                        ? 'Ошибка сети. Проверьте подключение.'
                        : 'Ошибка при поиске передачи.';

                    ui.showScanResult('error', errorMessage, '', '', '');

                    return {
                        status: 'error',
                        error,
                    };
                } finally {
                    ui.setLoading(false);
                }
            },
            {
                operation: 'process_transfer_id',
                source: options.resumeAfterSelection ? 'scan' : 'manual',
            }
        );
    }

    async function handleScanSuccess(decodedText) {
        const result = await processTransferId(decodedText, {
            resumeAfterSelection: true,
        });

        triggerScanFeedback(result?.status);
        return result;
    }

    return {
        handleScanSuccess,
        processDeliveryScan,
        processTransferId,
    };
}
