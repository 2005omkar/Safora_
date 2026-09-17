import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp, query, where, Timestamp,
} from 'firebase/firestore';
import { db, firebaseEnabled, ensureAnonymousAuth, getResolvedUid } from '@/lib/firebase';
import { latLngToPercent, isWithinMapBounds } from '@/lib/geo';
import { useGeolocation } from '@/lib/useGeolocation';
import { useSettings } from '@/context/SettingsContext';

export interface LiveLocationPoint {
  id: string;
  x: number;
  y: number;
  updatedAt: number;
}

interface LocationContextValue {
  /** This device's own GPS fix, converted to the map's 0-100 percent space. Null until a fix is available or the point falls outside the mapped city. */
  myLocation: { x: number; y: number } | null;
  /** Raw lat/lng from the browser, for display/debugging. */
  coords: { lat: number | null; lng: number | null; accuracy: number | null };
  /** Everyone else's live positions currently in Firestore (stale entries older than 2 min are filtered out). Feeds the live heatmap. */
  liveLocations: LiveLocationPoint[];
  error: string | null;
  supported: boolean;
  sharing: boolean;
}

const LocationContext = createContext<LocationContextValue | undefined>(undefined);

const STALE_MS = 2 * 60 * 1000; // drop presence docs older than 2 minutes
const WRITE_THROTTLE_MS = 8_000; // don't hammer Firestore on every GPS tick

export function LocationProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const geo = useGeolocation(true);
  const [liveLocations, setLiveLocations] = useState<LiveLocationPoint[]>([]);
  const lastWriteRef = useRef(0);
  // The doc id we actually write/read under must be the REAL authenticated
  // uid — Firestore rules require `request.auth.uid == docId`, so writing
  // under any other id (e.g. a bare localStorage string before auth
  // resolves) would simply be rejected server-side. Cached once resolved.
  const uidRef = useRef<string | null>(null);

  useEffect(() => {
    if (firebaseEnabled) ensureAnonymousAuth();
  }, []);

  const myLocation = geo.lat != null && geo.lng != null && isWithinMapBounds(geo.lat, geo.lng)
    ? latLngToPercent(geo.lat, geo.lng)
    : null;

  // Push this device's position to Firestore so every connected client's
  // heatmap reflects where people actually are, in real time.
  useEffect(() => {
    if (!firebaseEnabled || !db || !settings.liveLocationSharing) return;
    if (geo.lat == null || geo.lng == null) return;
    const now = Date.now();
    if (now - lastWriteRef.current < WRITE_THROTTLE_MS) return;
    lastWriteRef.current = now;

    let cancelled = false;
    getResolvedUid().then((uid) => {
      if (cancelled || !uid || !db) return;
      uidRef.current = uid;
      const ref = doc(db, 'liveLocations', uid);
      setDoc(ref, {
        lat: geo.lat,
        lng: geo.lng,
        accuracy: geo.accuracy,
        updatedAt: serverTimestamp(),
      }, { merge: true }).catch((err) => console.warn('[location] failed to sync:', err.message));
    });
    return () => { cancelled = true; };
  }, [geo.lat, geo.lng, geo.accuracy, settings.liveLocationSharing]);

  // Stop broadcasting immediately if the user turns sharing off.
  useEffect(() => {
    if (!firebaseEnabled || !db || settings.liveLocationSharing) return;
    getResolvedUid().then((uid) => {
      if (!uid || !db) return;
      deleteDoc(doc(db, 'liveLocations', uid)).catch(() => {});
    });
  }, [settings.liveLocationSharing]);

  // Subscribe to everyone's live position (Firestore keeps this current —
  // this listener is what makes the heatmap update as people move instead
  // of only reflecting the incidents that existed on first page load).
  useEffect(() => {
    if (!firebaseEnabled || !db) return;
    const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS);
    const q = query(collection(db, 'liveLocations'), where('updatedAt', '>', cutoff));
    const unsub = onSnapshot(q, (snap) => {
      const points: LiveLocationPoint[] = [];
      snap.forEach((d) => {
        if (d.id === uidRef.current) return; // don't double-count our own marker
        const data = d.data() as { lat: number; lng: number; updatedAt?: Timestamp };
        if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
        if (!isWithinMapBounds(data.lat, data.lng)) return;
        const pos = latLngToPercent(data.lat, data.lng);
        points.push({ id: d.id, ...pos, updatedAt: data.updatedAt?.toMillis() ?? Date.now() });
      });
      setLiveLocations(points);
    }, (err) => console.warn('[location] live sync error:', err.message));
    return unsub;
  }, []);

  return (
    <LocationContext.Provider value={{
      myLocation,
      coords: { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy },
      liveLocations,
      error: geo.error,
      supported: geo.supported,
      sharing: firebaseEnabled && settings.liveLocationSharing,
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLiveLocation() {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLiveLocation must be inside LocationProvider');
  return ctx;
}
