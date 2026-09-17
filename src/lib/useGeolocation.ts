import { useEffect, useRef, useState } from 'react';

export interface GeolocationState {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  updatedAt: number | null;
  error: string | null;
  supported: boolean;
}

/**
 * Continuously tracks the device's real GPS position via watchPosition (not a
 * one-off getCurrentPosition call), so the returned lat/lng keeps changing as
 * the user actually moves — this is what "live location" means for the heatmap.
 */
export function useGeolocation(enabled: boolean) {
  const [state, setState] = useState<GeolocationState>({
    lat: null, lng: null, accuracy: null, updatedAt: null, error: null,
    supported: typeof navigator !== 'undefined' && 'geolocation' in navigator,
  });
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !state.supported) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setState((prev) => ({
          ...prev,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          updatedAt: Date.now(),
          error: null,
        }));
      },
      (err) => {
        setState((prev) => ({ ...prev, error: err.message }));
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 }
    );

    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state.supported]);

  return state;
}
