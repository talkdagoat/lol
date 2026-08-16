const VAPID_URL = '/api/push/vapid-public';
const SW_URL = '/sw.js';

let registration = null;
let onCallNotification = null;

export function setCallNotificationHandler(cb) { onCallNotification = cb; }

export async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
    await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return true;
  } catch (err) {
    console.warn('SW registration failed:', err);
    return false;
  }
}

export function getNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function ensureNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return 'denied';
  }
}

function handleMessage(event) {
  const msg = event.data || {};
  if (msg.type === 'call-notification' && onCallNotification) onCallNotification(msg);
}

export async function subscribeUserToPush(email) {
  if (!registration) {
    const ok = await initPushNotifications();
    if (!ok) return null;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return null;

    const res = await fetch(VAPID_URL);
    const { publicKey } = await res.json();

    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, subscription: sub })
    });
    return sub;
  } catch (err) {
    console.warn('Push subscribe failed:', err);
    return null;
  }
}

export async function unsubscribeUserFromPush(email) {
  if (!registration) return;
  try {
    const sub = await registration.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, endpoint: sub.endpoint })
      });
      await sub.unsubscribe();
    }
  } catch (err) {
    console.warn('Push unsubscribe failed:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}
