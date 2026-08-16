import { initializeApp } from 'firebase/app';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, updateProfile, signOut, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail
} from 'firebase/auth';
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  deleteDoc, query, where, onSnapshot, orderBy, serverTimestamp
} from 'firebase/firestore';
import {
  getDatabase, ref, push, set, get, query as rtdbQuery,
  orderByChild, limitToLast, onValue, remove, update,
  serverTimestamp as rtdbServerTimestamp
} from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyBMu4ZWTCO9of_2DbZTmCqruTYTIfFagJk",
  authDomain: "talkapp55.firebaseapp.com",
  databaseURL: "https://talkapp55-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "talkapp55",
  storageBucket: "talkapp55.firebasestorage.app",
  messagingSenderId: "234601517663",
  appId: "1:234601517663:web:da3d670bc8e550d4f241ea",
  measurementId: "G-W4DXV6VPCF"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, updateProfile, signOut, onAuthStateChanged,
  signInWithPopup, sendPasswordResetEmail,
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, where, onSnapshot, orderBy, serverTimestamp,
  ref, push, set, get, rtdbQuery, orderByChild, limitToLast,
  onValue, remove, update, rtdbServerTimestamp
};
