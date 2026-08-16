/**
 * WARNING: THIS SCRIPT IS IRREVERSIBLE.
 * It deletes ALL Firebase Authentication users, ALL Firestore documents,
 * and ALL Realtime Database data.
 * Only run this if you are absolutely sure you want to wipe everything.
 *
 * Requirements:
 *   npm install firebase-admin
 *
 * Environment variables needed (place in .env or export before running):
 *   FIREBASE_ADMIN_PROJECT_ID - your Firebase project ID (e.g. talkapp55)
 *   FIREBASE_ADMIN_CLIENT_EMAIL - the client_email from your service account JSON
 *   FIREBASE_ADMIN_PRIVATE_KEY - the private_key from your service account JSON (include \n characters)
 *
 * Alternatively, set FIREBASE_ADMIN_CREDENTIAL_PATH to the path of your service account JSON file.
 *
 * To get a service account JSON:
 *   1. Go to Firebase Console > Project Settings > Service Accounts
 *   2. Click "Generate new private key"
 *   3. Save the JSON file securely
 *
 * Usage:
 *   FIREBASE_ADMIN_CREDENTIAL_PATH=./service-account.json node scripts/delete-all-accounts.js
 */

const admin = require('firebase-admin');

// --- Initialize Firebase Admin SDK ---
const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || 'talkapp55';
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
const credentialPath = process.env.FIREBASE_ADMIN_CREDENTIAL_PATH;

if (credentialPath) {
  const serviceAccount = require(credentialPath);
  admin.initializeApp({
    credential: admin.cert(serviceAccount),
    projectId: serviceAccount.project_id,
    databaseURL: 'https://talkapp55-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
} else if (clientEmail && privateKey) {
  admin.initializeApp({
    credential: admin.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
    databaseURL: 'https://talkapp55-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
} else {
  console.error(
    'ERROR: No Firebase Admin credentials found.\n' +
    'Set FIREBASE_ADMIN_CREDENTIAL_PATH to your service account JSON file path,\n' +
    'or set FIREBASE_ADMIN_CLIENT_EMAIL and FIREBASE_ADMIN_PRIVATE_KEY environment variables.'
  );
  process.exit(1);
}

const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase();

async function deleteAllAccounts() {
  // --- Step 1: List all Firebase Auth users ---
  console.log('Fetching all Firebase Auth users...');
  const userRecords = [];
  let pageToken = undefined;

  do {
    const result = await auth.listUsers(1000, pageToken);
    userRecords.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  console.log(`Found ${userRecords.length} user(s) in Firebase Auth.`);
  for (const u of userRecords) console.log('  ', u.email);

  // --- Step 2: Delete all Firestore documents from ALL collections ---
  console.log('\nScanning Firestore collections...');
  const allCollections = await db.listCollections();
  let firestoreDeleted = 0;

  for (const col of allCollections) {
    console.log(`Deleting all documents from Firestore collection: ${col.id}`);
    const snapshot = await col.get();
    const batchSize = 400;
    const docs = snapshot.docs;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + batchSize);
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
    console.log(`  Deleted ${docs.length} document(s) from ${col.id}`);
    firestoreDeleted += docs.length;
  }

  console.log(`Deleted ${firestoreDeleted} Firestore document(s) total.`);

  // --- Step 3: Delete all Realtime Database data ---
  console.log('\nClearing Realtime Database...');
  const rtdbSnap = await rtdb.ref().once('value');
  const rtdbVal = rtdbSnap.val();
  if (rtdbVal) {
    const keys = Object.keys(rtdbVal);
    console.log('RTDB top-level keys:', keys.join(', '));
    for (const key of keys) {
      await rtdb.ref(key).remove();
      console.log(`  Removed RTDB key: ${key}`);
    }
  } else {
    console.log('RTDB is already empty.');
  }

  // --- Step 4: Delete all Firebase Auth users ---
  console.log('\nDeleting all Firebase Auth users...');
  const uids = userRecords.map(u => u.uid);

  for (let i = 0; i < uids.length; i += 1000) {
    const chunk = uids.slice(i, i + 1000);
    const result = await auth.deleteUsers(chunk);
    console.log(`  Deleted ${result.successCount} user(s), ${result.failureCount} failure(s)`);
    if (result.errors && result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`  Error: index ${err.index} — ${err.error.message}`);
      }
    }
  }

  // --- Step 5: Verify everything is gone ---
  console.log('\n--- VERIFICATION ---');
  const verifyAuth = await auth.listUsers(1000);
  const verifyCollections = await db.listCollections();
  let verifyFsCount = 0;
  for (const col of verifyCollections) {
    const snap = await col.get();
    verifyFsCount += snap.size;
  }
  const verifyRtdb = await rtdb.ref().once('value');
  console.log('Auth users remaining:', verifyAuth.users.length);
  console.log('Firestore documents remaining:', verifyFsCount);
  console.log('RTDB remaining:', verifyRtdb.val() ? JSON.stringify(Object.keys(verifyRtdb.val())) : 'empty');

  console.log(`\nDone! Deleted ${uids.length} Firebase Auth user(s), ${firestoreDeleted} Firestore document(s), and all RTDB data.`);
  console.log('WARNING: This action was irreversible. All user data has been permanently removed.');
}

deleteAllAccounts()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
