/**
 * Система обработки ошибок для приложения
 * Предоставляет:
 * - Категоризацию ошибок (сеть, разрешение, устройство, данные)
 * - Безопасные обёртки для async операций
 * - Логирование с контекстом
 * - User-friendly сообщения об ошибках
 */

import { captureException, captureMessage, trackEvent } from './logger.js';

// Категории ошибок
export const ERROR_CATEGORY = {
    PERMISSION: 'permission_error',
    DEVICE: 'device_error',
    NETWORK: 'network_error',
    DATABASE: 'database_error',
    DATA: 'data_error',
    TIMEOUT: 'timeout_error',
    UNKNOWN: 'unknown_error',
};

// Типы ошибок разрешений
const PERMISSION_ERRORS = new Set([
    'NotAllowedError',
    'PermissionDeniedError',
    'PermissionDenied',
]);

// Типы ошибок устройства
const DEVICE_ERRORS = new Set([
    'NotFoundError',
    'NotReadableError',
    'TrackStartError',
    'OverconstrainedError',
]);

// Типы сетевых ошибок
const NETWORK_ERROR_PATTERNS = /network|offline|fetch|connection|timeout/i;

/**
 * Определяет категорию ошибки
 * @param {Error} error Объект ошибки
 * @returns {string} Категория из ERROR_CATEGORY
 */
export function categorizeError(error) {
    if (!error) return ERROR_CATEGORY.UNKNOWN;

    const errorName = error?.name || '';
    const errorMessage = String(error?.message || '').toLowerCase();
    const errorCode = error?.code || '';

    // Проверяем разрешения
    if (PERMISSION_ERRORS.has(errorName)) {
        return ERROR_CATEGORY.PERMISSION;
    }

    // Проверяем устройство
    if (DEVICE_ERRORS.has(errorName)) {
        return ERROR_CATEGORY.DEVICE;
    }

    // Проверяем таймаут
    if (errorMessage.includes('timeout') || errorName === 'TimeoutError') {
        return ERROR_CATEGORY.TIMEOUT;
    }

    // Проверяем сеть
    if (NETWORK_ERROR_PATTERNS.test(errorMessage) || NETWORK_ERROR_PATTERNS.test(errorName)) {
        return ERROR_CATEGORY.NETWORK;
    }

    // Проверяем IndexedDB
    if (errorCode === 'QuotaExceededError' || errorName === 'QuotaExceededError') {
        return ERROR_CATEGORY.DATABASE;
    }

    // Проверяем базу данных
    if (errorName.includes('Error') && (errorMessage.includes('transaction') || errorMessage.includes('idb'))) {
        return ERROR_CATEGORY.DATABASE;
    }

    return ERROR_CATEGORY.UNKNOWN;
}

/**
 * Безопасное выполнение async операции с обработкой ошибок
 * @param {Function} asyncFn Async функция
 * @param {Object} options Опции: { operation, context, shouldThrow, defaultReturn }
 * @returns {Promise} Результат или defaultReturn
 */
export async function safeAsyncCall(asyncFn, options = {}) {
    const {
        operation = 'unknown_operation',
        context = {},
        shouldThrow = false,
        defaultReturn = null,
        timeout = 0,
    } = options;

    try {
        let promise = asyncFn();

        // Добавляем таймаут если указан
        if (timeout > 0) {
            promise = Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Request timeout')), timeout)
                ),
            ]);
        }

        return await promise;
    } catch (error) {
        const category = categorizeError(error);
        const errorContext = {
            operation,
            category,
            errorName: error?.name || 'UnknownError',
            errorMessage: error?.message || 'Unknown error',
            ...context,
        };

        // Логируем ошибку
        captureException(error, errorContext, 'error');

        // Отслеживаем событие
        trackEvent(`error_${category}`, {
            operation,
            ...errorContext,
        }, 'warning');

        if (shouldThrow) {
            throw createErrorObject(category, error, errorContext);
        }

        return defaultReturn;
    }
}

/**
 * Создаёт стандартный объект ошибки
 */
export function createErrorObject(category, originalError, metadata = {}) {
    return {
        category,
        timestamp: Date.now(),
        originalError,
        message: getUriUserFriendlyMessage(category),
        metadata,
    };
}

/**
 * Возвращает user-friendly сообщение об ошибке
 */
export function getUriUserFriendlyMessage(category, details = {}) {
    const messages = {
        [ERROR_CATEGORY.PERMISSION]: 'Доступ к камере запрещен. Проверьте разрешения в настройках приложения.',
        [ERROR_CATEGORY.DEVICE]: 'Камера недоступна или неисправна. Попробуйте перезагрузить приложение.',
        [ERROR_CATEGORY.NETWORK]: 'Ошибка сети. Проверьте подключение к интернету.',
        [ERROR_CATEGORY.DATABASE]: 'Ошибка сохранения данных. Попробуйте позже.',
        [ERROR_CATEGORY.DATA]: 'Неверны данные. Сканируйте корректный QR-код.',
        [ERROR_CATEGORY.TIMEOUT]: 'Операция заняла слишком много времени. Попробуйте ещё раз.',
        [ERROR_CATEGORY.UNKNOWN]: 'Неизвестная ошибка. Попробуйте позже.',
    };

    return messages[category] || messages[ERROR_CATEGORY.UNKNOWN];
}

/**
 * Безопасно запрашивает доступ к камере
 * Обрабатывает все типы ошибок: разрешения, устройство, таймаут
 */
export async function safeRequestCamera(constraints, options = {}) {
    const { timeout = 5000, retries = 1, ...otherOptions } = options;

    if (!navigator.mediaDevices?.getUserMedia) {
        throw createErrorObject(
            ERROR_CATEGORY.DEVICE,
            new Error('getUserMedia not supported'),
            { operation: 'request_camera', ...otherOptions }
        );
    }

    let lastError = null;
    let stream = null;

    // Пытаемся несколько раз с таймаутом
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            stream = await safeAsyncCall(
                () => navigator.mediaDevices.getUserMedia(constraints),
                {
                    operation: 'request_camera',
                    context: {
                        attempt,
                        retries,
                        ...otherOptions,
                    },
                    timeout,
                    shouldThrow: true,
                }
            );

            if (stream) {
                trackEvent('camera_request_success', {
                    attempt,
                    ...otherOptions,
                });
                return stream;
            }
        } catch (error) {
            lastError = error;

            // Если это ошибка разрешений - не пытаемся ещё раз
            if (categorizeError(error) === ERROR_CATEGORY.PERMISSION) {
                throw error;
            }

            // Если это не последняя попытка - ждем перед следующей
            if (attempt < retries) {
                const backoffMs = 800 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    if (lastError) {
        throw lastError;
    }

    throw createErrorObject(
        ERROR_CATEGORY.DEVICE,
        new Error('Failed to get camera stream'),
        { operation: 'request_camera', retries, ...otherOptions }
    );
}

/**
 * Безопасно закрывает MediaStream
 * Гарантирует что все треки остановлены
 */
export function safeCloseStream(stream, context = {}) {
    if (!stream) return;

    try {
        const tracks = stream.getTracks?.() || [];
        let stoppedCount = 0;

        for (const track of tracks) {
            try {
                track.stop();
                stoppedCount += 1;
            } catch (error) {
                captureMessage(
                    'Failed to stop media track',
                    {
                        trackKind: track?.kind,
                        trackId: track?.id,
                        operation: 'close_stream',
                        ...context,
                    },
                    'warning'
                );
            }
        }

        trackEvent('stream_closed', {
            tracks: tracks.length,
            stopped: stoppedCount,
            ...context,
        });
    } catch (error) {
        captureMessage(
            'Failed to close media stream',
            {
                errorName: error?.name,
                operation: 'close_stream',
                ...context,
            },
            'warning'
        );
    }
}

/**
 * Создаёт debounce функцию для предотвращения duplicate actions
 */
export function createDebounce(fn, delayMs = 300) {
    let timerId = null;
    let lastCallTime = 0;

    return function debounced(...args) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        if (timeSinceLastCall < delayMs) {
            clearTimeout(timerId);
        }

        timerId = setTimeout(() => {
            lastCallTime = Date.now();
            fn(...args);
        }, delayMs);
    };
}

/**
 * Создаёт throttle функцию для rate limiting
 */
export function createThrottle(fn, minimumIntervalMs = 300) {
    let lastCallTime = 0;
    let timerId = null;
    let pendingArgs = null;

    return function throttled(...args) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        if (timeSinceLastCall >= minimumIntervalMs) {
            lastCallTime = now;
            fn(...args);
            clearTimeout(timerId);
            pendingArgs = null;
        } else {
            pendingArgs = args;
            clearTimeout(timerId);
            timerId = setTimeout(() => {
                if (pendingArgs) {
                    lastCallTime = Date.now();
                    fn(...pendingArgs);
                    pendingArgs = null;
                }
            }, minimumIntervalMs - timeSinceLastCall);
        }
    };
}

/**
 * Создаёт guard функцию для предотвращения concurrent вызовов
 */
export function createCallGuard() {
    let isExecuting = false;

    return {
        isExecuting: () => isExecuting,
        execute: async (fn, context = {}) => {
            if (isExecuting) {
                captureMessage(
                    'Concurrent call prevented',
                    {
                        operation: context.operation || 'unknown',
                        ...context,
                    },
                    'warning'
                );
                return null;
            }

            isExecuting = true;
            try {
                return await fn();
            } finally {
                isExecuting = false;
            }
        },
        reset: () => {
            isExecuting = false;
        },
    };
}

/**
 * Безопасно выполняет cleanup функцию даже если есть ошибка
 */
export async function whileSafe(setupFn, cleanupFn) {
    let result = null;
    let error = null;

    try {
        result = await setupFn();
    } catch (err) {
        error = err;
    } finally {
        try {
            await cleanupFn();
        } catch (cleanupError) {
            captureMessage(
                'Cleanup function failed',
                {
                    originalError: error?.message,
                    cleanupError: cleanupError?.message,
                },
                'warning'
            );
        }
    }

    if (error) {
        throw error;
    }

    return result;
}
