const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { WebSocketServer } = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { promisify } = require('util');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ---------- Firebase Admin SDK (for email verification updates) ----------
const admin = require('firebase-admin');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'src', 'talkapp55-firebase-adminsdk-fbsvc-44c0ccdcaa.json');
let adminAuth = null;
try {
  if (fsSync.existsSync(SERVICE_ACCOUNT_PATH)) {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.cert(serviceAccount),
      projectId: serviceAccount.project_id,
      databaseURL: 'https://talkapp55-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
    adminAuth = getAdminAuth();
  }
} catch (err) {
  console.warn('Firebase Admin SDK not initialized:', err.message);
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BOGXp8jvbyBgFGZID7pLXjeQS6_RSDreXHxqDR1p8vfSDpWfQdSOnz58ebQEk11Dg1DmIlbTtf22ZRXocv1NdvY';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'hn2dxeOoHeHuC2-0EfKspalSnfYbWd5b4SdaClAiqBk';
const VAPID_SUBJECT = 'mailto:talkapp@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const PUSH_SUBS_FILE = path.join(__dirname, 'pushSubs.json');

async function readPushSubs() {
  try {
    const raw = await fs.readFile(PUSH_SUBS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function writePushSubs(subs) {
  await fs.writeFile(PUSH_SUBS_FILE, JSON.stringify(subs, null, 2));
}

async function sendPushToUser(email, payload) {
  const subs = await readPushSubs();
  const userSubs = subs[email] || [];
  const payloadStr = JSON.stringify(payload);
  const failed = [];
  for (const sub of userSubs) {
    try { await webpush.sendNotification(sub, payloadStr); }
    catch (err) { if (err.statusCode === 410 || err.statusCode === 404) failed.push(sub); }
  }
  if (failed.length) {
    subs[email] = userSubs.filter(s => !failed.includes(s));
    await writePushSubs(subs);
  }
}

const SMTP_EMAIL = process.env.SMTP_EMAIL || 'robogod50@gmail.com';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5000';

const emailTransporter = SMTP_PASSWORD
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_EMAIL, pass: SMTP_PASSWORD }
    })
    : null;

const emailVerifyTokens = new Map();

async function sendVerificationEmail(toEmail, displayName) {
    if (!emailTransporter) {
        console.warn('SMTP not configured — skipping verification email to', toEmail);
        return { success: false, error: 'Email service not configured' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    emailVerifyTokens.set(toEmail.toLowerCase(), { token, expires: Date.now() + 86400000 });
    const verifyUrl = `${APP_BASE_URL}/api/verify-email?email=${encodeURIComponent(toEmail)}&token=${token}`;
    const mailOptions = {
        from: `"Talk App" <${SMTP_EMAIL}>`,
        to: toEmail,
        subject: 'Verify your Talk account',
        html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
                <h2 style="color:#1a73e8;">Welcome to Talk${displayName ? ', ' + displayName : ''}!</h2>
                <p>Please verify your email address to complete your registration.</p>
                <a href="${verifyUrl}" style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:16px;margin:16px 0;">Verify Email</a>
                <p style="color:#666;font-size:13px;">Or copy this link: ${verifyUrl}</p>
                <p style="color:#999;font-size:12px;">This link expires in 24 hours.</p>
            </div>`
    };
    await emailTransporter.sendMail(mailOptions);
    return { success: true };
}

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

const AI_BOT_EMAIL = 'ai@talk.local';
const AI_BOT_NAME = 'Talk AI';
const ADMIN_EMAIL = 'hridaymittal85@gmail.com';
const ADMIN_PASSWORD = 'hello05';
const ADMIN_NAME = 'Hriday';

// ---------- File paths ----------
const DATA_FILE = path.join(__dirname, 'data.json');
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

// ---------- Async file locking ----------
let dataLock = Promise.resolve();
let leaderboardLock = Promise.resolve();

async function withLock(lockRef, fn) {
    const unlock = await new Promise(resolve => {
        const prev = lockRef;
        lockRef = prev.then(() => new Promise(r => resolve(r)));
        return prev.then(() => resolve);
    });
    try {
        return await fn();
    } finally {
        unlock();
    }
}

// ---------- Data helpers ----------
async function readDataFile() {
    try {
        const raw = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        const defaultData = {
            users: {},
            messages: {},
            groups: {},
            groupMessages: {},
            callHistory: [],
            feedback: [],
            challenges: {},
        };
        await fs.writeFile(DATA_FILE, JSON.stringify(defaultData, null, 2));
        return defaultData;
    }
}

async function writeDataFile(data) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

async function readData() {
    return withLock(dataLock, async () => {
        const d = await readDataFile();
        if (!d.groups) d.groups = {};
        if (!d.groupMessages) d.groupMessages = {};
        if (!d.messages) d.messages = {};
        if (!d.users) d.users = {};
        if (!d.callHistory) d.callHistory = [];
        if (!d.feedback) d.feedback = [];
        if (!d.challenges) d.challenges = {};
        for (const u of Object.values(d.users)) {
            if (!Array.isArray(u.contacts)) u.contacts = [];
            if (!Array.isArray(u.blocked)) u.blocked = [];
            if (u.avatar === undefined) u.avatar = null;
            if (!u.status) u.status = 'available';
        }
        for (const conv of Object.values(d.messages)) {
            for (const m of conv) {
                if (!m.reactions) m.reactions = {};
                if (!m.readBy) m.readBy = [];
                if (m.deleted === undefined) m.deleted = false;
            }
        }
        for (const conv of Object.values(d.groupMessages)) {
            for (const m of conv) {
                if (!m.reactions) m.reactions = {};
                if (m.deleted === undefined) m.deleted = false;
            }
        }
        return d;
    });
}

async function writeData(d) {
    return withLock(dataLock, async () => {
        await writeDataFile(d);
    });
}

// ---------- Leaderboard helpers ----------
async function readLeaderboard() {
    return withLock(leaderboardLock, async () => {
        try {
            const raw = await fs.readFile(LEADERBOARD_FILE, 'utf8');
            return JSON.parse(raw);
        } catch {
            const defaultLb = {};
            await fs.writeFile(LEADERBOARD_FILE, JSON.stringify(defaultLb, null, 2));
            return defaultLb;
        }
    });
}

async function writeLeaderboard(data) {
    return withLock(leaderboardLock, async () => {
        await fs.writeFile(LEADERBOARD_FILE, JSON.stringify(data, null, 2));
    });
}

// ---------- Ensure admin exists ----------
async function ensureAdmin() {
    const d = await readData();
    if (!d.users[ADMIN_EMAIL]) {
        d.users[ADMIN_EMAIL] = {
            id: 'admin_' + Date.now().toString(36),
            name: ADMIN_NAME,
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD,
            avatar: '👑',
            status: 'available',
            contacts: [],
            blocked: [],
            isAdmin: true,
            createdAt: new Date().toISOString(),
        };
        console.log('Admin account created:', ADMIN_EMAIL);
    } else if (!d.users[ADMIN_EMAIL].isAdmin) {
        d.users[ADMIN_EMAIL].isAdmin = true;
        d.users[ADMIN_EMAIL].password = ADMIN_PASSWORD;
    }
    await writeData(d);
    console.log('Admin ready');
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Express setup ----------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

// ---------- Firebase Auth (token verified via Firebase Auth REST API) ----------
async function verifyFirebaseToken(idToken) {
    const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyBMu4ZWTCO9of_2DbZTmCqruTYTIfFagJk';
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.users || !data.users[0]) return null;
    const u = data.users[0];
    return { email: u.email, emailVerified: u.emailVerified, displayName: u.displayName, photoUrl: u.photoUrl };
}

app.post('/api/auth/firebase', async (req, res) => {
    const { idToken, name, email, photoURL } = req.body || {};
    if (!idToken || !email) return res.status(400).json({ error: 'idToken and email required' });
    const fbUser = await verifyFirebaseToken(idToken);
    if (!fbUser || fbUser.email !== email) return res.status(401).json({ error: 'Invalid Firebase token' });
    const data = await readData();
    const existing = data.users[email];
    if (existing) {
        // Update profile from Firebase
        if (name && name.trim()) existing.name = name.trim().slice(0, 50);
        if (photoURL) existing.avatar = photoURL;
        await writeData(data);
        res.json({ success: true, user: { id: existing.id, name: existing.name, email: existing.email, avatar: existing.avatar || null, status: existing.status || 'available' } });
    } else {
        const newUser = { id: newId(), name: (name || email.split('@')[0]).slice(0, 50), email, password: '', avatar: photoURL || null, status: 'available', contacts: [], blocked: [], createdAt: new Date().toISOString() };
        data.users[email] = newUser;
        await writeData(data);
        res.json({ success: true, user: { id: newUser.id, name: newUser.name, email: newUser.email, avatar: newUser.avatar, status: 'available' } });
    }
});

// Helper to delete user and all related data
async function cascadeDeleteUser(data, email) {
    delete data.users[email];
    for (const u of Object.values(data.users)) {
        if (u.contacts) u.contacts = u.contacts.filter(c => c !== email);
        if (u.blocked) u.blocked = u.blocked.filter(b => b !== email);
    }
    for (const g of Object.values(data.groups || {})) {
        if (Array.isArray(g.members)) g.members = g.members.filter(m => m !== email);
    }
    for (const key of Object.keys(data.messages || {})) {
        if (key.includes(email)) delete data.messages[key];
    }
    if (data.callHistory) {
        data.callHistory = data.callHistory.filter(c => c.from !== email && c.to !== email);
    }
}

// Keep local auth endpoints for backward compatibility / admin
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const data = await readData();
    const user = data.users[email];
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar || null, status: user.status || 'available' } });
});

// ---------- Password Reset ----------
const resetTokens = new Map(); // email -> { token, expires }

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'No account found with this email' });
    // Generate a simple reset token
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    resetTokens.set(email, { token, expires: Date.now() + 3600000 }); // 1 hour
    // In a real app, send email here. For now, return token in response (dev mode)
    console.log('Password reset token for', email, ':', token);
    res.json({ success: true, message: 'Reset token generated. Use /api/reset-password with token and newPassword.', token });
});

app.post('/api/reset-password', async (req, res) => {
    const { email, token, newPassword } = req.body || {};
    if (!email || !token || !newPassword) return res.status(400).json({ error: 'Email, token and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const stored = resetTokens.get(email);
    if (!stored || stored.token !== token || Date.now() > stored.expires) {
        return res.status(400).json({ error: 'Invalid or expired token' });
    }
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = newPassword;
    await writeData(data);
    resetTokens.delete(email);
    res.json({ success: true, message: 'Password reset successfully' });
});

// ---------- Users ----------
app.get('/api/users', async (req, res) => {
    const data = await readData();
    const users = Object.values(data.users).map(u => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, status: u.status || 'available' }));
    res.json({ users });
});

app.patch('/api/users/:email/profile', async (req, res) => {
    const { email } = req.params;
    const { avatar, name, status } = req.body || {};
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (avatar !== undefined) user.avatar = avatar || null;
    if (name && name.trim().length > 0) user.name = name.trim().slice(0, 50);
    if (status && ['available', 'away', 'busy', 'dnd'].includes(status)) user.status = status;
    await writeData(data);
    const out = { type: 'user-status', email, status: user.status, avatar: user.avatar, name: user.name };
    for (const [, ws] of clients) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(out)); }
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, status: user.status } });
});

app.get('/api/users/:email/contacts', async (req, res) => {
    const { email } = req.params;
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const contacts = (user.contacts || []).map(c => {
        const u = data.users[c];
        if (!u) return null;
        return { id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, status: u.status || 'available' };
    }).filter(Boolean);
    res.json({ contacts, blocked: user.blocked || [] });
});

app.post('/api/users/:email/contacts', async (req, res) => {
    const { email } = req.params;
    const { contactEmail } = req.body || {};
    if (!contactEmail) return res.status(400).json({ error: 'contactEmail required' });
    if (contactEmail === email) return res.status(400).json({ error: 'Cannot add yourself' });
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!data.users[contactEmail] && contactEmail !== AI_BOT_EMAIL)
        return res.status(404).json({ error: 'That person is not on Talk yet' });
    if (!Array.isArray(user.contacts)) user.contacts = [];
    if (!user.contacts.includes(contactEmail)) {
        user.contacts.push(contactEmail);
        await writeData(data);
    }
    res.json({ success: true });
});

app.delete('/api/users/:email/contacts/:target', async (req, res) => {
    const { email, target } = req.params;
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(user.contacts)) user.contacts = [];
    user.contacts = user.contacts.filter(c => c !== target);
    await writeData(data);
    res.json({ success: true });
});

app.post('/api/users/:email/block', async (req, res) => {
    const { email } = req.params;
    const { targetEmail, block } = req.body || {};
    if (!targetEmail) return res.status(400).json({ error: 'targetEmail required' });
    const data = await readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(user.blocked)) user.blocked = [];
    if (block) {
        if (!user.blocked.includes(targetEmail)) user.blocked.push(targetEmail);
    } else {
        user.blocked = user.blocked.filter(b => b !== targetEmail);
    }
    await writeData(data);
    res.json({ success: true, blocked: user.blocked });
});

// ---------- DELETE ACCOUNT ----------
app.post('/api/users/:email/delete', async (req, res) => {
    const { email } = req.params;
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    try {
        const data = await readData();
        const user = data.users[email];
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.password !== password) return res.status(401).json({ error: 'Wrong password' });
        if (user.isAdmin) return res.status(403).json({ error: 'Cannot delete the admin account' });
        await cascadeDeleteUser(data, email);
        await writeData(data);
        const ws = clients.get(email);
        if (ws) { try { ws.close(); } catch {} clients.delete(email); }
        res.json({ success: true });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete account for Firebase users (idToken required)
app.post('/api/users/:email/delete-account', async (req, res) => {
    const { email } = req.params;
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken required' });
    try {
        const fbUser = await verifyFirebaseToken(idToken);
        if (!fbUser || fbUser.email !== email) return res.status(401).json({ error: 'Invalid Firebase token' });
        const data = await readData();
        const user = data.users[email];
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.isAdmin) return res.status(403).json({ error: 'Cannot delete the admin account' });
        await cascadeDeleteUser(data, email);
        await writeData(data);
        const ws = clients.get(email);
        if (ws) { try { ws.close(); } catch {} clients.delete(email); }
        res.json({ success: true });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- Direct messages ----------
app.get('/api/messages/:email1/:email2', async (req, res) => {
    const { email1, email2 } = req.params;
    const data = await readData();
    const key = [email1, email2].sort().join('_');
    const msgs = (data.messages[key] || []).map(m => {
        if (m.challengeId && data.challenges[m.challengeId]) {
            return { ...m, _challenge: data.challenges[m.challengeId] };
        }
        return m;
    });
    res.json({ messages: msgs });
});

app.post('/api/messages', async (req, res) => {
    const { senderEmail, receiverEmail, text, voiceData, voiceDuration } = req.body || {};
    if (!senderEmail || !receiverEmail) return res.status(400).json({ error: 'Sender and receiver required' });
    if (!text && !voiceData) return res.status(400).json({ error: 'Message content required' });
    const data = await readData();
    if (!data.users[senderEmail]) return res.status(404).json({ error: 'Sender not found' });
    if (receiverEmail !== AI_BOT_EMAIL && !data.users[receiverEmail]) {
        return res.status(404).json({ error: 'Recipient is not on Talk yet' });
    }
    if (receiverEmail !== AI_BOT_EMAIL) {
        const receiver = data.users[receiverEmail];
        if (receiver?.blocked?.includes(senderEmail)) {
            return res.status(403).json({ error: 'Message blocked' });
        }
    }
    const saved = await saveDirectMessage(senderEmail, receiverEmail, { text, voiceData, voiceDuration });
    sendTo(receiverEmail, { type: 'message', message: saved });
    res.json({ success: true, message: saved });
});

app.patch('/api/messages/:msgId', async (req, res) => {
    const { msgId } = req.params;
    const { email, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const data = await readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
            msgs[idx].text = text.trim().slice(0, 4000);
            msgs[idx].edited = true;
            await writeData(data);
            const updated = msgs[idx];
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-edited', message: updated });
            return res.json({ success: true, message: updated });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

app.delete('/api/messages/:msgId', async (req, res) => {
    const { msgId } = req.params;
    const { email } = req.body || {};
    const data = await readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
            msgs[idx].deleted = true;
            msgs[idx].text = '';
            msgs[idx].voiceData = null;
            await writeData(data);
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-deleted', messageId: msgId });
            return res.json({ success: true });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

app.post('/api/messages/:msgId/react', async (req, res) => {
    const { msgId } = req.params;
    const { email, emoji } = req.body || {};
    if (!email || !emoji) return res.status(400).json({ error: 'email and emoji required' });
    const data = await readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (!msgs[idx].reactions) msgs[idx].reactions = {};
            if (!msgs[idx].reactions[emoji]) msgs[idx].reactions[emoji] = [];
            const arr = msgs[idx].reactions[emoji];
            const pos = arr.indexOf(email);
            if (pos >= 0) arr.splice(pos, 1); else arr.push(email);
            if (arr.length === 0) delete msgs[idx].reactions[emoji];
            await writeData(data);
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-reacted', messageId: msgId, reactions: msgs[idx].reactions });
            return res.json({ success: true, reactions: msgs[idx].reactions });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

app.post('/api/messages/:email1/:email2/read', async (req, res) => {
    const { email1, email2 } = req.params;
    const { reader } = req.body || {};
    const data = await readData();
    const key = [email1, email2].sort().join('_');
    const msgs = data.messages[key] || [];
    let changed = false;
    for (const m of msgs) {
        if (m.senderEmail !== reader && !m.readBy?.includes(reader)) {
            if (!m.readBy) m.readBy = [];
            m.readBy.push(reader);
            changed = true;
        }
    }
    if (changed) {
        await writeData(data);
        const otherEmail = reader === email1 ? email2 : email1;
        sendTo(otherEmail, { type: 'messages-read', by: reader, convKey: key });
    }
    res.json({ success: true });
});

async function saveDirectMessage(senderEmail, receiverEmail, content) {
    const data = await readData();
    const key = [senderEmail, receiverEmail].sort().join('_');
    if (!data.messages[key]) data.messages[key] = [];
    const msg = {
        id: newId(),
        senderEmail, receiverEmail,
        text: content.text || '',
        voiceData: content.voiceData || null,
        voiceDuration: content.voiceDuration || null,
        timestamp: new Date().toISOString(),
        reactions: {},
        readBy: [],
        deleted: false,
        edited: false,
    };
    data.messages[key].push(msg);
    await writeData(data);
    return msg;
}

// ---------- Groups ----------
function userInGroup(group, email) {
    return group && Array.isArray(group.members) && group.members.includes(email);
}

app.get('/api/groups', async (req, res) => {
    const email = (req.query.email || '').toString();
    if (!email) return res.status(400).json({ error: 'email query required' });
    const data = await readData();
    const list = Object.values(data.groups)
        .filter(g => userInGroup(g, email))
        .map(g => ({ id: g.id, name: g.name, members: g.members, createdBy: g.createdBy, createdAt: g.createdAt }));
    res.json({ groups: list });
});

app.post('/api/groups', async (req, res) => {
    const { name, members, createdBy } = req.body || {};
    if (!name || !createdBy) return res.status(400).json({ error: 'name and createdBy required' });
    const data = await readData();
    if (!data.users[createdBy]) return res.status(404).json({ error: 'Creator not found' });
    const memberSet = new Set([createdBy, ...(Array.isArray(members) ? members : [])]);
    const memberList = Array.from(memberSet).filter(e => data.users[e]);
    if (memberList.length < 2) return res.status(400).json({ error: 'Add at least one other member' });
    const id = 'g_' + newId();
    const group = { id, name: name.trim().slice(0, 60), members: memberList, createdBy, createdAt: new Date().toISOString() };
    data.groups[id] = group;
    data.groupMessages[id] = [];
    await writeData(data);
    for (const m of memberList) sendTo(m, { type: 'group-created', group });
    res.json({ success: true, group });
});

app.patch('/api/groups/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email } = req.body || {};
    const data = await readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    if (name && name.trim().length > 0) group.name = name.trim().slice(0, 60);
    await writeData(data);
    for (const m of group.members) sendTo(m, { type: 'group-updated', group });
    res.json({ success: true, group });
});

app.post('/api/groups/:id/members', async (req, res) => {
    const { id } = req.params;
    const { email, addedBy } = req.body || {};
    const data = await readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, addedBy)) return res.status(403).json({ error: 'Not a member' });
    if (!data.users[email]) return res.status(404).json({ error: 'User not on Talk yet' });
    if (group.members.includes(email)) return res.status(400).json({ error: 'Already in group' });
    group.members.push(email);
    const sysMsg = { id: newId(), groupId: id, senderEmail: 'system', senderName: 'System',
        text: `${data.users[addedBy]?.name || addedBy} added ${data.users[email].name} to the group`,
        timestamp: new Date().toISOString(), system: true, reactions: {}, deleted: false };
    if (!data.groupMessages[id]) data.groupMessages[id] = [];
    data.groupMessages[id].push(sysMsg);
    await writeData(data);
    for (const m of group.members) {
        sendTo(m, { type: 'group-updated', group });
        sendTo(m, { type: 'group-message', message: sysMsg });
    }
    res.json({ success: true, group });
});

app.delete('/api/groups/:id/members/:target', async (req, res) => {
    const { id, target } = req.params;
    const { email } = req.body || {};
    const data = await readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    if (!group.members.includes(target)) return res.status(400).json({ error: 'Not in group' });
    group.members = group.members.filter(m => m !== target);
    const removerName = data.users[email]?.name || email;
    const removedName = data.users[target]?.name || target;
    const sysMsg = { id: newId(), groupId: id, senderEmail: 'system', senderName: 'System',
        text: `${removerName} removed ${removedName} from the group`,
        timestamp: new Date().toISOString(), system: true, reactions: {}, deleted: false };
    if (!data.groupMessages[id]) data.groupMessages[id] = [];
    data.groupMessages[id].push(sysMsg);
    await writeData(data);
    for (const m of [...group.members, target]) {
        sendTo(m, { type: 'group-updated', group });
        sendTo(m, { type: 'group-message', message: sysMsg });
    }
    res.json({ success: true, group });
});

app.get('/api/groups/:id/messages', async (req, res) => {
    const { id } = req.params;
    const email = (req.query.email || '').toString();
    const data = await readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    res.json({ messages: data.groupMessages[id] || [], group });
});

app.post('/api/groups/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { senderEmail, text, voiceData, voiceDuration } = req.body || {};
    if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' });
    if (!text && !voiceData) return res.status(400).json({ error: 'Message content required' });
    const data = await readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, senderEmail)) return res.status(403).json({ error: 'Not a member' });
    const sender = data.users[senderEmail];
    const msg = await saveGroupMessage(group, senderEmail, sender?.name || senderEmail, { text, voiceData, voiceDuration });
    for (const m of group.members) sendTo(m, { type: 'group-message', message: msg });
    res.json({ success: true, message: msg });
});

app.patch('/api/groups/:id/messages/:msgId', async (req, res) => {
    const { id, msgId } = req.params;
    const { email, text } = req.body || {};
    const data = await readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
    msgs[idx].text = text.trim().slice(0, 4000);
    msgs[idx].edited = true;
    await writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-edited', message: msgs[idx] });
    res.json({ success: true, message: msgs[idx] });
});

app.delete('/api/groups/:id/messages/:msgId', async (req, res) => {
    const { id, msgId } = req.params;
    const { email } = req.body || {};
    const data = await readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
    msgs[idx].deleted = true;
    msgs[idx].text = '';
    msgs[idx].voiceData = null;
    await writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-deleted', messageId: msgId, groupId: id });
    res.json({ success: true });
});

app.post('/api/groups/:id/messages/:msgId/react', async (req, res) => {
    const { id, msgId } = req.params;
    const { email, emoji } = req.body || {};
    const data = await readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (!msgs[idx].reactions) msgs[idx].reactions = {};
    if (!msgs[idx].reactions[emoji]) msgs[idx].reactions[emoji] = [];
    const arr = msgs[idx].reactions[emoji];
    const pos = arr.indexOf(email);
    if (pos >= 0) arr.splice(pos, 1); else arr.push(email);
    if (arr.length === 0) delete msgs[idx].reactions[emoji];
    await writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-reacted', messageId: msgId, groupId: id, reactions: msgs[idx].reactions });
    res.json({ success: true, reactions: msgs[idx].reactions });
});

async function saveGroupMessage(group, senderEmail, senderName, content) {
    const data = await readData();
    const msg = {
        id: newId(),
        groupId: group.id,
        senderEmail,
        senderName,
        text: content.text || '',
        voiceData: content.voiceData || null,
        voiceDuration: content.voiceDuration || null,
        timestamp: new Date().toISOString(),
        reactions: {},
        deleted: false,
        edited: false,
    };
    if (!data.groupMessages[group.id]) data.groupMessages[group.id] = [];
    data.groupMessages[group.id].push(msg);
    await writeData(data);
    return msg;
}

// ---------- Challenges ----------
app.post('/api/challenges', async (req, res) => {
    const { challenger, opponent, game } = req.body || {};
    if (!challenger || !opponent || !game) return res.status(400).json({ error: 'challenger, opponent, game required' });
    const data = await readData();
    if (!data.users[challenger]) return res.status(404).json({ error: 'Challenger not found' });
    if (!data.users[opponent]) return res.status(404).json({ error: 'Opponent not found' });
    const id = 'c_' + newId();
    const challenge = { id, game, challenger, opponent, challengerScore: null, opponentScore: null, status: 'pending', createdAt: new Date().toISOString() };
    data.challenges[id] = challenge;
    const msg = {
        id: 'm_' + newId(), senderEmail: challenger, receiverEmail: opponent,
        text: '🎮 Game Challenge: ' + (game === 'dodger' ? 'Dodger' : 'Arcade'),
        challengeId: id, game, timestamp: new Date().toISOString(),
        reactions: {}, readBy: [], deleted: false, edited: false,
    };
    const key = [challenger, opponent].sort().join('_');
    if (!data.messages[key]) data.messages[key] = [];
    data.messages[key].push(msg);
    await writeData(data);
    const wsMsg = { ...msg, _challenge: challenge };
    sendTo(opponent, { type: 'message', message: wsMsg });
    sendTo(challenger, { type: 'message', message: wsMsg });
    res.json({ success: true, challenge, message: wsMsg });
});

app.get('/api/challenges/:id', async (req, res) => {
    const data = await readData();
    const c = data.challenges[req.params.id];
    if (!c) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ challenge: c });
});

app.post('/api/challenges/:id/score', async (req, res) => {
    const { id } = req.params;
    const { email, score } = req.body || {};
    if (!email || score === undefined) return res.status(400).json({ error: 'email and score required' });
    const data = await readData();
    const c = data.challenges[id];
    if (!c) return res.status(404).json({ error: 'Challenge not found' });
    if (c.status === 'complete') return res.json({ success: true, challenge: c });
    if (email === c.challenger && c.challengerScore === null) c.challengerScore = Number(score);
    else if (email === c.opponent && c.opponentScore === null) c.opponentScore = Number(score);
    else return res.json({ success: true, challenge: c });
    if (c.challengerScore !== null && c.opponentScore !== null) {
        c.status = 'complete';
        if (c.challengerScore > c.opponentScore) c.winner = c.challenger;
        else if (c.opponentScore > c.challengerScore) c.winner = c.opponent;
        else c.winner = 'tie';
    } else { c.status = 'in-progress'; }
    // Update leaderboard
    const lb = await readLeaderboard();
    const u = data.users[email];
    if (u) {
        if (!lb[c.game]) lb[c.game] = [];
        const board = lb[c.game];
        const existing = board.find(e => e.email === email);
        if (existing) { if (Number(score) > existing.score) { existing.score = Number(score); existing.updatedAt = new Date().toISOString(); } }
        else board.push({ email, name: u.name, score: Number(score), updatedAt: new Date().toISOString() });
        board.sort((a, b) => b.score - a.score);
        lb[c.game] = board.slice(0, 100);
        await writeLeaderboard(lb);
    }
    await writeData(data);
    sendTo(c.challenger, { type: 'challenge-updated', challenge: c });
    sendTo(c.opponent, { type: 'challenge-updated', challenge: c });
    res.json({ success: true, challenge: c });
});

// ---------- Feedback ----------
app.get('/api/feedback', async (req, res) => {
    const data = await readData();
    res.json({ reviews: (data.feedback || []).slice().reverse() });
});

app.post('/api/feedback', async (req, res) => {
    const { email, rating, message } = req.body || {};
    if (!email || !rating) return res.status(400).json({ error: 'email and rating required' });
    const data = await readData();
    if (!data.users[email]) return res.status(404).json({ error: 'User not found' });
    const u = data.users[email];
    const entry = { id: newId(), email, name: u.name, avatar: u.avatar || null, rating: Number(rating), message: (message || '').slice(0, 500), timestamp: new Date().toISOString() };
    data.feedback.push(entry);
    await writeData(data);
    res.json({ success: true, review: entry });
});

// ---------- Leaderboard (dedicated file) ----------
app.get('/api/leaderboard', async (req, res) => {
    const lb = await readLeaderboard();
    res.json({ leaderboard: lb });
});

app.post('/api/leaderboard/score', async (req, res) => {
    const { email, name, game, score } = req.body || {};
    if (!email || !game || score === undefined) return res.status(400).json({ error: 'email, game, score required' });
    const lb = await readLeaderboard();
    if (!lb[game]) lb[game] = [];
    const board = lb[game];
    const existing = board.find(e => e.email === email);
    if (existing) { if (Number(score) > existing.score) { existing.score = Number(score); existing.name = name || existing.name; existing.updatedAt = new Date().toISOString(); } }
    else board.push({ email, name: name || email, score: Number(score), updatedAt: new Date().toISOString() });
    board.sort((a, b) => b.score - a.score);
    lb[game] = board.slice(0, 100);
    await writeLeaderboard(lb);
    res.json({ success: true });
});

app.delete('/api/leaderboard', async (req, res) => {
    const { adminEmail, adminPassword, game } = req.body || {};
    if (adminEmail !== ADMIN_EMAIL || adminPassword !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Admin credentials required' });
    const lb = await readLeaderboard();
    if (game) { lb[game] = []; }
    else { for (const k of Object.keys(lb)) delete lb[k]; }
    await writeLeaderboard(lb);
    res.json({ success: true });
});

// ---------- Call history ----------
app.post('/api/call/initiate', async (req, res) => {
    const { fromEmail, fromName, toEmail, callType } = req.body || {};
    if (!fromEmail || !toEmail) return res.status(400).json({ error: 'fromEmail and toEmail required' });
    const data = await readData();
    const fromNameResolved = fromName || data.users[fromEmail]?.name || fromEmail;
    const cType = callType === 'video' ? 'video' : 'audio';
    // Ensure caller exists in local data so call history can be recorded
    if (!data.users[fromEmail]) {
        data.users[fromEmail] = { id: newId(), name: fromNameResolved, email: fromEmail, avatar: null, status: 'available', contacts: [], blocked: [], createdAt: new Date().toISOString() };
        await writeData(data);
    }
    // Send push notification (works even if recipient isn't in local data — they may be a Firebase-only user)
    sendPushToUser(toEmail, {
        title: 'Incoming ' + cType + ' call',
        body: fromNameResolved + ' is calling you',
        tag: 'call-' + fromEmail,
        type: 'call-invite',
        from: fromEmail,
        fromName: fromNameResolved,
        callType: cType
    }).catch(() => {});
    try {
        const ws = clients.get(toEmail);
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'call-invite', from: fromEmail, fromName: fromNameResolved, callType: cType }));
        }
    } catch {}
    res.json({ success: true });
});

app.get('/api/calls/:email', async (req, res) => {
    const { email } = req.params;
    const data = await readData();
    const calls = (data.callHistory || [])
        .filter(c => c.from === email || c.to === email)
        .slice(-100).reverse();
    res.json({ calls });
});

// ---------- Admin download ----------
app.get('/api/admin/download', (req, res) => {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
    const EXCLUDE = new Set(['node_modules', '.git', '.cache', '.local', '.upm', '.replit', 'replit.nix', ]);
    const EXT_OK = new Set(['.js', '.html', '.css', '.json', '.md', '.txt', '.nix', '.sh', '.ts', '.jsx', '.tsx']);
    function collectFiles(dir, base) {
        let out = [];
        for (const name of require('fs').readdirSync(dir)) {
            if (EXCLUDE.has(name) || name.startsWith('.')) continue;
            const abs = path.join(dir, name);
            const rel = base ? path.join(base, name) : name;
            const stat = require('fs').statSync(abs);
            if (stat.isDirectory()) { out = out.concat(collectFiles(abs, rel)); }
            else if (EXT_OK.has(path.extname(name).toLowerCase()) || name === 'package-lock.json') {
                out.push({ abs, rel });
            }
        }
        return out;
    }
    const files = collectFiles(__dirname, '');
    res.setHeader('Content-Disposition', 'attachment; filename="talk-app.zip"');
    res.setHeader('Content-Type', 'application/zip');
    const archive = require('archiver')('zip', { zlib: { level: 9 } });
    archive.on('error', err => { console.error('Archive error:', err); res.status(500).end(); });
    archive.pipe(res);
    for (const { abs, rel } of files) {
        try { archive.file(abs, { name: rel }); } catch (_) { }
    }
    archive.finalize();
});

// ---------- Static files ----------
// Serve Vite-built frontend from dist/ if it exists, otherwise raw files (dev mode)
const distDir = path.join(__dirname, 'dist');
let serveDir = __dirname;
try { require('fs').accessSync(distDir); serveDir = distDir; } catch {}
app.post('/api/push/subscribe', async (req, res) => {
  const { email, subscription } = req.body || {};
  if (!email || !subscription || !subscription.endpoint) return res.status(400).json({ error: 'missing' });
  const subs = await readPushSubs();
  if (!subs[email]) subs[email] = [];
  const exists = subs[email].find(s => s.endpoint === subscription.endpoint);
  if (!exists) subs[email].push(subscription);
  await writePushSubs(subs);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { email, endpoint } = req.body || {};
  if (!email || !endpoint) return res.status(400).json({ error: 'missing' });
  const subs = await readPushSubs();
  if (subs[email]) {
    subs[email] = subs[email].filter(s => s.endpoint !== endpoint);
    if (subs[email].length === 0) delete subs[email];
    await writePushSubs(subs);
  }
  res.json({ ok: true });
});

// ---------- Pre-signup email verification (magic link via EmailJS) ----------
// Pending signups are stored in memory: email -> { name, password, token, verified, expires }
const pendingSignups = new Map();
const EMAILJS_USER_ID = process.env.EMAILJS_USER_ID || 'rfbFho74v6R1nSzk5';
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'talkapp';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_er3zdx5';

app.post('/api/auth/send-link', async (req, res) => {
    const { email, name, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Reject if a Firebase user already exists for this email
    if (adminAuth) {
        try {
            await adminAuth.getUserByEmail(email);
            return res.status(409).json({ error: 'Email already registered' });
        } catch { /* no user — good */ }
    }

    const token = crypto.randomBytes(32).toString('hex');
    pendingSignups.set(email.toLowerCase(), {
        email, name: name || '', password, token, verified: false,
        expires: Date.now() + 86400000
    });

    const hostUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
    const magicLink = `${hostUrl}/api/auth/verify-link?token=${token}&email=${encodeURIComponent(email)}`;

    try {
        const emailjsResponse = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: EMAILJS_USER_ID,
                service_id: EMAILJS_SERVICE_ID,
                template_id: EMAILJS_TEMPLATE_ID,
                template_params: { to_email: email, verification_link: magicLink }
            })
        });
        if (emailjsResponse.ok) {
            res.json({ success: true, message: 'Verification email sent' });
        } else {
            const mailError = await emailjsResponse.text();
            console.error('EmailJS error:', mailError);
            res.status(500).json({ error: 'Failed to send verification email' });
        }
    } catch (err) {
        console.error('send-link network error:', err.message);
        res.status(500).json({ error: 'Server network error' });
    }
});

app.get('/api/auth/verify-link', async (req, res) => {
    const { token, email } = req.query || {};
    const session = pendingSignups.get((email || '').toLowerCase());
    if (!session || session.token !== token) {
        return res.status(400).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invalid</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;}</style></head><body><div><h1 style="color:#ef4444;">Link expired or invalid</h1><p style="color:#94a3b8;">Please request a new verification link.</p></div></body></html>');
    }
    if (Date.now() > session.expires) {
        pendingSignups.delete((email || '').toLowerCase());
        return res.status(400).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Expired</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;}</style></head><body><div><h1 style="color:#ef4444;">Link expired</h1><p style="color:#94a3b8;">This link has expired. Please sign up again.</p></div></body></html>');
    }
    session.verified = true;
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Verified</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;}h1{color:#4ade80;font-size:2em;}p{color:#94a3b8;font-size:1.1em;}a{display:inline-block;margin-top:20px;padding:12px 28px;background:#6264a7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;}</style></head><body><div><h1>&#10003; Email Verified!</h1><p>Return to the Talk sign-up screen to finish creating your account.</p><a href="/">Go to Talk</a></div></body></html>');
});

app.get('/api/auth/status', async (req, res) => {
    const { email } = req.query || {};
    const session = pendingSignups.get((email || '').toLowerCase());
    if (session && session.verified) {
        res.json({ verified: true });
    } else {
        res.json({ verified: false });
    }
});

app.post('/api/send-verification', async (req, res) => {
    const { email, name } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
        const result = await sendVerificationEmail(email, name);
        if (!result.success) return res.status(503).json({ error: result.error });
        res.json({ success: true, message: 'Verification email sent' });
    } catch (err) {
        console.error('send-verification error:', err.message);
        res.status(500).json({ error: 'Failed to send verification email' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { email, token } = req.query || {};
    if (!email || !token) return res.status(400).send('Missing email or token');
    const stored = emailVerifyTokens.get(email.toLowerCase());
    if (!stored || stored.token !== token) {
        return res.status(400).send('Invalid or expired verification link');
    }
    if (Date.now() > stored.expires) {
        emailVerifyTokens.delete(email.toLowerCase());
        return res.status(400).send('This verification link has expired. Please request a new one.');
    }
    emailVerifyTokens.delete(email.toLowerCase());

    // Update Firebase Auth to mark email as verified
    if (adminAuth) {
        try {
            const userRecord = await adminAuth.getUserByEmail(email);
            if (!userRecord.emailVerified) {
                await adminAuth.updateUser(userRecord.uid, { emailVerified: true });
            }
        } catch (err) {
            console.error('Failed to update Firebase Auth emailVerified:', err.message);
        }
    }

    const data = await readData();
    if (data.users[email]) {
        data.users[email].emailVerified = true;
        await writeData(data);
    }
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Email Verified</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;}h1{color:#4ade80;font-size:2em;}p{color:#94a3b8;font-size:1.1em;}a{display:inline-block;margin-top:20px;padding:12px 28px;background:#6264a7;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;}</style></head><body><div><h1>✓ Email Verified!</h1><p>Your email has been verified. You can now sign in to Talk.</p><a href="/">Go to Talk</a></div></body></html>`);
});

app.get('/api/check-verified', async (req, res) => {
    const { email } = req.query || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check Firebase Auth first (authoritative source)
    if (adminAuth) {
        try {
            const userRecord = await adminAuth.getUserByEmail(email);
            if (userRecord.emailVerified) {
                const data = await readData();
                if (data.users[email] && !data.users[email].emailVerified) {
                    data.users[email].emailVerified = true;
                    await writeData(data);
                }
                return res.json({ verified: true });
            }
        } catch {}
    }

    const data = await readData();
    const user = data.users[email];
    res.json({ verified: !!(user && user.emailVerified) });
});

app.get('/api/push/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.use(express.static(serveDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    extensions: ['html'],
}));
// SPA fallback: serve index.html for any non-API route
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(serveDir, 'index.html'));
});

// ---------- WebSocket + HTTP server ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();
const pendingCalls = new Map();
const groupCalls = new Map();

function broadcastPresence() {
    const online = Array.from(clients.keys());
    online.push(AI_BOT_EMAIL);
    const msg = JSON.stringify({ type: 'presence', online });
    for (const ws of clients.values()) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
    }
}

function sendTo(email, payload) {
    const ws = clients.get(email);
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

wss.on('connection', (ws) => {
    ws.email = null;

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'hello' && msg.email) {
            ws.email = msg.email;
            const prev = clients.get(msg.email);
            if (prev && prev !== ws) { try { prev.close(); } catch { } }
            clients.set(msg.email, ws);
            broadcastPresence();
            return;
        }

        if (!ws.email) return;

        if (msg.type === 'message' && msg.to) {
            const data = await readData();
            if (msg.to !== AI_BOT_EMAIL && !data.users[msg.to]) return;
            const saved = await saveDirectMessage(ws.email, msg.to, { text: msg.text, voiceData: msg.voiceData, voiceDuration: msg.voiceDuration });
            const out = { type: 'message', message: saved };
            sendTo(msg.to, out);
            sendTo(ws.email, out);
            return;
        }

        if (msg.type === 'group-message' && msg.groupId) {
            const data = await readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            const sender = data.users[ws.email];
            const saved = await saveGroupMessage(group, ws.email, sender?.name || ws.email, { text: msg.text, voiceData: msg.voiceDuration });
            for (const m of group.members) sendTo(m, { type: 'group-message', message: saved });
            return;
        }

        if (msg.type === 'group-typing' && msg.groupId) {
            const data = await readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            for (const m of group.members) {
                if (m === ws.email) continue;
                sendTo(m, { type: 'group-typing', groupId: msg.groupId, from: ws.email, fromName: data.users[ws.email]?.name || ws.email, isTyping: !!msg.isTyping });
            }
            return;
        }

        if (msg.type === 'call-invite' && msg.to) {
            const callKey = ws.email + ':' + msg.to;
            pendingCalls.set(callKey, { id: newId(), from: ws.email, to: msg.to, callType: msg.callType || 'audio', startTime: new Date().toISOString(), status: 'ringing' });
            sendTo(msg.to, { ...msg, from: ws.email });
            const data = await readData();
            const fromName = data.users[ws.email]?.name || ws.email;
            sendPushToUser(msg.to, {
                title: 'Incoming ' + (msg.callType === 'video' ? 'video' : 'audio') + ' call',
                body: fromName + ' is calling you',
                tag: 'call-' + ws.email,
                type: 'call-invite',
                from: ws.email,
                fromName,
                callType: msg.callType || 'audio'
            }).catch(() => {});
            return;
        }
        if (msg.type === 'call-accept' && msg.to) {
            const record = pendingCalls.get(msg.to + ':' + ws.email);
            if (record) { record.status = 'answered'; record.answeredAt = new Date().toISOString(); }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if ((msg.type === 'call-reject' || msg.type === 'call-cancel') && msg.to) {
            const k1 = ws.email + ':' + msg.to;
            const k2 = msg.to + ':' + ws.email;
            const key = pendingCalls.has(k1) ? k1 : k2;
            const record = pendingCalls.get(key);
            if (record) {
                record.status = msg.type === 'call-cancel' ? 'missed' : 'rejected';
                record.endTime = new Date().toISOString();
                const data = await readData();
                data.callHistory.push(record);
                if (data.callHistory.length > 500) data.callHistory = data.callHistory.slice(-500);
                await writeData(data);
                pendingCalls.delete(key);
            }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if (msg.type === 'call-end' && msg.to) {
            const k1 = ws.email + ':' + msg.to;
            const k2 = msg.to + ':' + ws.email;
            const key = pendingCalls.has(k1) ? k1 : k2;
            const record = pendingCalls.get(key);
            if (record) {
                if (record.status !== 'answered') record.status = 'missed';
                record.endTime = new Date().toISOString();
                const data = await readData();
                data.callHistory.push(record);
                if (data.callHistory.length > 500) data.callHistory = data.callHistory.slice(-500);
                await writeData(data);
                pendingCalls.delete(key);
            }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if (['webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'typing'].includes(msg.type)) {
            if (!msg.to) return;
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }

        // Group calls
        if (msg.type === 'group-call-start' && msg.groupId) {
            const data = await readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            if (!groupCalls.has(msg.groupId)) {
                groupCalls.set(msg.groupId, { participants: new Set([ws.email]), startedBy: ws.email, startTime: new Date().toISOString() });
            } else {
                groupCalls.get(msg.groupId).participants.add(ws.email);
            }
            const call = groupCalls.get(msg.groupId);
            const starterName = data.users[ws.email]?.name || ws.email;
            for (const m of group.members) {
                if (m === ws.email) {
                    sendTo(m, { type: 'group-call-state', groupId: msg.groupId, participants: Array.from(call.participants) });
                } else {
                    sendTo(m, { type: 'group-call-invite', groupId: msg.groupId, groupName: group.name, startedBy: ws.email, startedByName: starterName });
                }
            }
            return;
        }
        if (msg.type === 'group-call-join' && msg.groupId) {
            const data = await readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            let call = groupCalls.get(msg.groupId);
            if (!call) { call = { participants: new Set(), startedBy: ws.email, startTime: new Date().toISOString() }; groupCalls.set(msg.groupId, call); }
            const existingParticipants = Array.from(call.participants);
            call.participants.add(ws.email);
            const all = Array.from(call.participants);
            sendTo(ws.email, { type: 'group-call-state', groupId: msg.groupId, participants: all, newJoiner: ws.email, existingParticipants });
            for (const p of call.participants) {
                if (p !== ws.email) sendTo(p, { type: 'group-call-state', groupId: msg.groupId, participants: all, newJoiner: ws.email });
            }
            return;
        }
        if (msg.type === 'group-call-leave' && msg.groupId) {
            const call = groupCalls.get(msg.groupId);
            if (call) {
                call.participants.delete(ws.email);
                const all = Array.from(call.participants);
                for (const p of call.participants) sendTo(p, { type: 'group-call-state', groupId: msg.groupId, participants: all });
                if (call.participants.size === 0) groupCalls.delete(msg.groupId);
            }
            return;
        }
        if (['group-webrtc-offer', 'group-webrtc-answer', 'group-webrtc-ice'].includes(msg.type)) {
            if (!msg.to) return;
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
    });

    ws.on('close', () => {
        if (ws.email && clients.get(ws.email) === ws) {
            clients.delete(ws.email);
            broadcastPresence();
        }
    });
});

// Config endpoint
app.get('/api/config', (req, res) => {
    res.json({
        secondaryRepoUrl: process.env.SECONDARY_REPO_URL || null
    });
});

// E2EE HKDF salt — served to the client for key derivation.
// The salt is set via the E2EE_HKDF_SALT env var. It is mixed into the
// HKDF key derivation alongside the ECDH shared secret. Rotating the salt
// invalidates all previously encrypted messages (forcing re-key), so only
// rotate if you accept that old messages become undecryptable.
app.get('/api/e2ee-salt', (req, res) => {
    const salt = process.env.E2EE_HKDF_SALT || 'c+Wt71uGNBRtquI8yfDC6SK2j1YN2vMe3zEnjz5vGYY=';
    res.json({ salt });
});

// Start server
(async () => {
    await ensureAdmin();
    server.listen(PORT, HOST, () => {
        console.log(`Talk server running at http://${HOST}:${PORT}/`);
    });
})();
