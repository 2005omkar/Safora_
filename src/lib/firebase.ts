import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged, type Auth } from 'firebase/auth';

// ─── Firebase config ────────────────────────────────────────────────────────
// Values are read from Vite env vars (see .env.example). Create a `.env`
// file in the project root with your project's config — get these from
// Firebase Console → Project settings → General → "Your apps" → SDK config.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app: FirebaseApp | null = null;
let dbInstance: Firestore | null = null;
let authInstance: Auth | null = null;

if (firebaseEnabled) {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  dbInstance = getFirestore(app);
  authInstance = getAuth(app);
} else {
  // No .env configured yet — the app keeps working on local mock data
  // (see ReportsContext/LocationContext) instead of crashing.
  console.warn(
    '[firebase] VITE_FIREBASE_* env vars are missing — running with local mock data. ' +
    'Copy .env.example to .env and fill in your Firebase project config to enable live sync.'
  );
}

export const db = dbInstance;
export const auth = authInstance;

// Stable per-device id used to key each browser's live-location document.
// We sign in anonymously so Firestore security rules can require
// `request.auth.uid == <the document id being written>` — this ONLY works
// if writes actually happen under that resolved uid, so callers should
// prefer `getResolvedUid()` (waits for auth) over the synchronous fallback
// below for anything that touches Firestore.
let cachedDeviceId: string | null = null;
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = localStorage.getItem('safora-device-id');
  if (existing) {
    cachedDeviceId = existing;
    return existing;
  }
  const fresh = `device-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  localStorage.setItem('safora-device-id', fresh);
  cachedDeviceId = fresh;
  return fresh;
}

let anonAuthStarted = false;
let resolvedUidPromise: Promise<string | null> | null = null;

/** Kicks off (once) anonymous sign-in if no session exists yet. */
export function ensureAnonymousAuth() {
  if (!authInstance || anonAuthStarted) return;
  anonAuthStarted = true;
  onAuthStateChanged(authInstance, (user) => {
    if (!user) {
      signInAnonymously(authInstance!).catch((err) => {
        console.warn('[firebase] anonymous sign-in failed:', err.message);
      });
    } else {
      cachedDeviceId = user.uid;
    }
  });
}

/**
 * Resolves to the REAL authenticated uid (anonymous or signed-in), or null
 * if Firebase isn't configured / auth never resolves. Security rules key
 * writes on `request.auth.uid`, so anything writing to Firestore under a
 * per-user document id must wait on this instead of the synchronous,
 * localStorage-only `getDeviceId()` fallback — otherwise the doc id and
 * the authenticated uid can mismatch and every write gets rejected (or,
 * worse, a looser rule would let a client pick an arbitrary id to write
 * to storage that isn't really theirs).
 */
export function getResolvedUid(): Promise<string | null> {
  if (!authInstance) return Promise.resolve(null);
  if (resolvedUidPromise) return resolvedUidPromise;
  resolvedUidPromise = new Promise((resolve) => {
    const unsub = onAuthStateChanged(authInstance!, (user) => {
      if (user) {
        unsub();
        resolve(user.uid);
      }
    });
  });
  return resolvedUidPromise;
}
