import { db, rtdb, collection, doc, setDoc, getDocs, deleteDoc, getDoc, ref, get as rtdbGet } from './firebase.js';

export async function loadContacts(user) {
  const contactsRef = collection(db, 'users', user.uid, 'contacts');
  const snap = await getDocs(contactsRef);
  return snap.docs.map(d => d.data());
}

export async function addContact(user, contactEmail, contactName) {
  const lowerEmail = contactEmail.toLowerCase();
  if (lowerEmail === (user.email || '').toLowerCase()) {
    throw new Error("You can't add yourself as a contact");
  }

  const usersRef = ref(rtdb, 'users');
  const snap = await rtdbGet(usersRef);
  let found = null;
  if (snap.exists()) {
    snap.forEach((child) => {
      const data = child.val();
      if ((data.email || '').toLowerCase() === lowerEmail) {
        found = data;
      }
    });
  }

  if (!found) {
    throw new Error('No Talk user found with that email. They need to sign up first.');
  }

  const contactRef = doc(db, 'users', user.uid, 'contacts', lowerEmail);
  await setDoc(contactRef, {
    email: lowerEmail,
    name: contactName || found.name || lowerEmail.split('@')[0],
    avatar: found.photoURL || null,
    addedAt: new Date().toISOString()
  }, { merge: true });
}

export async function removeContact(user, contactEmail) {
  const contactRef = doc(db, 'users', user.uid, 'contacts', contactEmail.toLowerCase());
  await deleteDoc(contactRef);
}

export async function loadTalkUsers(user) {
  const usersRef = ref(rtdb, 'users');
  const snap = await rtdbGet(usersRef);
  const users = [];
  if (snap.exists()) {
    snap.forEach((child) => {
      const data = child.val();
      const email = (data.email || '').toLowerCase();
      if (email && email !== (user.email || '').toLowerCase()) {
        users.push({
          email,
          name: data.name || email.split('@')[0],
          avatar: data.photoURL || null
        });
      }
    });
  }
  return users.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function renderContactsView(contacts, onMessage, onRemove) {
  if (contacts.length === 0) {
    return `
    <div class="contacts-empty">
      <h3>No contacts yet</h3>
      <p>Add people from the Talk user directory to start chatting.</p>
    </div>`;
  }

  return `
  <div class="contacts-grid">
    ${contacts.map(c => {
      const initial = (c.name || c.email)[0].toUpperCase();
      return `
      <div class="contact-card">
        <div class="contact-avatar">${initial}</div>
        <div class="contact-info">
          <div class="contact-name">${c.name || c.email}</div>
          <div class="contact-email">${c.email}</div>
        </div>
        <div class="contact-actions">
          <button class="contact-action-btn message" data-email="${c.email}" data-name="${c.name || c.email}" title="Message">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <button class="contact-action-btn remove" data-email="${c.email}" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

export function renderTalkUsersDirectory(users, existingEmails) {
  if (users.length === 0) {
    return `
    <div class="contacts-empty">
      <h3>No other Talk users yet</h3>
      <p>When others sign up for Talk, they'll appear here.</p>
    </div>`;
  }

  return `
  <div class="contacts-grid">
    ${users.map(u => {
      const initial = (u.name || u.email)[0].toUpperCase();
      const isContact = existingEmails.includes(u.email);
      return `
      <div class="contact-card">
        <div class="contact-avatar">${initial}</div>
        <div class="contact-info">
          <div class="contact-name">${u.name || u.email}</div>
          <div class="contact-email">${u.email}</div>
        </div>
        <div class="contact-actions">
          ${isContact
            ? '<span style="font-size:13px;color:var(--neutral-400);padding:8px 12px;">Already added</span>'
            : `<button class="contact-action-btn add" data-email="${u.email}" data-name="${u.name || u.email}" title="Add contact">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>`}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

export function attachContactsEvents(onMessage, onRemove) {
  document.querySelectorAll('.contact-action-btn.message').forEach(btn => {
    btn.addEventListener('click', () => {
      onMessage(btn.dataset.email, btn.dataset.name);
    });
  });
  document.querySelectorAll('.contact-action-btn.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      onRemove(btn.dataset.email);
    });
  });
}

export function attachDirectoryEvents(onAdd) {
  document.querySelectorAll('.contact-action-btn.add').forEach(btn => {
    btn.addEventListener('click', () => {
      onAdd(btn.dataset.email, btn.dataset.name);
    });
  });
}
