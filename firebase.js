// firebase.js

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// Твоя конфигурация Firebase (берётся из Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyB5n7xxHc45VINsoVKkTcXUuUm4TsMk8bg",
  authDomain: "perevozki-88c5b.firebaseapp.com",
  projectId: "perevozki-88c5b",
  storageBucket: "perevozki-88c5b.firebasestorage.app",
  messagingSenderId: "962120908044",
  appId: "1:962120908044:web:bd5a49937daf33d825dd29"
};

// Инициализируем Firebase
const app = initializeApp(firebaseConfig);

// Инициализируем Firestore
const db = getFirestore(app);

// Экспортируем db для использования в main.js
export { db };
