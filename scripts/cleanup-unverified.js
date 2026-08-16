/**
 * Cleanup script: deletes unverified Firebase users and "lol" named contacts.
 *
 * What this does:
 *   1. Lists all Firebase Auth users and deletes any whose emailVerified is false.
 *   2. Removes their document from Firestore (users collection).
 *   3. Removes their entry from Realtime Database (users/{uid}).
 *   4. Deletes any contact documents whose name contains "lol" (case-insensitive)
 *      from ALL users' contacts subcollections.
 *
 * Usage:
 *   node scripts/cleanup-unverified.js
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'src', 'talkapp55-firebase-adminsdk-fbsvc-44c0ccdcaa.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('ERROR: Service account file not found at', SERVICE_ACCOUNT_PATH);
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);
admin.initializeApp({
  credential: admin.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: 'https://talkapp55-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase();

async function cleanupUnverified() {
  // --- Step 1: Find and delete unverified Firebase Auth users ---
  console.log('Fetching all Firebase Auth users...');
  const userRecords = [];
  let pageToken = undefined;

  do {
    const result = await auth.listUsers(1000, pageToken);
    userRecords.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  console.log(`Found ${userRecords.length} user(s) in Firebase Auth.`);
  const unverified = userRecords.filter(u => !u.emailVerified);
  const verified = userRecords.filter(u => u.emailVerified);

  console.log(`\nVerified users (${verified.length}):`);
  verified.forEach(u => console.log('  ✓', u.email));

  console.log(`\nUnverified users (${unverified.length}):`);
  unverified.forEach(u => console.log('  ✗', u.email));

  if (unverified.length > 0) {
    console.log('\nDeleting unverified users from Firebase Auth...');
    const uids = unverified.map(u => u.uid);
    const result = await auth.deleteUsers(uids);
    console.log(`  Deleted ${result.successCount} user(s), ${result.failureCount} failure(s)`);
    if (result.errors && result.errors.length > 0) {
      result.errors.forEach(err => console.error('  Error:', err.error.message));
    }

    // Delete from Firestore
    console.log('Deleting unverified users from Firestore...');
    for (const u of unverified) {
      try {
        await db.doc('users/' + u.uid).delete();
        console.log('  Deleted Firestore doc for', u.email);
      } catch (err) {
        console.error('  Firestore delete error for', u.email, ':', err.message);
      }
    }

    // Delete from RTDB
    console.log('Deleting unverified users from Realtime Database...');
    for (const u of unverified) {
      try {
        await rtdb.ref('users/' + u.uid).remove();
        console.log('  Removed RTDB entry for', u.email);
      } catch (err) {
        console.error('  RTDB delete error for', u.email, ':', err.message);
      }
    }
  } else {
    console.log('\nNo unverified users to delete.');
  }

  // --- Step 2: Delete "lol" named contacts from ALL users' contact lists ---
  console.log('\nScanning for "lol" contacts in Firestore...');
  const usersSnapshot = await db.collection('users').get();
  let lolContactsDeleted = 0;

  for (const userDoc of usersSnapshot.docs) {
    const contactsRef = userDoc.ref.collection('contacts');
    const contactsSnap = await contactsRef.get();
    for (const contactDoc of contactsSnap.docs) {
      const contactData = contactDoc.data();
      const name = (contactData.name || '').toLowerCase();
      if (name.includes('lol')) {
        console.log('  Deleting contact "' + contactData.name + '" (' + contactData.email + ') from user', userDoc.id);
        await contactDoc.ref.delete();
        lolContactsDeleted++;
      }
    }
  }

  if (lolContactsDeleted === 0) {
    console.log('  No "lol" contacts found.');
  } else {
    console.log(`  Deleted ${lolContactsDeleted} "lol" contact(s).`);
  }

  // --- Step 3: Also check RTDB users for "lol" names and clean up userChats ---
  console.log('\nScanning RTDB users for "lol" names...');
  const rtdbSnap = await rtdb.ref('users').once('value');
  if (rtdbSnap.exists()) {
    const lolEmails = [];
    rtdbSnap.forEach((child) => {
      const data = child.val();
      if ((data.name || '').toLowerCase().includes('lol')) {
        lolEmails.push({ uid: child.key, email: data.email, name: data.name });
      }
    });
    if (lolEmails.length > 0) {
      console.log('  Found "lol" named users in RTDB:', lolEmails);
      for (const u of lolEmails) {
        await rtdb.ref('users/' + u.uid).remove();
        console.log('  Removed RTDB user', u.email);
      }
    } else {
      console.log('  No "lol" named users in RTDB.');
    }
  }

  // --- Step 4: Verify ---
  console.log('\n--- VERIFICATION ---');
  const verifyAuth = await auth.listUsers(1000);
  const unverifiedRemaining = verifyAuth.users.filter(u => !u.emailVerified);
  console.log('Total Auth users remaining:', verifyAuth.users.length);
  console.log('Unverified users remaining:', unverifiedRemaining.length);

  console.log('\nDone!');
}

cleanupUnverified()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
