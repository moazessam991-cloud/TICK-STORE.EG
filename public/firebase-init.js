import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getMessaging,
  isSupported,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyCTu2ZVzeBVNjdqRJgJp9PLmg3_YnX8Wsw",
  authDomain: "tick-watches-d06c8.firebaseapp.com",
  projectId: "tick-watches-d06c8",
  storageBucket: "tick-watches-d06c8.firebasestorage.app",
  messagingSenderId: "889790975323",
  appId: "1:889790975323:web:82bca801c4b42c4c075e7e",
};

const app = initializeApp(firebaseConfig);

let messaging = null;

if (await isSupported()) {
  messaging = getMessaging(app);
}

export {
  app,
  messaging,
  getToken,
  onMessage,
};