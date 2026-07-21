importScripts(
  "https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyCTu2ZVzeBVNjdqRJgJp9PLmg3_YnX8Wsw",
  authDomain: "tick-watches-d06c8.firebaseapp.com",
  projectId: "tick-watches-d06c8",
  storageBucket: "tick-watches-d06c8.firebasestorage.app",
  messagingSenderId: "889790975323",
  appId: "1:889790975323:web:82bca801c4b42c4c075e7e",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw] Background message received");

  /*
    الرسالة التي تحتوي على notification يعرضها Firebase
    تلقائيًا في الخلفية. هذا الجزء للرسائل data-only فقط.
  */
  if (payload.notification) {
    return;
  }

  const data = payload.data || {};

  return self.registration.showNotification(
    data.title || "TICK",
    {
      body: data.body || "You have a new order.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.orderId
        ? `tick-order-${data.orderId}`
        : "tick-new-order",
      data: {
        ...data,
        url: data.url || "/admin",
      },
    }
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url =
    event.notification.data?.url || "/admin";

  event.waitUntil(
    clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then((windowClients) => {
        for (const client of windowClients) {
          if ("navigate" in client && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }

        return clients.openWindow(url);
      })
  );
});
