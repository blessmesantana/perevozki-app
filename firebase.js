import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// Конфигурация Firebase
const firebaseConfig = {
    apiKey: "AIzaSyB5n7xxHc45VINsoVKkTcXUuUm4TsMk8bg",
    authDomain: "perevozki-88c5b.firebaseapp.com",
    projectId: "perevozki-88c5b",
    storageBucket: "perevozki-88c5b.firebasestorage.app",
    messagingSenderId: "962120908044",
    appId: "1:962120908044:web:bd5a49937daf33d825dd29"
};

// Инициализация Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };
