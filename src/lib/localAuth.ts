/**
 * A real, functioning authentication system that needs no backend — used
 * whenever Firebase isn't configured (see .env.example / firebaseEnabled).
 *
 * This is NOT a substitute for the Firebase Auth path in production: it's a
 * single-browser "account database" stored in localStorage. It genuinely
 * checks credentials (wrong password is rejected, unknown email is
 * rejected, duplicate sign-up is rejected, sessions persist across
 * reloads) — but anyone with devtools access to THIS browser can read or
 * edit that localStorage data directly. Treat it as: real enough to build
 * and test a real login flow against, not real enough to gate anything
 * that actually needs to survive a hostile client. Once Firebase is
 * configured, AuthContext switches to the real Firebase Auth path
 * automatically and this module isn't used at all.
 */

const USERS_KEY = 'safora-local-users';
const SESSION_KEY = 'safora-local-session';

interface StoredUser {
  uid: string;
  email: string; // normalized (lowercased, trimmed)
  displayName: string;
  role: string;
  passwordHash: string;
  salt: string;
}

export interface LocalSessionUser {
  uid: string;
  email: string;
  displayName: string;
  role: string;
}

function readUsers(): StoredUser[] {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    return raw ? (JSON.parse(raw) as StoredUser[]) : [];
  } catch {
    return [];
  }
}

function writeUsers(users: StoredUser[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${password}`));
  return bytesToHex(digest);
}

function randomSalt(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return bytesToHex(arr.buffer);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function localSignUp(
  email: string, password: string, displayName: string, role: string
): Promise<LocalSessionUser> {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) throw new Error('That email address looks invalid.');
  if (password.length < 6) throw new Error('Choose a password with at least 6 characters.');

  const users = readUsers();
  if (users.some((u) => u.email === normalized)) {
    throw new Error('An account already exists for that email.');
  }

  const salt = randomSalt();
  const passwordHash = await hashPassword(password, salt);
  const user: StoredUser = {
    uid: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email: normalized,
    displayName: displayName.trim().slice(0, 80) || normalized.split('@')[0],
    role,
    passwordHash,
    salt,
  };
  writeUsers([...users, user]);
  localStorage.setItem(SESSION_KEY, user.uid);
  return { uid: user.uid, email: user.email, displayName: user.displayName, role: user.role };
}

export async function localSignIn(email: string, password: string): Promise<LocalSessionUser> {
  const normalized = normalizeEmail(email);
  const users = readUsers();
  const user = users.find((u) => u.email === normalized);
  // Deliberately identical error for "no such account" and "wrong password"
  // — same as real auth systems — so a login form can't be used to probe
  // which emails have an account.
  if (!user) throw new Error('Incorrect email or password.');
  const attemptHash = await hashPassword(password, user.salt);
  if (attemptHash !== user.passwordHash) throw new Error('Incorrect email or password.');

  localStorage.setItem(SESSION_KEY, user.uid);
  return { uid: user.uid, email: user.email, displayName: user.displayName, role: user.role };
}

export function localSignOut(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Restores a persisted session on page load, same as Firebase Auth would. */
export function getLocalSessionUser(): LocalSessionUser | null {
  const uid = localStorage.getItem(SESSION_KEY);
  if (!uid) return null;
  const user = readUsers().find((u) => u.uid === uid);
  if (!user) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
  return { uid: user.uid, email: user.email, displayName: user.displayName, role: user.role };
}
