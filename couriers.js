function uniqueSortedCourierNames(couriers) {
    return [...new Set(couriers.map((courier) => courier.name).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right, 'ru'),
    );
}

function createArchiveSelect() {
    const select = document.createElement('select');

    Object.assign(select.style, {
        width: '100%',
        marginBottom: '18px',
        fontSize: '13px',
        padding: '7px 0 7px 10px',
        borderRadius: '10px',
        border: 'none',
        background: '#3f51b5',
        color: '#fff',
        fontFamily: 'Inter, sans-serif',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        outline: 'none',
    });

    select.classList.add('archive-courier-select');

    return select;
}

async function renderCourierStatsModal({ courierName, service, ui }) {
    const modal = ui.createModal({
        className: 'courierStatsModalContent',
        maxButtonWidth: 420,
    });

    const title = document.createElement('div');
    title.textContent = courierName;
    Object.assign(title.style, {
        fontSize: '13px',
        fontWeight: '500',
        marginBottom: '18px',
        fontFamily: 'Inter, sans-serif',
    });
    modal.content.appendChild(title);

    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    Object.assign(closeButton.style, {
        position: 'absolute',
        top: '12px',
        right: '18px',
        background: 'none',
        border: 'none',
        color: '#fff',
        fontSize: '22px',
        cursor: 'pointer',
        fontFamily: 'Inter, sans-serif',
    });
    closeButton.addEventListener('click', modal.close);
    modal.content.appendChild(closeButton);

    const [deliveries, scans] = await Promise.all([
        service.getDeliveries(),
        service.getScans(),
    ]);

    const allDeliveries = deliveries
        .filter((delivery) => delivery.courier_name === courierName)
        .map((delivery) => delivery.id);
    const scannedDeliveries = new Set(
        scans
            .filter((scan) => scan.courier_name === courierName)
            .map((scan) => scan.delivery_id),
    );

    const notScanned = allDeliveries.filter((id) => !scannedDeliveries.has(id));
    const scanned = allDeliveries.filter((id) => scannedDeliveries.has(id));

    const list = document.createElement('div');
    Object.assign(list.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxHeight: '55vh',
        overflowY: 'auto',
    });

    [...notScanned, ...scanned].forEach((deliveryId) => {
        const item = document.createElement('div');
        item.textContent = deliveryId;
        Object.assign(item.style, {
            fontSize: '13px',
            transition: 'opacity 0.3s',
            fontFamily: 'Inter, sans-serif',
            opacity: scannedDeliveries.has(deliveryId) ? '0.6' : '1',
        });

        if (scannedDeliveries.has(deliveryId)) {
            item.classList.add('scanned');
        }

        list.appendChild(item);
    });

    modal.content.appendChild(list);
}

async function openCourierSelector({ service, ui }) {
    const couriers = uniqueSortedCourierNames(await service.getCouriers());

    ui.showSelectionModal({
        title: 'Выберите курьера',
        items: couriers,
        getLabel: (courierName) => courierName,
        onSelect: (courierName) => {
            renderCourierStatsModal({
                courierName,
                service,
                ui,
            });
        },
    });
}

export function initializeSidebarAdmin({ dom, service, ui }) {
    if (!dom.sidebarMenuNav) {
        return {
            processButton: null,
            archiveButton: null,
        };
    }

    const processButton = ui.createSidebarButton({
        id: 'processScanButton',
        label: 'Курьеры',
        fontSize: '13px',
        marginTop: '1px',
    });
    const archiveButton = ui.createSidebarButton({
        id: 'archiveButton',
        fontSize: '15px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 'auto',
        marginBottom: '8px',
        html: `<span style="display:flex;align-items:center;width:20px;justify-content:flex-start;"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="7" width="10" height="9" rx="2" stroke="#fff" stroke-width="1.5"/><path d="M3 7h14" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><rect x="8" y="3" width="4" height="2" rx="1" stroke="#fff" stroke-width="1.5"/><path d="M7 7V5a2 2 0 012-2h2a2 2 0 012 2v2" stroke="#fff" stroke-width="1.5"/></svg></span><span style="flex:1;text-align:left;padding-left:12px;">Удаление данных</span>`,
    });

    dom.sidebarMenuNav.appendChild(processButton);
    dom.sidebarMenuNav.appendChild(archiveButton);

    processButton.addEventListener('click', async () => {
        await openCourierSelector({ service, ui });
    });

    archiveButton.addEventListener('click', async () => {
        const archiveModal = ui.createModal({
            className: 'archive-modal-content',
            maxButtonWidth: 420,
        });

        const title = document.createElement('div');
        title.textContent = 'Удаление данных';
        Object.assign(title.style, {
            fontSize: '13px',
            fontWeight: '500',
            marginBottom: '18px',
            fontFamily: 'Inter, sans-serif',
        });
        archiveModal.content.appendChild(title);

        const courierSelect = createArchiveSelect();
        archiveModal.content.appendChild(courierSelect);

        async function reloadCourierOptions() {
            courierSelect.innerHTML = '';

            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Выберите курьера';
            courierSelect.appendChild(defaultOption);

            const courierNames = uniqueSortedCourierNames(await service.getCouriers());

            courierNames.forEach((courierName) => {
                const option = document.createElement('option');
                option.value = courierName;
                option.textContent = courierName;
                courierSelect.appendChild(option);
            });

            const allOption = document.createElement('option');
            allOption.value = '__all__';
            allOption.textContent = 'Все';
            courierSelect.appendChild(allOption);
        }

        await reloadCourierOptions();

        const deleteCourierButton = ui.createPrimaryButton('Удалить курьера', {
            className: 'archive-delete-courier-btn',
        });
        const deleteCourierDeliveriesButton = ui.createPrimaryButton(
            'Удалить передачи у курьера',
            {
                className: 'archive-delete-btn',
            },
        );
        const deleteAllDeliveriesButton = ui.createPrimaryButton(
            'Удалить все передачи',
            {
                className: 'archive-delete-all-btn',
            },
        );

        archiveModal.content.appendChild(deleteCourierButton);
        archiveModal.content.appendChild(deleteCourierDeliveriesButton);
        archiveModal.content.appendChild(deleteAllDeliveriesButton);

        deleteCourierButton.addEventListener('click', async () => {
            const selectedCourier = courierSelect.value;

            if (!selectedCourier) {
                ui.showScanResult('error', 'Выберите курьера для удаления');
                return;
            }

            if (selectedCourier === '__all__') {
                const confirmDialog = ui.createConfirmDialog({
                    html: `Вы действительно хотите удалить <b style="font-size:16px;">всех курьеров</b>?`,
                    confirmText: 'Удалить всех курьеров',
                });

                confirmDialog.confirmButton.addEventListener('click', async () => {
                    confirmDialog.confirmButton.disabled = true;
                    confirmDialog.confirmButton.textContent = 'Удаление...';

                    await service.deleteAllDailyData();

                    confirmDialog.confirmButton.textContent = 'Готово!';
                    window.setTimeout(async () => {
                        confirmDialog.close();
                        await reloadCourierOptions();
                        ui.showToast('Все данные удалены!');
                    }, 1200);
                });

                return;
            }

            const confirmDialog = ui.createConfirmDialog({
                html: `Вы действительно хотите удалить курьера <b style="font-size:16px;">${selectedCourier}</b>?`,
                confirmText: 'Удалить курьера',
            });

            confirmDialog.confirmButton.addEventListener('click', async () => {
                confirmDialog.confirmButton.disabled = true;
                confirmDialog.confirmButton.textContent = 'Удаление...';

                await service.deleteCourierCascade(selectedCourier);

                confirmDialog.confirmButton.textContent = 'Готово!';
                window.setTimeout(async () => {
                    confirmDialog.close();
                    await reloadCourierOptions();
                    ui.showToast(`Курьер "${selectedCourier}" удален!`);
                }, 1200);
            });
        });

        deleteCourierDeliveriesButton.addEventListener('click', async () => {
            const selectedCourier = courierSelect.value;

            if (!selectedCourier || selectedCourier === '__all__') {
                ui.showScanResult('error', 'Выберите курьера для удаления передач');
                return;
            }

            const confirmDialog = ui.createConfirmDialog({
                html: `Вы действительно хотите удалить все передачи у <b style="font-size:16px;">${selectedCourier}</b>?`,
                confirmText: 'Удалить передачи',
            });

            confirmDialog.confirmButton.addEventListener('click', async () => {
                confirmDialog.confirmButton.disabled = true;
                confirmDialog.confirmButton.textContent = 'Удаление...';

                await service.deleteDeliveriesAndRelatedScansByCourier(
                    selectedCourier,
                );

                confirmDialog.confirmButton.textContent = 'Готово!';
                window.setTimeout(() => {
                    confirmDialog.close();
                    ui.showToast(`Передачи курьера "${selectedCourier}" удалены!`);
                }, 1200);
            });
        });

        deleteAllDeliveriesButton.addEventListener('click', async () => {
            const confirmed = window.confirm(
                'Удалить все передачи и сканы для всех курьеров?',
            );

            if (!confirmed) {
                return;
            }

            await service.deleteAllDeliveriesAndScans();
            ui.showToast('Все передачи удалены!');
        });
    });

    return {
        archiveButton,
        processButton,
    };
}
