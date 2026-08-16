/**
 * End-to-end encryption (E2EE) module for Talk.
 *
 * Uses ECDH (P-256) for key exchange and AES-GCM (256-bit) for message encryption.
 * Each user generates a key pair on first login. The public key is stored in the
 * database (Firestore + RTDB) so other users can encrypt messages to them. The
 * private key is kept in IndexedDB and never leaves the device.
 *
 * Shared secret derivation: ECDH(myPrivate, theirPublic) -> HKDF(salt, ikm) -> AES key
 * The HKDF salt is served from the server (E2EE_HKDF_SALT env var) so it can be
 * rotated without redeploying the frontend.
 */

const DB_NAME = 'talk-e2ee';
const STORE_NAME = 'keys';
const KEY_ID = 'identity';

// --- IndexedDB helpers (for private key storage) ---

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value, key = KEY_ID) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key = KEY_ID) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// --- Base64 helpers ---

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// --- Salt fetching (from server env var) ---

let cachedSalt = null;

async function getHkdfSalt() {
  if (cachedSalt) return cachedSalt;
  try {
    const res = await fetch('/api/e2ee-salt');
    const data = await res.json();
    if (data.salt) {
      cachedSalt = b64ToBuf(data.salt);
      return cachedSalt;
    }
  } catch {}
  // Fallback: a fixed default salt (less secure but keeps the app working
  // if the server endpoint is unavailable during development)
  const encoder = new TextEncoder();
  cachedSalt = encoder.encode('talk-e2ee-default-salt-v1').buffer;
  return cachedSalt;
}

// --- Key pair management ---

/**
 * Generate a new ECDH P-256 key pair.
 * Returns { publicKey, privateKey } as CryptoKeyPairs.
 */
export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
  return pair;
}

/**
 * Export a public key to base64 SPKI format for storage in the database.
 */
export async function exportPublicKey(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufToB64(spki);
}

/**
 * Import a public key from base64 SPKI format.
 */
export async function importPublicKey(b64) {
  return crypto.subtle.importKey(
    'spki',
    b64ToBuf(b64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

/**
 * Import a private key from raw PKCS8 base64 (for restoring from IndexedDB).
 */
async function importPrivateKey(b64) {
  return crypto.subtle.importKey(
    'pkcs8',
    b64ToBuf(b64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey', 'deriveBits']
  );
}

async function exportPrivateKey(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  return bufToB64(pkcs8);
}

/**
 * Get or create the user's identity key pair.
 * Private key is stored in IndexedDB; public key (base64) is returned for DB storage.
 */
export async function getOrCreateKeyPair() {
  const stored = await idbGet(KEY_ID);
  if (stored) {
    const privateKey = await importPrivateKey(stored);
    const publicKey = await crypto.subtle.exportKey('spki', privateKey);
    return { privateKey, publicKeyB64: bufToB64(publicKey) };
  }
  const pair = await generateKeyPair();
  const privB64 = await exportPrivateKey(pair.privateKey);
  await idbPut(privB64);
  const pubB64 = await exportPublicKey(pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyB64: pubB64 };
}

// --- Shared secret derivation ---

const sharedKeyCache = new Map();

/**
 * Derive an AES-GCM key from our private key and their public key.
 * Cached per recipient for the session.
 */
async function getSharedKey(theirPublicKeyB64, myPrivateKey) {
  if (sharedKeyCache.has(theirPublicKeyB64)) {
    return sharedKeyCache.get(theirPublicKeyB64);
  }
  const theirPubKey = await importPublicKey(theirPublicKeyB64);
  const salt = await getHkdfSalt();
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPubKey },
    myPrivateKey,
    { name: 'HKDF', hash: 'SHA-256' },
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('talk-aes-gcm') },
    sharedKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  sharedKeyCache.set(theirPublicKeyB64, aesKey);
  return aesKey;
}

// --- Encryption / Decryption ---

/**
 * Encrypt a plaintext message string.
 * Returns { ciphertext, iv } both as base64, or null if encryption fails.
 */
export async function encryptMessage(plaintext, theirPublicKeyB64, myPrivateKey) {
  if (!plaintext || !theirPublicKeyB64 || !myPrivateKey) return null;
  const aesKey = await getSharedKey(theirPublicKeyB64, myPrivateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encoded
  );
  return { ciphertext: bufToB64(ciphertext), iv: bufToB64(iv) };
}

/**
 * Decrypt a message. Returns the plaintext string, or null on failure.
 */
export async function decryptMessage(encryptedPayload, theirPublicKeyB64, myPrivateKey) {
  if (!encryptedPayload || !encryptedPayload.ciphertext || !encryptedPayload.iv) return null;
  if (!theirPublicKeyB64 || !myPrivateKey) return null;
  try {
    const aesKey = await getSharedKey(theirPublicKeyB64, myPrivateKey);
    const iv = new Uint8Array(b64ToBuf(encryptedPayload.iv));
    const ciphertext = b64ToBuf(encryptedPayload.ciphertext);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/**
 * Encrypt a short preview string for chat list (same method as messages).
 * Returns base64 string or the original if encryption fails.
 */
export async function encryptPreview(plaintext, theirPublicKeyB64, myPrivateKey) {
  const result = await encryptMessage(plaintext, theirPublicKeyB64, myPrivateKey);
  if (!result) return plaintext;
  return JSON.stringify(result);
}

/**
 * Decrypt a preview string that was encrypted with encryptPreview.
 */
export async function decryptPreview(previewStr, theirPublicKeyB64, myPrivateKey) {
  if (!previewStr) return '';
  try {
    const parsed = JSON.parse(previewStr);
    if (!parsed.ciphertext || !parsed.iv) return previewStr;
    const decrypted = await decryptMessage(parsed, theirPublicKeyB64, myPrivateKey);
    return decrypted || previewStr;
  } catch {
    return previewStr;
  }
}
