const APP_URL = '/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Talk', body: event.data.text() }; }

  const title = data.title || 'Talk';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'talk',
    renotify: true,
    requireInteraction: data.type === 'call-invite',
    data: data,
    actions: data.type === 'call-invite' ? [
      { action: 'accept', title: 'Accept' },
      { action: 'decline', title: 'Decline' }
    ] : undefined,
    vibrate: data.type === 'call-invite' ? [200, 100, 200, 100, 200, 100, 200] : [100]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  if (event.action === 'decline') {
    event.waitUntil(self.clients.openWindow(APP_URL + '?decline=' + encodeURIComponent(data.from || '')));
    return;
  }

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if (client.url.includes(APP_URL) && 'focus' in client) {
        client.postMessage({ type: 'call-notification', action: event.action || 'open', from: data.from, callType: data.callType });
        return client.focus();
      }
    }
    const url = data.type === 'call-invite'
      ? APP_URL + '?call=' + encodeURIComponent(data.from || '') + '&type=' + encodeURIComponent(data.callType || 'audio')
      : APP_URL;
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
