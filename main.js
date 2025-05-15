document.addEventListener("DOMContentLoaded", function () {
    const qrIcon = document.querySelector('.qr-icon');
    const videoElement = document.getElementById('qr-video');
    let stream = null;
    let codeReader = null;

    // Показываем иконку при загрузке страницы
    qrIcon.style.display = 'block';

    async function startQrScanner() {
        try {
            // Получаем поток видео с камеры
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "environment" }
            });
            videoElement.srcObject = stream;
            await videoElement.play();

            // Скрываем иконку только после успешного запуска камеры
            qrIcon.style.display = 'none';

            if (!codeReader) {
                codeReader = new ZXing.BrowserMultiFormatReader();
            }

            codeReader.decodeFromVideoDevice(undefined, 'qr-video', (result, err) => {
                if (result) {
                    console.log('QR код распознан:', result.getText());
                    stopQrScanner();
                }
                if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error('Ошибка сканирования:', err);
                }
            });
        } catch (err) {
            console.error('Ошибка камеры:', err);
            qrIcon.style.display = 'block'; // Показываем иконку при ошибке
        }
    }

    function stopQrScanner() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
            videoElement.srcObject = null;
        }
        if (codeReader) codeReader.reset();
        qrIcon.style.display = 'block'; // Показываем иконку при остановке
    }

    // Пример привязки к кнопке
    document.getElementById('scan-button').addEventListener('click', startQrScanner);
});
