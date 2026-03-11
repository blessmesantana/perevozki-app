function applyStyles(element, styles) {
    Object.assign(element.style, styles);
}

export function createUiController({ dom }) {
    let cameraNoticeElement = null;
    let scanPauseOverlay = null;
    let qrViewportState = 'idle';

    function ensureScanPauseOverlay() {
        if (!dom.qrContainer) {
            return null;
        }

        if (!scanPauseOverlay) {
            scanPauseOverlay = document.createElement('div');
            scanPauseOverlay.setAttribute('aria-hidden', 'true');
            applyStyles(scanPauseOverlay, {
                position: 'absolute',
                inset: '0',
                background: '#3f51b5',
                borderRadius: '20px',
                opacity: '0',
                pointerEvents: 'none',
                transform: 'scale(0.985)',
                transition: 'opacity 220ms cubic-bezier(0.4, 0, 0.2, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                zIndex: '9',
            });
            dom.qrContainer.appendChild(scanPauseOverlay);
        }

        return scanPauseOverlay;
    }

    function applyQrViewportState() {
        const overlay = ensureScanPauseOverlay();

        if (dom.qrSpinner) {
            dom.qrSpinner.classList.toggle('active', qrViewportState === 'loading');
        }

        if (!overlay) {
            return;
        }

        if (qrViewportState === 'scanning' || qrViewportState === 'loading') {
            overlay.style.opacity = '0';
            overlay.style.transform = 'scale(0.985)';
            overlay.style.pointerEvents = 'none';
            hideAllQrIcons();
            return;
        }

        overlay.style.opacity = '1';
        overlay.style.transform = 'scale(1)';
        overlay.style.pointerEvents = 'none';
        showAllQrIcons();
    }

    function setQrViewportState(nextState) {
        qrViewportState = nextState;
        applyQrViewportState();
    }

    function setModalContentWidth(modalContent, options = {}) {
        if (!modalContent) {
            return;
        }

        if (!dom.inputModeButton) {
            modalContent.style.minWidth = options.minWidth || '220px';
            modalContent.style.maxWidth = options.maxWidth || '90vw';
            return;
        }

        const width = Math.min(
            dom.inputModeButton.offsetWidth,
            options.maxButtonWidth || dom.inputModeButton.offsetWidth,
        );

        modalContent.style.width = `${width}px`;
        modalContent.style.minWidth = options.minWidth || '220px';
        modalContent.style.maxWidth = options.maxWidth || '90vw';
    }

    function syncOverlayStyles() {
        if (!dom.inputModeButton || !dom.qrResultOverlay) {
            return;
        }

        applyStyles(dom.qrResultOverlay, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            margin: '0',
            padding: '0',
            boxSizing: 'border-box',
            borderRadius: window.getComputedStyle(dom.inputModeButton).borderRadius,
        });
    }

    function clearScanResult() {
        if (!dom.qrResultOverlay) {
            return;
        }

        clearTimeout(dom.qrResultOverlay._hideTimer);
        dom.qrResultOverlay.className = '';
        dom.qrResultOverlay.innerHTML = '';
    }

    function showScanResult(status, message = '', courier = '', previousCourier = '', rawData = '') {
        if (!dom.qrResultOverlay) {
            return;
        }

        syncOverlayStyles();

        let text = '';
        let colorClass = '';

        if (status === 'already_scanned') {
            text = previousCourier
                ? `${courier || ''}\n${previousCourier}`
                : courier || '';
            colorClass = 'already_scanned';
        } else if (status === 'success') {
            text = courier || '';
            colorClass = 'success';
        } else if (status === 'not_found') {
            text = message
                ? `Передача с ID ${message} не найдена`
                : 'Передача не найдена';
            colorClass = 'error';
        } else if (status === 'error') {
            text = message;
            colorClass = 'error';
        } else {
            text = message;
        }

        dom.qrResultOverlay.innerHTML = `<div class='qr-overlay-box'>${text.trim().replace(/\n/g, '<br>')}</div>`;
        dom.qrResultOverlay.className = `show ${colorClass}`.trim();

        if (dom.resultDiv) {
            dom.resultDiv.style.display = 'none';
        }

        clearTimeout(dom.qrResultOverlay._hideTimer);
        dom.qrResultOverlay._hideTimer = window.setTimeout(() => {
            clearScanResult();
        }, 2200);
    }

    function hideAllQrIcons() {
        dom.qrIcons.forEach((icon) => icon.classList.add('hide'));
    }

    function showAllQrIcons() {
        dom.qrIcons.forEach((icon) => icon.classList.remove('hide'));
    }

    function setLoading(active) {
        if (dom.loadingIndicator) {
            dom.loadingIndicator.style.display = active ? 'block' : 'none';
        }

        applyQrViewportState();
    }

    function setVideoVisible(isVisible) {
        if (!dom.videoElement) {
            return;
        }

        dom.videoElement.style.display = isVisible ? '' : 'none';
    }

    function showManualInput() {
        dom.inputModeButton?.classList.add('active');
        dom.manualInputContainer?.classList.add('active');
    }

    function hideManualInput() {
        dom.inputModeButton?.classList.remove('active');
        dom.manualInputContainer?.classList.remove('active');
    }

    function focusManualInput() {
        dom.manualTransferIdInput?.focus();
    }

    function flashFrame() {
        if (!dom.qrContainer) {
            return;
        }

        dom.qrContainer.classList.remove('flash');
        window.setTimeout(() => {
            dom.qrContainer?.classList.add('flash');
        }, 0);
    }

    function createFloatingMessage(text, backgroundColor, duration) {
        const message = document.createElement('div');
        message.textContent = text;

        applyStyles(message, {
            position: 'fixed',
            top: '24px',
            left: '50%',
            transform: 'translateX(-50%) translateY(-6px)',
            color: '#fff',
            fontFamily: 'Inter, sans-serif',
            fontSize: '15px',
            fontWeight: '500',
            padding: '14px 32px',
            borderRadius: '24px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            zIndex: '99999',
            opacity: '0',
            transition: 'opacity 220ms cubic-bezier(0.4, 0, 0.2, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1), background-color 220ms cubic-bezier(0.4, 0, 0.2, 1)',
            background: backgroundColor,
        });

        document.body.appendChild(message);
        window.setTimeout(() => {
            message.style.opacity = '1';
            message.style.transform = 'translateX(-50%) translateY(0)';
        }, 50);
        window.setTimeout(() => {
            message.style.opacity = '0';
            message.style.transform = 'translateX(-50%) translateY(-6px)';
        }, Math.max(duration - 400, 400));
        window.setTimeout(() => {
            message.remove();
        }, duration);
    }

    function showToast(text, options = {}) {
        const backgroundColor = options.type === 'error' ? '#ea1e63' : '#43ea7c';
        const duration = options.duration || 1600;

        createFloatingMessage(text, backgroundColor, duration);
    }

    function showCameraNotice(kind, text, options = {}) {
        const duration = options.duration || (kind === 'error' ? 3600 : 2200);
        const background = kind === 'error' ? '#ea1e63' : '#3f51b5';

        if (!cameraNoticeElement) {
            cameraNoticeElement = document.createElement('div');
            applyStyles(cameraNoticeElement, {
                position: 'fixed',
                top: '24px',
                left: '50%',
                transform: 'translateX(-50%) translateY(-6px)',
                color: '#fff',
                fontFamily: 'Inter, sans-serif',
                fontSize: '14px',
                fontWeight: '500',
                padding: '12px 24px',
                borderRadius: '20px',
                boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
                zIndex: '99998',
                opacity: '0',
                transition: 'opacity 220ms cubic-bezier(0.4, 0, 0.2, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1), background-color 220ms cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: 'none',
            });
            document.body.appendChild(cameraNoticeElement);
        }

        cameraNoticeElement.textContent = text;
        cameraNoticeElement.style.background = background;
        cameraNoticeElement.style.opacity = '1';
        cameraNoticeElement.style.transform = 'translateX(-50%) translateY(0)';

        clearTimeout(cameraNoticeElement._hideTimer);
        cameraNoticeElement._hideTimer = window.setTimeout(() => {
            if (cameraNoticeElement) {
                cameraNoticeElement.style.opacity = '0';
                cameraNoticeElement.style.transform = 'translateX(-50%) translateY(-6px)';
            }
        }, duration);
    }

    function showScanPauseOverlay() {
        setQrViewportState('paused');
    }

    function hideScanPauseOverlay() {
        setQrViewportState('scanning');
    }

    function createSidebarButton(options) {
        const button = document.createElement('button');
        button.id = options.id || '';

        applyStyles(button, {
            background: 'none',
            color: '#fff',
            border: 'none',
            fontSize: options.fontSize || '13px',
            fontWeight: '500',
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            borderRadius: '18px',
            transition: 'background 0.2s',
            letterSpacing: 'normal',
            cursor: 'pointer',
            padding: options.padding || '12px 0 10px 0',
            width: '100%',
            marginTop: options.marginTop || '0',
            marginBottom: options.marginBottom || '0',
            display: options.display || 'block',
            alignItems: options.alignItems || '',
            justifyContent: options.justifyContent || '',
        });

        if (options.html) {
            button.innerHTML = options.html;
        } else {
            button.textContent = options.label;
        }

        if (options.className) {
            button.classList.add(options.className);
        }

        return button;
    }

    function createPrimaryButton(label, options = {}) {
        const button = document.createElement('button');
        button.textContent = label;

        applyStyles(button, {
            background: '#ea1e63',
            color: '#fff',
            border: 'none',
            borderRadius: '18px',
            fontSize: options.fontSize || '13px',
            fontWeight: '500',
            fontFamily: 'Inter, sans-serif',
            padding: options.padding || '12px 0 10px 0',
            width: '100%',
            marginTop: options.marginTop || '8px',
            marginBottom: options.marginBottom || '0',
            cursor: 'pointer',
        });

        if (options.className) {
            button.classList.add(options.className);
        }

        return button;
    }

    function createSecondaryButton(label, options = {}) {
        const button = document.createElement('button');
        button.textContent = label;

        applyStyles(button, {
            background: 'none',
            color: '#fff',
            border: '1px solid #fff',
            borderRadius: '18px',
            fontSize: options.fontSize || '13px',
            fontWeight: '500',
            fontFamily: 'Inter, sans-serif',
            padding: options.padding || '10px 0',
            width: '100%',
            cursor: 'pointer',
        });

        if (options.className) {
            button.classList.add(options.className);
        }

        return button;
    }

    function createModal(options = {}) {
        const existingModal = options.modalId
            ? document.getElementById(options.modalId)
            : null;

        if (existingModal) {
            if (typeof existingModal._cleanupModal === 'function') {
                existingModal._cleanupModal();
            } else {
                existingModal.remove();
            }
        }

        const backdrop = document.createElement('div');
        const content = document.createElement('div');

        if (options.modalId) {
            backdrop.id = options.modalId;
        }

        applyStyles(backdrop, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: options.zIndex || '9999',
        });

        applyStyles(content, {
            background: '#3f51b5',
            borderRadius: options.borderRadius || '32px',
            padding: options.padding || '32px 24px',
            color: 'white',
            textAlign: 'center',
            position: 'relative',
            fontFamily: 'Inter, sans-serif',
            fontSize: options.fontSize || '13px',
            maxHeight: options.maxHeight || '80vh',
            overflowY: 'auto',
        });

        if (options.className) {
            content.classList.add(options.className);
        }

        const syncWidth = () => {
            setModalContentWidth(content, {
                maxButtonWidth: options.maxButtonWidth,
                minWidth: options.minWidth,
                maxWidth: options.maxWidth,
            });
        };

        const close = () => {
            if (backdrop._isClosed) {
                return;
            }

            backdrop._isClosed = true;
            window.removeEventListener('resize', syncWidth);
            options.onClose?.();
            backdrop.remove();
        };

        backdrop._cleanupModal = close;
        backdrop.addEventListener('click', close);
        content.addEventListener('click', (event) => event.stopPropagation());

        syncWidth();
        window.addEventListener('resize', syncWidth);

        backdrop.appendChild(content);
        document.body.appendChild(backdrop);

        return { backdrop, content, close, syncWidth };
    }

    function createConfirmDialog(options) {
        const modal = createModal({
            zIndex: options.zIndex || '10000',
            borderRadius: '24px',
            padding: '28px 20px',
            fontSize: '15px',
            className: options.className || 'archive-confirm-box',
            maxButtonWidth: options.maxButtonWidth || 420,
        });

        const textBlock = document.createElement('div');
        textBlock.innerHTML = options.html;
        textBlock.style.marginBottom = '18px';

        const confirmButton = createPrimaryButton(options.confirmText, {
            padding: '10px 0',
            marginTop: '0',
            marginBottom: '10px',
            className: 'archive-confirm-btn',
        });
        const cancelButton = createSecondaryButton(options.cancelText || 'Отмена', {
            className: 'archive-cancel-btn',
        });

        modal.content.appendChild(textBlock);
        modal.content.appendChild(confirmButton);
        modal.content.appendChild(cancelButton);

        cancelButton.addEventListener('click', modal.close);

        return {
            ...modal,
            confirmButton,
            cancelButton,
            textBlock,
        };
    }

    function showSelectionModal(options) {
        const modal = createModal({
            modalId: options.modalId,
            className: options.className || 'select-modal-content',
            zIndex: options.zIndex || '9999',
            maxButtonWidth: options.maxButtonWidth,
            borderRadius: options.borderRadius || '32px',
            padding: options.padding || '32px 24px',
        });

        const title = document.createElement('div');
        title.textContent = options.title;
        applyStyles(title, {
            fontSize: options.titleFontSize || '13px',
            fontWeight: '500',
            marginBottom: '18px',
            fontFamily: 'Inter, sans-serif',
        });
        modal.content.appendChild(title);

        options.items.forEach((item) => {
            const button = createPrimaryButton(options.getLabel(item), {
                padding: '10px 0',
                marginTop: '8px',
                marginBottom: '0',
            });

            button.addEventListener('click', () => {
                modal.close();
                options.onSelect(item);
            });

            modal.content.appendChild(button);
        });

        return modal;
    }

    function showTransferSelectModal(deliveries, onSelect) {
        return showSelectionModal({
            modalId: 'transferSelectModal',
            title: 'Выберите передачу',
            zIndex: '10001',
            borderRadius: '24px',
            padding: '28px 20px',
            maxButtonWidth: 420,
            items: deliveries,
            getLabel: (delivery) => {
                const date = delivery.timestamp
                    ? `, ${new Date(delivery.timestamp).toLocaleDateString('ru-RU')}`
                    : '';
                return `${delivery.id} (${delivery.courier_name || 'Без курьера'})${date}`;
            },
            onSelect,
        });
    }

    ensureScanPauseOverlay();
    setQrViewportState('idle');
    syncOverlayStyles();
    window.addEventListener('resize', syncOverlayStyles);

    if (window.ResizeObserver && dom.inputModeButton) {
        const observer = new ResizeObserver(syncOverlayStyles);
        observer.observe(dom.inputModeButton);
    }

    return {
        clearScanResult,
        createConfirmDialog,
        createModal,
        createPrimaryButton,
        createSecondaryButton,
        createSidebarButton,
        flashFrame,
        focusManualInput,
        hideAllQrIcons,
        hideManualInput,
        setLoading,
        setModalContentWidth,
        setQrViewportState,
        setVideoVisible,
        showAllQrIcons,
        showCameraNotice,
        showScanPauseOverlay,
        showManualInput,
        showScanResult,
        showSelectionModal,
        hideScanPauseOverlay,
        showToast,
        showTransferSelectModal,
        syncOverlayStyles,
    };
}
