import { renderLanding, attachLandingEvents } from './landing.js';
import { renderAuth, attachAuthEvents, saveUserToDb, renderVerify, attachVerifyEvents } from './auth.js';
import { loadContacts, addContact, removeContact, renderContactsView, attachContactsEvents, loadTalkUsers, renderTalkUsersDirectory, attachDirectoryEvents } from './contacts.js';
import { loadChatList, subscribeToMessages, sendMessage, renderChatView, renderChatListHtml, renderMessagesHtml, attachChatEvents, emailKey, subscribeToTyping, setTypingStatus, editMessage, deleteMessage, markMessagesRead, renderGroupModal, initCrypto } from './chat.js';
import { rtdb, ref, onValue } from './firebase.js';
import { renderGamesView, attachGamesEvents } from './games.js';
import { auth, signOut, onAuthStateChanged, updateProfile, db, doc, setDoc } from './firebase.js';
import { initPushNotifications, subscribeUserToPush, unsubscribeUserFromPush, setCallNotificationHandler, ensureNotificationPermission, getNotificationPermission } from './push.js';
import { initWebSocket, closeWebSocket, startCall, acceptCall, rejectCall, cancelCall, endCall, setOnIncomingCall, setOnCallEnded, toggleMute, toggleCamera, getCallState, initIncomingCallFromPush } from './call.js';

let currentUser = null;
let activeView = 'contacts';
let deviceMode = 'desktop';
let contacts = [];
let chatList = [];
let activeChat = null;
let chatMessages = [];
let chatUnsub = null;
let inboxUnsub = null;
let typingUnsub = null;
let isPeerTyping = false;

const app = document.getElementById('app');

function avatarDisplay(user) {
  return user.emoji || (user.name || user.email || '?')[0]?.toUpperCase() || '?';
}

function showLanding() {
  app.innerHTML = renderLanding();
  attachLandingEvents(showAuth);
}

function showAuth() {
  app.innerHTML = renderAuth();
  attachAuthEvents(enterApp, (email, pendingSignup) => {
    suppressAuthChange = true;
    showVerifyScreen(email, pendingSignup);
  });
}

function showVerifyScreen(email, pendingSignup) {
  app.innerHTML = renderVerify(email);
  attachVerifyEvents(email, pendingSignup, (userData) => {
    suppressAuthChange = false;
    enterApp(userData);
  });
}

function showDeviceSelect() {
  app.innerHTML = `
  <div class="device-select-screen">
    <div class="device-select-card">
      <div class="device-select-logo">Talk</div>
 <h2>What device are you using?</h2>
      <p>This helps us give you the best experience.</p>
      <div class="device-select-options">
        <button class="device-option" data-device="phone">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
          <span>Phone</span>
        </button>
        <button class="device-option" data-device="tablet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="14" x2="20" y2="14"/></svg>
          <span>Tablet</span>
        </button>
        <button class="device-option" data-device="desktop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="18" x2="12" y2="21"/></svg>
          <span>Computer</span>
        </button>
      </div>
    </div>
  </div>`;
  document.querySelectorAll('.device-option').forEach(btn => {
    btn.addEventListener('click', () => {
      deviceMode = btn.dataset.device;
      localStorage.setItem('talk_device', deviceMode);
      renderShell();
      switchView('contacts');
    });
  });
}

function enterApp(user) {
  currentUser = user;
  setCallNotificationHandler(handleCallNotification);
  initWebSocket(user.email);
  setOnIncomingCall(showIncomingCallDialog);
  setOnCallEnded(handleCallEnded);
  initPushNotifications().then(() => {
    if (getNotificationPermission() === 'granted') {
      subscribeUserToPush(user.email);
    } else {
      showNotificationPrompt();
    }
  });
  initCrypto().catch(() => {});
  const saved = localStorage.getItem('talk_device');
  if (saved) {
    deviceMode = saved;
    renderShell();
    switchView('contacts');
  } else {
    showDeviceSelect();
  }
}

function renderShell() {
  const initial = avatarDisplay(currentUser);
  const isPhone = deviceMode === 'phone';
  const navItems = `
    <button class="app-nav-item ${activeView === 'contacts' ? 'active' : ''}" data-view="contacts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <span>Contacts</span>
    </button>
    <button class="app-nav-item ${activeView === 'chat' ? 'active' : ''}" data-view="chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Chat</span>
    </button>
    <button class="app-nav-item ${activeView === 'games' ? 'active' : ''}" data-view="games">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/></svg>
      <span>Games</span>
    </button>`;

  if (isPhone) {
    app.innerHTML = `
    <div class="app-shell phone-mode">
      <div class="app-main">
        <div class="app-main-header">
          <h2 id="main-title">Contacts</h2>
          <button class="app-user-avatar clickable" id="profile-btn">${initial}</button>
        </div>
        <div class="app-main-content" id="main-content"></div>
      </div>
      <nav class="app-bottom-nav">${navItems}</nav>
    </div>`;
  } else {
    app.innerHTML = `
    <div class="app-shell">
      <div class="app-sidebar">
        <div class="app-sidebar-header">
          <div class="app-sidebar-logo">Talk</div>
        </div>
        <nav class="app-nav">${navItems}</nav>
        <div class="app-sidebar-footer">
          <div class="app-user-avatar clickable" id="profile-btn">${initial}</div>
          <div class="app-user-info">
            <div class="app-user-name">${currentUser.name || currentUser.email}</div>
            <div class="app-user-email">${currentUser.email}</div>
          </div>
          <button class="app-logout-btn" id="logout-btn" title="Sign out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>
      <div class="app-main">
        <div class="app-main-header">
          <h2 id="main-title">Contacts</h2>
        </div>
        <div class="app-main-content" id="main-content"></div>
      </div>
    </div>`;
  }

  document.querySelectorAll('.app-nav-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  document.getElementById('profile-btn').addEventListener('click', openProfileModal);
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (chatUnsub) { chatUnsub(); chatUnsub = null; }
      if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
      if (currentUser) await unsubscribeUserFromPush(currentUser.email);
      await signOut(auth);
      currentUser = null;
      location.reload();
    });
  }
}

const EMOJI_CHOICES = [
  '😀','😎','🤩','😇','🤓','😜','🥳','😴','🤯','🥶',
  '🐱','🐶','🦊','🐼','🐨','🦁','🐸','🐵','🐙','🦄',
  '🌸','🌟','🔥','⚡','🌈','💎','🎯','🎮','🍕','🍔',
  '⚽','🏀','🚀','✈️','🎸','🎨','📚','☕','🍿','🧊'
];

function openProfileModal() {
  const existing = document.getElementById('profile-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'profile-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card profile-modal-card">
      <div class="profile-modal-header">
        <h3>Edit Profile</h3>
        <button class="profile-modal-close" id="profile-close">&times;</button>
      </div>
      <div class="profile-modal-body">
        <div class="profile-avatar-preview" id="avatar-preview">${avatarDisplay(currentUser)}</div>
        <div class="profile-section-label">Choose an emoji</div>
        <div class="emoji-grid" id="emoji-grid">
          ${EMOJI_CHOICES.map(e => `<button class="emoji-choice ${currentUser.emoji === e ? 'selected' : ''}" data-emoji="${e}">${e}</button>`).join('')}
        </div>
        <div class="profile-section-label" style="margin-top:16px;">Your name</div>
        <input type="text" class="profile-name-input" id="profile-name-input" value="${currentUser.name || ''}" placeholder="Your name" maxlength="30" />
      </div>
      <div class="profile-modal-footer">
        <button class="profile-modal-cancel" id="profile-cancel">Cancel</button>
        <button class="profile-modal-save" id="profile-save">Save</button>
      </div>
      <div class="profile-modal-danger">
        <button class="profile-modal-delete" id="profile-delete">Delete My Account</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  let selectedEmoji = currentUser.emoji || '';

  const preview = document.getElementById('avatar-preview');
  const nameInput = document.getElementById('profile-name-input');

  document.querySelectorAll('.emoji-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedEmoji = btn.dataset.emoji;
      preview.textContent = selectedEmoji;
      document.querySelectorAll('.emoji-choice').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  const close = () => modal.remove();
  document.getElementById('profile-close').addEventListener('click', close);
  document.getElementById('profile-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  document.getElementById('profile-delete').addEventListener('click', async () => {
    const confirmed = confirm('Are you sure you want to permanently delete your account? This cannot be undone.');
    if (!confirmed) return;
    const doubleConfirmed = confirm('This will permanently erase all your data, contacts, and messages. Type DELETE to continue?');
    if (!doubleConfirmed) return;
    try {
      const res = await fetch('/api/users/' + encodeURIComponent(currentUser.email) + '/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error('Failed to delete account');
      try { await signOut(auth); } catch {}
      try { await unsubscribeUserFromPush(currentUser.email); } catch {}
      location.reload();
    } catch (err) {
      alert('Failed to delete account: ' + err.message);
    }
  });

  document.getElementById('profile-save').addEventListener('click', async () => {
    const name = nameInput.value.trim() || currentUser.email.split('@')[0];
    const saveBtn = document.getElementById('profile-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await saveProfile(name, selectedEmoji);
      close();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      alert('Failed to save profile: ' + err.message);
    }
  });
}

async function saveProfile(name, emoji) {
  const user = auth.currentUser;
  if (user) {
    await updateProfile(user, { displayName: name });
  }
  const updates = { name, emoji: emoji || null };
  await setDoc(doc(db, 'users', currentUser.uid), updates, { merge: true });
  currentUser.name = name;
  currentUser.emoji = emoji || null;
  renderShell();
  switchView(activeView);
}

async function switchView(view) {
  activeView = view;
  document.querySelectorAll('.app-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });
  const title = document.getElementById('main-title');
  const content = document.getElementById('main-content');

  if (view === 'contacts') {
    title.textContent = 'Contacts';
    content.innerHTML = `
    <div class="contacts-toolbar">
      <div class="contacts-tabs">
        <button class="contacts-tab active" data-tab="my">My Contacts</button>
        <button class="contacts-tab" data-tab="dir">Talk Users</button>
      </div>
      <input type="text" class="contacts-search" id="contacts-search" placeholder="Search..." />
    </div>
    <div id="contacts-list"></div>`;
    await refreshContacts();
    const searchEl = document.getElementById('contacts-search');
    if (searchEl) {
      searchEl.addEventListener('input', (e) => {
        filterContacts(e.target.value);
      });
    }
    document.querySelectorAll('.contacts-tab').forEach(tab => {
      tab.addEventListener('click', () => switchContactsTab(tab.dataset.tab));
    });
  } else if (view === 'chat') {
    title.textContent = 'Chat';
    chatRendered = false;
    try {
      chatList = await loadChatList(currentUser, contacts);
    } catch {
      chatList = [];
    }
    renderChat();
    subscribeToInbox();
  } else if (view === 'games') {
    title.textContent = 'Games';
    content.innerHTML = renderGamesView();
    attachGamesEvents();
  }
}

async function refreshContacts() {
  try {
    contacts = await loadContacts(currentUser);
  } catch {}
  try {
    await refreshTalkUsers();
  } catch {}
  renderContactsList();
}

let contactsTab = 'my';
let talkUsers = [];

function switchContactsTab(tab) {
  contactsTab = tab;
  document.querySelectorAll('.contacts-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderContactsList(document.getElementById('contacts-search')?.value || '');
}

async function refreshTalkUsers() {
  talkUsers = await loadTalkUsers(currentUser);
}

function renderContactsList(filter = '') {
  const list = document.getElementById('contacts-list');
  if (!list) return;
  const q = filter.toLowerCase();

  if (contactsTab === 'dir') {
    const filtered = q
      ? talkUsers.filter(u => (u.name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      : talkUsers;
    const existingEmails = contacts.map(c => c.email);
    list.innerHTML = renderTalkUsersDirectory(filtered, existingEmails);
    attachDirectoryEvents(handleAddFromDirectory);
  } else {
    const filtered = q
      ? contacts.filter(c => (c.name || c.email).toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      : contacts;
    list.innerHTML = renderContactsView(filtered, startChatFromContact, handleRemoveContact);
    attachContactsEvents(startChatFromContact, handleRemoveContact);
  }
}

function filterContacts(q) {
  renderContactsList(q);
}

async function handleAddFromDirectory(email, name) {
  try {
    await addContact(currentUser, email, name);
    await refreshContacts();
    renderContactsList(document.getElementById('contacts-search')?.value || '');
  } catch (err) {
    alert('Failed to add contact: ' + err.message);
  }
}

async function handleRemoveContact(email) {
  await removeContact(currentUser, email);
  contacts = contacts.filter(c => c.email !== email);
  renderContactsList(document.getElementById('contacts-search')?.value || '');
  if (activeChat?.email === email) {
    activeChat = null;
    chatMessages = [];
  }
}

async function startChatFromContact(email, name) {
  await switchView('chat');
  handleSelectChat(email, name);
}

function backToChatList() {
  activeChat = null;
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  if (typingUnsub) { typingUnsub(); typingUnsub = null; }
  isPeerTyping = false;
  chatMessages = [];
  renderChat();
}

let chatRendered = false;

function renderChat() {
  const content = document.getElementById('main-content');
  content.innerHTML = renderChatView(chatList, activeChat, chatMessages, currentUser, deviceMode, { isTyping: isPeerTyping });
  attachChatEvents({
    onSelectChat: handleSelectChat,
    onSendMessage: handleSendMessage,
    onBack: backToChatList,
    onTyping: handleTyping,
    onEditMessage: handleEditMessage,
    onDeleteMessage: handleDeleteMessage,
    onCall: handleCall,
    onCreateGroup: openGroupModal
  });
  chatRendered = true;
  scrollChatToBottom();
}

function updateChatList() {
  if (!chatRendered) return;
  const sidebar = document.querySelector('.chat-sidebar');
  if (!sidebar) return;
  const searchInput = document.getElementById('chat-search');
  const searchVal = searchInput ? searchInput.value : '';
  sidebar.outerHTML = renderChatListHtml(chatList, activeChat?.email);
  const newSearch = document.getElementById('chat-search');
  if (newSearch && searchVal) newSearch.value = searchVal;
  document.querySelectorAll('.chat-list-item').forEach(item => {
    item.addEventListener('click', () => {
      handleSelectChat(item.dataset.email, item.dataset.name);
    });
  });
  if (newSearch) {
    newSearch.addEventListener('input', () => {
      const q = newSearch.value.toLowerCase();
      document.querySelectorAll('.chat-list-item').forEach(item => {
        const name = item.dataset.name.toLowerCase();
        const email = item.dataset.email.toLowerCase();
        item.style.display = (name.includes(q) || email.includes(q)) ? '' : 'none';
      });
    });
  }
}

function updateMessages() {
  if (!chatRendered || !activeChat) return;
  const msgContainer = document.getElementById('chat-messages');
  if (!msgContainer) return;
  const wasNearBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 100;
  msgContainer.innerHTML = renderMessagesHtml(chatMessages, currentUser);
  if (wasNearBottom) scrollChatToBottom();
  document.querySelectorAll('.chat-msg-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgId;
      if (action === 'edit') {
        handleEditMessage(msgId, btn.dataset.text || '');
      } else if (action === 'delete') {
        handleDeleteMessage(msgId);
      }
    });
  });
}

function updateTypingIndicator() {
  if (!chatRendered || !activeChat) return;
  const indicator = document.getElementById('chat-typing-indicator');
  const status = document.getElementById('chat-header-status');
  if (indicator) indicator.style.display = isPeerTyping ? 'flex' : 'none';
  if (status) {
    status.classList.toggle('typing', isPeerTyping);
    status.textContent = isPeerTyping ? 'typing...' : '';
  }
}

function subscribeToInbox() {
  if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; }
  const inboxRef = ref(rtdb, `userChats/${emailKey(currentUser.email)}`);
  inboxUnsub = onValue(inboxRef, (snap) => {
    const chats = [];
    snap.forEach((child) => {
      const val = child.val();
      if (val && val.email) {
        const contact = contacts.find(c => c.email === val.email);
        chats.push({
          email: val.email,
          name: contact?.name || val.name || val.email,
          chatId: child.key,
          lastMessage: val.lastMessage || '',
          lastAt: val.lastAt || 0
        });
      }
    });
    chats.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    chatList = chats;
    updateChatList();
  });
}

function handleSelectChat(email, name) {
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  if (typingUnsub) { typingUnsub(); typingUnsub = null; }
  isPeerTyping = false;
  activeChat = { email, name };
  chatMessages = [];
  chatUnsub = subscribeToMessages(currentUser, email, (msgs) => {
    chatMessages = msgs;
    updateMessages();
    markMessagesRead(currentUser, email);
  });
  typingUnsub = subscribeToTyping(currentUser, email, (isTyping) => {
    isPeerTyping = isTyping;
    updateTypingIndicator();
  });
  renderChat();
}

function handleCallNotification(msg) {
  if (!currentUser || !msg.from) return;
  if (getCallState() === 'idle') {
    const initialized = initIncomingCallFromPush({
      from: msg.from,
      fromName: msg.fromName || msg.from,
      callType: msg.callType || 'audio'
    });
    if (initialized) {
      showIncomingCallDialog({ from: msg.from, fromName: msg.fromName || msg.from, callType: msg.callType || 'audio' });
    }
  }
}

function showNotificationPrompt() {
  const existing = document.getElementById('notif-prompt-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'notif-prompt-banner';
  banner.className = 'notif-banner';
  banner.innerHTML = `
    <div class="notif-banner-content">
      <div class="notif-banner-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </div>
      <div class="notif-banner-text">
        <div class="notif-banner-title">Enable notifications</div>
        <div class="notif-banner-desc">Get notified about incoming calls and messages even when the app is in the background.</div>
      </div>
      <button class="notif-banner-btn" id="notif-enable-btn">Allow</button>
      <button class="notif-banner-dismiss" id="notif-dismiss-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  document.body.appendChild(banner);

  document.getElementById('notif-enable-btn').addEventListener('click', async () => {
    const result = await ensureNotificationPermission();
    if (result === 'granted') {
      await subscribeUserToPush(currentUser.email);
      banner.remove();
    } else if (result === 'denied') {
      banner.querySelector('.notif-banner-desc').textContent = 'Notifications are blocked. You can enable them later in your browser settings.';
      document.getElementById('notif-enable-btn').textContent = 'Close';
      document.getElementById('notif-enable-btn').onclick = () => banner.remove();
    }
  });
  document.getElementById('notif-dismiss-btn').addEventListener('click', () => banner.remove());
}

function showIncomingCallDialog(call) {
  const existing = document.getElementById('incoming-call-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'incoming-call-overlay';
  overlay.className = 'call-overlay';
  overlay.innerHTML = `
    <div class="incoming-call-card">
      <div class="call-avatar">${(call.fromName || call.from)[0]?.toUpperCase() || '?'}</div>
      <div class="call-name">${call.fromName || call.from}</div>
      <div class="call-type-label">Incoming ${call.callType === 'video' ? 'video' : 'audio'} call</div>
      <div class="call-action-buttons">
        <button class="call-btn reject" id="reject-call-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/></svg>
          <span>Decline</span>
        </button>
        <button class="call-btn accept" id="accept-call-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          <span>Accept</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('accept-call-btn').addEventListener('click', () => {
    overlay.remove();
    acceptCall();
    showActiveCallScreen(call.fromName || call.from, call.callType, false);
  });
  document.getElementById('reject-call-btn').addEventListener('click', () => {
    overlay.remove();
    rejectCall();
  });
}

function showActiveCallScreen(name, callType, isCaller) {
  const existing = document.getElementById('active-call-overlay');
  if (existing) existing.remove();

  const isVideo = callType === 'video';
  const overlay = document.createElement('div');
  overlay.id = 'active-call-overlay';
  overlay.className = 'call-overlay active-call-overlay';
  overlay.innerHTML = `
    <div class="active-call-screen">
      <video id="call-remote-video" autoplay playsinline ${isVideo ? '' : 'style="display:none;"'}></video>
      <video id="call-local-video" autoplay playsinline muted ${isVideo ? '' : 'style="display:none;"'}></video>
      <audio id="call-remote-audio" autoplay></audio>
      <audio id="call-local-audio" muted></audio>
      <div class="call-info-overlay">
        <div class="call-avatar large">${(name || '?')[0]?.toUpperCase() || '?'}</div>
        <div class="call-name large">${name}</div>
        <div class="call-status-text" id="call-status-text">${isCaller ? 'Calling...' : 'Connecting...'}</div>
      </div>
      <div class="call-controls">
        <button class="call-control-btn" id="mute-btn" title="Mute">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </button>
        ${isVideo ? `
        <button class="call-control-btn" id="camera-btn" title="Camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>` : ''}
        <button class="call-control-btn end" id="end-call-btn" title="End call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" transform="rotate(135 12 12)"/></svg>
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const statusText = document.getElementById('call-status-text');
  const statusInterval = setInterval(() => {
    if (getCallState() === 'connected') {
      statusText.textContent = 'Connected';
      clearInterval(statusInterval);
    }
  }, 500);

  document.getElementById('end-call-btn').addEventListener('click', () => {
    clearInterval(statusInterval);
    endCall();
    overlay.remove();
  });

  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const muted = toggleMute();
      muteBtn.classList.toggle('active', muted);
    });
  }

  const cameraBtn = document.getElementById('camera-btn');
  if (cameraBtn) {
    cameraBtn.addEventListener('click', () => {
      const off = toggleCamera();
      cameraBtn.classList.toggle('active', off);
    });
  }
}

function handleCallEnded(reason) {
  const incoming = document.getElementById('incoming-call-overlay');
  if (incoming) incoming.remove();
  const active = document.getElementById('active-call-overlay');
  if (active) active.remove();
  if (reason === 'media-error') {
    alert('Call failed: could not access microphone or camera. Please check your browser permissions and try again.');
  }
}

function openGroupModal() {
  const existing = document.getElementById('group-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.innerHTML = renderGroupModal(contacts || []);
  document.body.appendChild(modal.firstElementChild);
  const modalEl = document.getElementById('group-modal');
  const close = () => modalEl.remove();
  document.getElementById('group-close').addEventListener('click', close);
  document.getElementById('group-cancel').addEventListener('click', close);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) close(); });
  document.getElementById('group-create').addEventListener('click', async () => {
    const name = document.getElementById('group-name-input').value.trim();
    if (!name) { alert('Please enter a group name'); return; }
    const checked = document.querySelectorAll('#group-members-list input[type=checkbox]:checked');
    const members = Array.from(checked).map(cb => cb.value);
    if (members.length < 1) { alert('Select at least one member'); return; }
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, members, createdBy: currentUser.email })
      });
      if (!res.ok) throw new Error('Failed to create group');
      close();
      renderChat();
    } catch (err) {
      alert('Failed to create group: ' + err.message);
    }
  });
}

async function handleSendMessage(text) {
  if (!activeChat) return;
  await sendMessage(currentUser, activeChat.email, text);
}

async function handleTyping(isTyping) {
  if (!activeChat) return;
  await setTypingStatus(currentUser, activeChat.email, isTyping);
}

async function handleEditMessage(msgId, oldText) {
  const newText = prompt('Edit message:', oldText);
  if (newText && newText.trim() && newText.trim() !== oldText) {
    await editMessage(currentUser, activeChat.email, msgId, newText.trim());
  }
}

async function handleDeleteMessage(msgId) {
  if (confirm('Delete this message?')) {
    await deleteMessage(currentUser, activeChat.email, msgId);
  }
}

async function handleCall(callType) {
  if (!activeChat) return;
  if (getCallState() !== 'idle') {
    alert('You are already in a call.');
    return;
  }
  const result = await startCall(activeChat.email, callType);
  if (result.success) {
    showActiveCallScreen(activeChat.name || activeChat.email, callType, true);
  } else {
    alert('Call failed: ' + (result.error || 'The recipient may be offline.'));
  }
}

function scrollChatToBottom() {
  const msgs = document.getElementById('chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

let suppressAuthChange = false;

onAuthStateChanged(auth, async (user) => {
  if (suppressAuthChange) return;
  if (user) {
    if (!user.emailVerified) {
      suppressAuthChange = true;
      showVerifyScreen(user.email);
      return;
    }
    const userData = await saveUserToDb(user);
    enterApp(userData);
  } else {
    showLanding();
  }
});
