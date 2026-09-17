import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile,
  onAuthStateChanged, signOut as firebaseSignOut, type User as FirebaseUser,
} from 'firebase/auth';
import { auth, firebaseEnabled } from '@/lib/firebase';
import { localSignIn, localSignUp, localSignOut, getLocalSessionUser } from '@/lib/localAuth';

export type UserRole = 'resident' | 'business' | 'law-enforcement';

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
}

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  /** True when using the local (no-backend) auth system instead of real
   *  Firebase Auth — surfaced so the UI can be honest about which mode
   *  it's in, e.g. on the login screen. */
  usingLocalAuth: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string, role: UserRole) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Firebase Auth has no built-in arbitrary "role" field, so we keep that one
// bit of app-specific profile data locally, keyed by the real uid. It's not
// sensitive (it only controls which dashboard view a user sees) — anything
// that actually needs to be trust-checked server-side (e.g. real
// law-enforcement access) has to be enforced in Firestore rules / a backend,
// never by a value that lives in the browser.
const ROLE_KEY_PREFIX = 'safora-role:';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Firebase path: real Firebase Auth, session persisted by the SDK.
  useEffect(() => {
    if (!firebaseEnabled || !auth) return;
    const unsub = onAuthStateChanged(auth, (fbUser: FirebaseUser | null) => {
      // Ignore anonymous sessions here — those are LocationContext's device
      // identity for live-location sharing, not a "signed in user" for the
      // purposes of gating pages like /profile or /report.
      if (fbUser && !fbUser.isAnonymous) {
        const role = (localStorage.getItem(ROLE_KEY_PREFIX + fbUser.uid) as UserRole | null) ?? 'resident';
        setUser({
          uid: fbUser.uid,
          email: fbUser.email ?? '',
          displayName: fbUser.displayName || fbUser.email?.split('@')[0] || 'User',
          role,
        });
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  // Local path (no Firebase project configured): restore any persisted
  // local session on first load, same as Firebase's own persistence would.
  useEffect(() => {
    if (firebaseEnabled) return;
    const local = getLocalSessionUser();
    if (local) {
      const role = (localStorage.getItem(ROLE_KEY_PREFIX + local.uid) as UserRole | null) ?? (local.role as UserRole);
      setUser({ uid: local.uid, email: local.email, displayName: local.displayName, role });
    }
    setLoading(false);
  }, []);

  async function signIn(email: string, password: string) {
    setLoading(true);
    try {
      if (firebaseEnabled && auth) {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        const local = await localSignIn(email, password);
        const role = (localStorage.getItem(ROLE_KEY_PREFIX + local.uid) as UserRole | null) ?? (local.role as UserRole);
        setUser({ uid: local.uid, email: local.email, displayName: local.displayName, role });
      }
    } finally {
      setLoading(false);
    }
  }

  async function signUp(email: string, password: string, displayName: string, role: UserRole) {
    setLoading(true);
    try {
      if (firebaseEnabled && auth) {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        const name = displayName.trim().slice(0, 80) || email.split('@')[0];
        await updateProfile(cred.user, { displayName: name });
        localStorage.setItem(ROLE_KEY_PREFIX + cred.user.uid, role);
        setUser({ uid: cred.user.uid, email: cred.user.email ?? email, displayName: name, role });
      } else {
        const local = await localSignUp(email, password, displayName, role);
        localStorage.setItem(ROLE_KEY_PREFIX + local.uid, role);
        setUser({ uid: local.uid, email: local.email, displayName: local.displayName, role });
      }
    } finally {
      setLoading(false);
    }
  }

  function signOut() {
    if (firebaseEnabled && auth) firebaseSignOut(auth).catch(() => {});
    else localSignOut();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, usingLocalAuth: !firebaseEnabled, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

/** Maps common Firebase Auth error codes to messages safe to show a user
 *  (never echoes raw Firebase error text, which can leak implementation
 *  details or, for some codes, hint whether an email is registered). */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (!code) {
    // No Firebase error code means this came from our own thrown Error
    // (local auth validation, e.g. "Incorrect email or password") — safe
    // to show verbatim since we wrote it ourselves.
    return err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.';
  }
  switch (code) {
    case 'auth/invalid-email': return 'That email address looks invalid.';
    case 'auth/user-disabled': return 'This account has been disabled.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Incorrect email or password.';
    case 'auth/email-already-in-use': return 'An account already exists for that email.';
    case 'auth/weak-password': return 'Choose a password with at least 6 characters.';
    case 'auth/too-many-requests': return 'Too many attempts — please wait a moment and try again.';
    case 'auth/network-request-failed': return 'Network error — check your connection and try again.';
    default: return 'Something went wrong. Please try again.';
  }
}
