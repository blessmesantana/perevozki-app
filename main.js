const firebaseConfig = {
  apiKey: "ТВОЙ_КЛЮЧ",
  authDomain: "ТВОЙ_ПРОЕКТ.firebaseapp.com",
  projectId: "ТВОЙ_ПРОЕКТ",
};

const app = firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

window.uploadCodes = async function () {
  const text = document.getElementById('codes').value.trim();
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

  for (const code of lines) {
    await db.collection('shipments').doc(code).set({
      code: code,
      isScanned: false,
      scannedAt: null,
    });
  }

  alert("Готово! Загружено " + lines.length + " передач.");
}
