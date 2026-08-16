import {
  rtdb, ref, push, set, get, rtdbQuery,
  orderByChild, limitToLast, onValue, remove, update, rtdbServerTimestamp
} from './firebase.js';
import { encryptMessage, decryptMessage, encryptPreview, decryptPreview, getOrCreateKeyPair } from './crypto.js';

const MESSAGE_LIMIT = 50;
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

function emailKey(email) {
  return (email || '').toLowerCase().replace(/\./g, ',');
}

function chatId(email1, email2) {
  return [emailKey(email1), emailKey(email2)].sort().join('__');
}

// --- E2EE helpers ---

let myPrivateKey = null;
const publicKeyCache = new Map();

/**
 * Initialize E2EE — called once after login to load the private key.
 */
export async function initCrypto() {
  const keyPair = await getOrCreateKeyPair();
  myPrivateKey = keyPair.privateKey;
  return keyPair;
}

/**
 * Fetch a user's public key from RTDB by their email.
 * Cached after first fetch.
 */
async function getPublicKeyByEmail(email) {
  const lowerEmail = (email || '').toLowerCase();
  if (publicKeyCache.has(lowerEmail)) return publicKeyCache.get(lowerEmail);
  const usersRef = ref(rtdb, 'users');
  const snap = await get(usersRef);
  let pubKey = null;
  if (snap.exists()) {
    snap.forEach((child) => {
      const data = child.val();
      if ((data.email || '').toLowerCase() === lowerEmail) {
        pubKey = data.publicKey || null;
      }
    });
  }
  if (pubKey) publicKeyCache.set(lowerEmail, pubKey);
  return pubKey;
}

/**
 * Decrypt a list of messages in place. Returns a new array with decrypted text.
 */
async function decryptMessages(messages, contactEmail) {
  if (!myPrivateKey) return messages;
  const theirPubKey = await getPublicKeyByEmail(contactEmail);
  if (!theirPubKey) return messages;
  return Promise.all(messages.map(async (m) => {
    if (m.deleted || !m.encrypted) return m;
    try {
      const payload = { ciphertext: m.ciphertext, iv: m.iv };
      const plaintext = await decryptMessage(payload, theirPubKey, myPrivateKey);
      return { ...m, text: plaintext || '[Unable to decrypt]' };
    } catch {
      return { ...m, text: '[Unable to decrypt]' };
    }
  }));
}

export async function loadChatList(user, contacts) {
  const inboxRef = ref(rtdb, `userChats/${emailKey(user.email)}`);
  const snap = await get(inboxRef);
  if (!snap.exists()) return [];
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

  if (myPrivateKey) {
    for (const c of chats) {
      if (c.lastMessage) {
        try {
          const theirPubKey = await getPublicKeyByEmail(c.email);
          if (theirPubKey) {
            c.lastMessage = await decryptPreview(c.lastMessage, theirPubKey, myPrivateKey);
          }
        } catch {}
      }
    }
  }

  return chats;
}

export function subscribeToMessages(user, contactEmail, callback) {
  const cid = chatId(user.email, contactEmail);
  const messagesRef = ref(rtdb, `chats/${cid}/messages`);
  const q = rtdbQuery(messagesRef, orderByChild('createdAt'), limitToLast(MESSAGE_LIMIT));

  return onValue(q, async (snap) => {
    const messages = [];
    snap.forEach((child) => {
      messages.push({ id: child.key, ...child.val() });
    });
    const decrypted = await decryptMessages(messages, contactEmail);
    callback(decrypted);
  });
}

export function subscribeToTyping(user, contactEmail, callback) {
  const cid = chatId(user.email, contactEmail);
  const typingRef = ref(rtdb, `chats/${cid}/typing/${emailKey(contactEmail)}`);
  return onValue(typingRef, (snap) => {
    const val = snap.val();
    if (val && val.isTyping && Date.now() - val.timestamp < 5000) {
      callback(true);
    } else {
      callback(false);
    }
  });
}

export async function setTypingStatus(user, contactEmail, isTyping) {
  const cid = chatId(user.email, contactEmail);
  const typingRef = ref(rtdb, `chats/${cid}/typing/${emailKey(user.email)}`);
  if (isTyping) {
    await set(typingRef, { isTyping: true, timestamp: Date.now() });
  } else {
    await set(typingRef, { isTyping: false, timestamp: Date.now() });
  }
}

export async function sendMessage(user, contactEmail, text) {
  const cid = chatId(user.email, contactEmail);
  const messagesRef = ref(rtdb, `chats/${cid}/messages`);
  const newMsgRef = push(messagesRef);
  const now = Date.now();

  let encryptedPayload = null;
  let previewEncrypted = text || '';
  if (myPrivateKey && text) {
    try {
      const theirPubKey = await getPublicKeyByEmail(contactEmail);
      if (theirPubKey) {
        encryptedPayload = await encryptMessage(text, theirPubKey, myPrivateKey);
        previewEncrypted = await encryptPreview(text, theirPubKey, myPrivateKey);
      }
    } catch {}
  }

  const msgData = {
    text: encryptedPayload ? '' : (text || ''),
    encrypted: !!encryptedPayload,
    ciphertext: encryptedPayload?.ciphertext || null,
    iv: encryptedPayload?.iv || null,
    sender: user.uid,
    senderEmail: user.email,
    createdAt: now,
    id: newMsgRef.key,
    status: 'sent',
    readBy: []
  };
  await set(newMsgRef, msgData);

  const contactName = await getContactName(contactEmail);
  const inboxEntry = {
    email: contactEmail,
    name: contactName || contactEmail,
    lastMessage: previewEncrypted,
    lastAt: now
  };
  const reverseEntry = {
    email: user.email,
    name: user.name || user.email,
    lastMessage: previewEncrypted,
    lastAt: now
  };

  try {
    await update(ref(rtdb, `userChats/${emailKey(user.email)}`), { [cid]: inboxEntry });
    await update(ref(rtdb, `userChats/${emailKey(contactEmail)}`), { [cid]: reverseEntry });
  } catch {}

  enforceMessageLimit(cid);
}

async function enforceMessageLimit(cid) {
  try {
    const messagesRef = ref(rtdb, `chats/${cid}/messages`);
    const snap = await get(messagesRef);
    if (!snap.exists()) return;
    const all = [];
    snap.forEach((child) => { all.push({ id: child.key, createdAt: child.val().createdAt || 0 }); });
    if (all.length <= MESSAGE_LIMIT) return;
    all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const toDelete = all.slice(0, all.length - MESSAGE_LIMIT);
    for (const m of toDelete) {
      try { await remove(ref(rtdb, `chats/${cid}/messages/${m.id}`)); } catch {}
    }
  } catch {}
}

async function getContactName(email) {
  try {
    const userRef = ref(rtdb, 'users');
    const snap = await get(userRef);
    let name = null;
    if (snap.exists()) {
      snap.forEach((child) => {
        const data = child.val();
        if ((data.email || '').toLowerCase() === (email || '').toLowerCase()) {
          name = data.name || email;
        }
      });
    }
    return name;
  } catch {
    return null;
  }
}

export async function editMessage(user, contactEmail, msgId, newText) {
  const cid = chatId(user.email, contactEmail);
  const msgRef = ref(rtdb, `chats/${cid}/messages/${msgId}`);
  const snap = await get(msgRef);
  if (!snap.exists()) return;
  const msg = snap.val();
  if (msg.senderEmail !== user.email) return;

  let encryptedPayload = null;
  if (myPrivateKey && newText) {
    try {
      const theirPubKey = await getPublicKeyByEmail(contactEmail);
      if (theirPubKey) {
        encryptedPayload = await encryptMessage(newText, theirPubKey, myPrivateKey);
      }
    } catch {}
  }

  await update(msgRef, {
    text: encryptedPayload ? '' : newText,
    encrypted: !!encryptedPayload,
    ciphertext: encryptedPayload?.ciphertext || null,
    iv: encryptedPayload?.iv || null,
    edited: true
  });
}

export async function deleteMessage(user, contactEmail, msgId) {
  const cid = chatId(user.email, contactEmail);
  const msgRef = ref(rtdb, `chats/${cid}/messages/${msgId}`);
  const snap = await get(msgRef);
  if (!snap.exists()) return;
  const msg = snap.val();
  if (msg.senderEmail !== user.email) return;
  await update(msgRef, { deleted: true, text: '', ciphertext: null, iv: null, encrypted: false });
}

export async function markMessagesRead(user, contactEmail) {
  const cid = chatId(user.email, contactEmail);
  const messagesRef = ref(rtdb, `chats/${cid}/messages`);
  const snap = await get(messagesRef);
  if (!snap.exists()) return;
  const updates = {};
  snap.forEach((child) => {
    const msg = child.val();
    if (msg.senderEmail !== user.email) {
      const readBy = msg.readBy || [];
      if (!readBy.includes(user.email)) {
        readBy.push(user.email);
        updates[`${child.key}/readBy`] = readBy;
        updates[`${child.key}/status`] = 'read';
      }
    }
  });
  if (Object.keys(updates).length > 0) {
    await update(messagesRef, updates);
  }
}

export async function initiateCall(user, contactEmail, callType) {
  try {
    const response = await fetch('/api/call/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromEmail: user.email,
        fromName: user.name || user.email,
        toEmail: contactEmail,
        callType: callType || 'audio'
      })
    });
    return await response.json();
  } catch (err) {
    console.warn('Call initiation failed:', err);
    return { success: false };
  }
}

export function renderChatListHtml(chatList, activeEmail) {
  let sidebarItems = [...chatList];
  if (activeEmail && !chatList.find(c => c.email === activeEmail)) {
    sidebarItems.unshift({ email: activeEmail, name: activeEmail, lastMessage: '', lastAt: 0 });
  }
  return `
  <div class="chat-sidebar">
    <div class="chat-sidebar-header">
      <div class="chat-sidebar-header-row">
        <h3>Conversations</h3>
        <button class="new-group-btn" id="new-group-btn" title="Create group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        </button>
      </div>
      <input type="text" class="contacts-search" id="chat-search" placeholder="Search..." style="margin-top:8px;" />
    </div>
    <div class="chat-list" id="chat-list">
      ${sidebarItems.length === 0 ? '<div style="padding:24px;text-align:center;color:var(--neutral-400);font-size:14px;">No conversations yet</div>' : ''}
      ${sidebarItems.map(c => {
        const initial = (c.name || c.email)[0].toUpperCase();
        const preview = c.lastMessage ? escapeHtml(c.lastMessage).slice(0, 40) : '';
        return `
        <div class="chat-list-item ${activeEmail === c.email ? 'active' : ''}" data-email="${c.email}" data-name="${c.name || c.email}">
          <div class="chat-list-avatar">${initial}</div>
          <div class="chat-list-info">
            <div class="chat-list-name">${c.name || c.email}</div>
            ${preview ? `<div class="chat-list-preview">${preview}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

export function renderMessagesHtml(messages, user) {
  return renderMessageList(messages, user);
}

export function renderChatView(chatList, activeChat, messages, user, deviceMode, typingStatus) {
  const activeEmail = activeChat?.email;
  const activeName = activeChat?.name || activeEmail || '';
  const activeContact = chatList.find(c => c.email === activeEmail);
  const displayName = activeContact?.name || activeName;
  const isPhone = deviceMode === 'phone';
  const isTyping = typingStatus?.isTyping || false;

  let sidebarItems = [...chatList];
  if (activeEmail && !chatList.find(c => c.email === activeEmail)) {
    sidebarItems.unshift({ email: activeEmail, name: activeName, lastMessage: '', lastAt: 0 });
  }

  const sidebarHtml = `
  <div class="chat-sidebar">
    <div class="chat-sidebar-header">
      <div class="chat-sidebar-header-row">
        <h3>Conversations</h3>
        <button class="new-group-btn" id="new-group-btn" title="Create group">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        </button>
      </div>
      <input type="text" class="contacts-search" id="chat-search" placeholder="Search..." style="margin-top:8px;" />
    </div>
    <div class="chat-list" id="chat-list">
      ${sidebarItems.length === 0 ? '<div style="padding:24px;text-align:center;color:var(--neutral-400);font-size:14px;">No conversations yet</div>' : ''}
      ${sidebarItems.map(c => {
        const initial = (c.name || c.email)[0].toUpperCase();
        const preview = c.lastMessage ? escapeHtml(c.lastMessage).slice(0, 40) : '';
        return `
        <div class="chat-list-item ${activeEmail === c.email ? 'active' : ''}" data-email="${c.email}" data-name="${c.name || c.email}">
          <div class="chat-list-avatar">${initial}</div>
          <div class="chat-list-info">
            <div class="chat-list-name">${c.name || c.email}</div>
            ${preview ? `<div class="chat-list-preview">${preview}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  const backBtn = isPhone ? `
    <button class="chat-back-btn" id="chat-back-btn" title="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>` : '';

  const callButtons = activeEmail ? `
    <div class="chat-call-buttons">
      <button class="chat-call-btn audio-call" id="audio-call-btn" title="Audio call">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
      <button class="chat-call-btn video-call" id="video-call-btn" title="Video call">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
      </button>
    </div>` : '';

  const mainHtml = activeEmail ? `
  <div class="chat-main">
    <div class="chat-header">
      ${backBtn}
      <div class="chat-list-avatar">${(displayName)[0]?.toUpperCase() || '?'}</div>
      <div class="chat-header-info">
        <div class="chat-header-name">${displayName}</div>
        <div class="chat-header-status ${isTyping ? 'typing' : ''}" id="chat-header-status">${isTyping ? 'typing...' : ''}</div>
      </div>
      ${callButtons}
    </div>
    <div class="chat-messages" id="chat-messages">
      ${renderMessageList(messages, user)}
    </div>
    <div class="chat-typing-indicator" id="chat-typing-indicator" style="display:${isTyping ? 'flex' : 'none'};">
      <span></span><span></span><span></span>
    </div>
    <div class="chat-input-bar">
      <button class="chat-emoji-btn" id="chat-emoji-btn" title="Emoji">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <input type="text" class="chat-input" id="chat-input" placeholder="Type a message..." />
      <button class="chat-send-btn" id="chat-send-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div class="chat-emoji-picker" id="chat-emoji-picker" style="display:none;"></div>
  </div>` : `
  <div class="chat-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    <p>Select a conversation to start chatting</p>
  </div>`;

  if (isPhone && activeEmail) {
    return `<div class="chat-layout phone-chat-active">${mainHtml}</div>`;
  }
  return `<div class="chat-layout">${sidebarHtml}${mainHtml}</div>`;
}

function renderMessageList(messages, user) {
  let html = '';
  let lastDate = null;
  for (const m of messages) {
    const dk = dateKey(m.createdAt);
    if (dk !== lastDate) {
      html += `<div class="chat-date-divider"><span>${formatDateDivider(m.createdAt)}</span></div>`;
      lastDate = dk;
    }
    html += renderMessageBubble(m, user);
  }
  return html;
}

function renderMessageBubble(m, user) {
  const sent = m.senderEmail === user.email || m.sender === user.uid;

  if (m.deleted) {
    return `<div class="chat-bubble ${sent ? 'sent' : 'received'} deleted">
      <span class="chat-deleted-text">This message was deleted</span>
      <div class="chat-bubble-time">${formatTime(m.createdAt)}</div>
    </div>`;
  }

  const statusIcon = sent ? renderStatusIcon(m) : '';
  const editedMark = m.edited ? '<span class="chat-edited">edited</span>' : '';
  const escapedText = escapeHtml(m.text);
  return `
    <div class="chat-bubble ${sent ? 'sent' : 'received'}" data-msg-id="${m.id}" data-sender="${m.senderEmail}">
      ${escapedText ? `<span class="chat-bubble-text">${escapedText}</span>` : ''}
      ${editedMark}
      <div class="chat-bubble-meta">
        <span class="chat-bubble-time">${formatTime(m.createdAt)}</span>
        ${statusIcon}
      </div>
      ${sent && !m.deleted ? `
      <div class="chat-msg-actions">
        <button class="chat-msg-action-btn" data-action="edit" data-msg-id="${m.id}" data-text="${escapeHtml(m.text)}" title="Edit">✏️</button>
        <button class="chat-msg-action-btn" data-action="delete" data-msg-id="${m.id}" title="Delete">🗑️</button>
      </div>` : ''}
    </div>`;
}

function renderStatusIcon(m) {
  if (m.deleted) return '';
  if (m.readBy && m.readBy.length > 0) {
    return '<span class="chat-status read" title="Read">✓✓</span>';
  }
  if (m.status === 'delivered') {
    return '<span class="chat-status delivered" title="Delivered">✓✓</span>';
  }
  return '<span class="chat-status sent" title="Sent">✓</span>';
}

function dateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function formatDateDivider(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}


export function renderGroupModal(contacts) {
  return `
  <div class="modal-overlay" id="group-modal">
    <div class="modal-card group-modal-card">
      <div class="group-modal-header">
        <h3>Create Group</h3>
        <button class="profile-modal-close" id="group-close">&times;</button>
      </div>
      <div class="group-modal-body">
        <input type="text" class="group-name-input" id="group-name-input" placeholder="Group name" maxlength="60" />
        <div class="group-members-label">Select members</div>
        <div class="group-members-list" id="group-members-list">
          ${contacts.map(c => `
            <label class="group-member-item">
              <input type="checkbox" value="${c.email}" data-name="${c.name || c.email}" />
              <span class="group-member-avatar">${(c.name || c.email)[0].toUpperCase()}</span>
              <span class="group-member-name">${c.name || c.email}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="group-modal-footer">
        <button class="profile-modal-cancel" id="group-cancel">Cancel</button>
        <button class="profile-modal-save" id="group-create">Create Group</button>
      </div>
    </div>
  </div>`;
}

const EMOJIS = ['😀','😄','😁','😂','🥰','😍','😘','😎','🤔','😅','😉','😇','🤗','🥳','😴','😭','😡','🤯','🥺','😱','👍','👎','👏','🙏','💪','🔥','✨','🎉','❤️','💔','💯','💬','📸','🌟','⭐','🌙','☀️','🌈','🍕','🍔','☕','🍺','🎵','🎮','⚽','🏀','🚗','✈️','🏠','🎁','💎','🔔','📌','✅','❌','⚡','🎯','🏆','💌','🌹'];

export function attachChatEvents(handlers) {
  const { onSelectChat, onSendMessage, onBack, onTyping, onEditMessage, onDeleteMessage, onCall, onCreateGroup } = handlers;

  document.querySelectorAll('.chat-list-item').forEach(item => {
    item.addEventListener('click', () => {
      onSelectChat(item.dataset.email, item.dataset.name);
    });
  });

  const backBtn = document.getElementById('chat-back-btn');
  if (backBtn && onBack) {
    backBtn.addEventListener('click', () => onBack());
  }

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (input && sendBtn) {
    const send = () => {
      const text = input.value.trim();
      if (text) {
        onSendMessage(text);
        input.value = '';
        if (onTyping) onTyping(false);
      }
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    if (onTyping) {
      let typingTimer = null;
      let isCurrentlyTyping = false;
      input.addEventListener('input', () => {
        const hasText = input.value.length > 0;
        if (hasText && !isCurrentlyTyping) {
          isCurrentlyTyping = true;
          onTyping(true);
        }
        clearTimeout(typingTimer);
        if (hasText) {
          typingTimer = setTimeout(() => {
            isCurrentlyTyping = false;
            onTyping(false);
          }, 2500);
        } else {
          isCurrentlyTyping = false;
          onTyping(false);
        }
      });
      input.addEventListener('blur', () => {
        if (isCurrentlyTyping) {
          isCurrentlyTyping = false;
          onTyping(false);
        }
        clearTimeout(typingTimer);
      });
    }
  }

  const search = document.getElementById('chat-search');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('.chat-list-item').forEach(item => {
        const name = item.dataset.name.toLowerCase();
        const email = item.dataset.email.toLowerCase();
        item.style.display = (name.includes(q) || email.includes(q)) ? '' : 'none';
      });
    });
  }

  document.querySelectorAll('.chat-msg-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgId;
      if (action === 'edit' && onEditMessage) {
        const text = btn.dataset.text || '';
        onEditMessage(msgId, text);
      } else if (action === 'delete' && onDeleteMessage) {
        onDeleteMessage(msgId);
      }
    });
  });

  const audioCallBtn = document.getElementById('audio-call-btn');
  if (audioCallBtn && onCall) {
    audioCallBtn.addEventListener('click', () => onCall('audio'));
  }
  const videoCallBtn = document.getElementById('video-call-btn');
  if (videoCallBtn && onCall) {
    videoCallBtn.addEventListener('click', () => onCall('video'));
  }

  const emojiBtn = document.getElementById('chat-emoji-btn');
  const emojiPicker = document.getElementById('chat-emoji-picker');
  if (emojiBtn && emojiPicker && input) {
    emojiPicker.innerHTML = EMOJIS.map(e => `<span class="emoji-item">${e}</span>`).join('');
    emojiBtn.addEventListener('click', () => {
      emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'flex' : 'none';
    });
    emojiPicker.querySelectorAll('.emoji-item').forEach(item => {
      item.addEventListener('click', () => {
        input.value += item.textContent;
        input.focus();
        emojiPicker.style.display = 'none';
      });
    });
  }

  const newGroupBtn = document.getElementById('new-group-btn');
  if (newGroupBtn && onCreateGroup) {
    newGroupBtn.addEventListener('click', () => onCreateGroup());
  }
}

export { chatId, emailKey, renderMessageList };
