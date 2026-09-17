import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import * as L from 'leaflet';
import { LiveCrimeMap, type CrimePoint } from '@/lib/live-crime-map';
import { INCIDENT_TYPES, RISK_COLOR, RISK_LABEL, type Incident, type RiskLevel } from '@/data/incidents';
import { percentToLatLng, latLngToPercent, CENTER } from '@/lib/geo';
import { useLiveLocation } from '@/context/LocationContext';
import type { RoutePoint } from './MapView';

interface LiveCrimeMapViewProps {
  incidents: Incident[];
  height?: string;
  onMapClick?: (pos: { x: number; y: number }) => void;
  pin?: { x: number; y: number } | null;
  route?: { start: RoutePoint; end: RoutePoint } | null;
  selectedIncidentId?: string | null;
  onSelectIncident?: (id: string) => void;
  showHeatmap?: boolean;
  /** When true, shows this device's real GPS position (from LocationContext,
   * backed by navigator.geolocation.watchPosition — not simulated) plus any
   * other real users currently sharing their location, each scored with the
   * module's own live risk math. Independent of the simulated `route` walk. */
  useRealLocation?: boolean;
  onRealLocationError?: (message: string) => void;
}

function riskToIntensity(risk: RiskLevel) {
  return risk === 'high' ? 0.95 : risk === 'medium' ? 0.6 : 0.3;
}

function scoreToRisk(score: number): RiskLevel {
  return score > 0.66 ? 'high' : score > 0.33 ? 'medium' : 'low';
}

function toCrimePoints(incidents: Incident[]): CrimePoint[] {
  return incidents.map((inc) => {
    const p = percentToLatLng(inc.x, inc.y);
    return {
      lat: p.lat,
      lng: p.lng,
      intensity: riskToIntensity(inc.risk),
      type: inc.type,
      timestamp: Date.now() - inc.hoursAgo * 3600 * 1000,
    };
  });
}

/**
 * Host-app wrapper around the LiveCrimeMap module (src/lib/live-crime-map.ts).
 * Uses that class's own public interface (setCrimeData / travel / stopTravel /
 * getMap / setHeatmapVisible) — no OSRM/Leaflet logic lives here, only wiring
 * to the app's existing incidents + Safe Route state.
 */
export default function LiveCrimeMapView({
  incidents, height = '100%', onMapClick, pin, route, selectedIncidentId, onSelectIncident, showHeatmap = true,
  useRealLocation = false, onRealLocationError,
}: LiveCrimeMapViewProps) {
  const rawId = useId();
  const containerId = `live-crime-map-${rawId.replace(/[:]/g, '')}`;
  const instanceRef = useRef<LiveCrimeMap | null>(null);
  const incidentMarkersRef = useRef<L.CircleMarker[]>([]);
  const pinMarkerRef = useRef<L.Marker | null>(null);
  const realMarkerRef = useRef<L.CircleMarker | null>(null);
  const otherLiveMarkersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const hasCenteredOnRealLocation = useRef(false);
  const [liveStatus, setLiveStatus] = useState<{ risk: RiskLevel; arrived: boolean } | null>(null);
  const [realLocationRisk, setRealLocationRisk] = useState<RiskLevel | null>(null);

  // Real GPS: watchPosition-backed, and (if Firebase is configured) synced
  // across devices in real time — see LocationContext. Not a simulation.
  const { myLocation, liveLocations, error: geoError, supported: geoSupported } = useLiveLocation();

  // Init once, feeding real incident data synchronously before the browser
  // ever paints — so the module's built-in random sample data is replaced
  // before it's visible, not swapped in a frame later.
  useLayoutEffect(() => {
    const inst = new LiveCrimeMap(containerId, CENTER, 13);
    instanceRef.current = inst;
    inst.setCrimeData(toCrimePoints(incidents));
    inst.setHeatmapVisible(showHeatmap);
    return () => {
      inst.destroy();
      instanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  // Heatmap on/off toggle.
  useEffect(() => {
    instanceRef.current?.setHeatmapVisible(showHeatmap);
  }, [showHeatmap]);

  // Click-to-drop-pin.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const map = inst.getMap();
    if (!onMapClick) return;
    const handler = (e: L.LeafletMouseEvent) => onMapClick(latLngToPercent(e.latlng.lat, e.latlng.lng));
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [onMapClick, containerId]);

  // Keep the module's crime data in sync as the app's live incident feed changes
  // (drives both the heatmap AND the on-road risk score used while traveling).
  useEffect(() => {
    instanceRef.current?.setCrimeData(toCrimePoints(incidents));
  }, [incidents]);

  // Clickable incident markers on top of the heatmap (independent layer,
  // so selection/highlighting works regardless of heatmap visibility).
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const map = inst.getMap();
    incidentMarkersRef.current.forEach((m) => map.removeLayer(m));
    incidentMarkersRef.current = incidents.map((inc) => {
      const p = percentToLatLng(inc.x, inc.y);
      const selected = inc.id === selectedIncidentId;
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: selected ? 9 : 6,
        color: '#ffffff',
        weight: selected ? 2.5 : 1,
        fillColor: RISK_COLOR[inc.risk],
        fillOpacity: 0.9,
      }).addTo(map);
      marker.on('click', () => onSelectIncident?.(inc.id));
      const meta = INCIDENT_TYPES.find((t) => t.value === inc.type);
      marker.bindTooltip(`${meta?.emoji ?? ''} ${inc.title}`, { direction: 'top', offset: [0, -6] });
      return marker;
    });
    return () => { incidentMarkersRef.current.forEach((m) => map.removeLayer(m)); };
  }, [incidents, selectedIncidentId, onSelectIncident, containerId]);

  // Dropped pin.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const map = inst.getMap();
    if (pinMarkerRef.current) {
      map.removeLayer(pinMarkerRef.current);
      pinMarkerRef.current = null;
    }
    if (pin) {
      const p = percentToLatLng(pin.x, pin.y);
      pinMarkerRef.current = L.marker([p.lat, p.lng]).addTo(map);
    }
  }, [pin, containerId]);

  // Surface real GPS errors/unsupported-browser state to the host page.
  useEffect(() => {
    if (!useRealLocation) return;
    if (!geoSupported) onRealLocationError?.('Geolocation is not supported in this browser.');
    else if (geoError) onRealLocationError?.(geoError);
  }, [useRealLocation, geoSupported, geoError, onRealLocationError]);

  // Real "you are here" dot — driven by the device's actual GPS fix
  // (LocationContext / navigator.geolocation.watchPosition), scored with
  // the module's own risk math via getRiskAt, not a simulation.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const map = inst.getMap();

    if (!useRealLocation || !myLocation) {
      if (realMarkerRef.current) {
        map.removeLayer(realMarkerRef.current);
        realMarkerRef.current = null;
      }
      setRealLocationRisk(null);
      return;
    }

    const p = percentToLatLng(myLocation.x, myLocation.y);
    const risk = scoreToRisk(inst.getRiskAt(p));
    setRealLocationRisk(risk);

    if (!realMarkerRef.current) {
      realMarkerRef.current = L.circleMarker([p.lat, p.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: RISK_COLOR[risk],
        fillOpacity: 1,
      }).addTo(map).bindTooltip('You (live GPS)', { direction: 'top', offset: [0, -8] });
    } else {
      realMarkerRef.current.setLatLng([p.lat, p.lng]);
      realMarkerRef.current.setStyle({ fillColor: RISK_COLOR[risk] });
    }

    if (!hasCenteredOnRealLocation.current) {
      map.setView([p.lat, p.lng], 15);
      hasCenteredOnRealLocation.current = true;
    }
  }, [useRealLocation, myLocation, containerId]);

  // Other real users currently sharing their live location (Firestore-backed,
  // see LocationContext) — a genuine crowd view, not synthetic data.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    const map = inst.getMap();
    const seen = new Set<string>();

    if (useRealLocation) {
      for (const loc of liveLocations) {
        seen.add(loc.id);
        const p = percentToLatLng(loc.x, loc.y);
        const existing = otherLiveMarkersRef.current.get(loc.id);
        if (existing) {
          existing.setLatLng([p.lat, p.lng]);
        } else {
          const marker = L.circleMarker([p.lat, p.lng], {
            radius: 6, color: '#ffffff', weight: 2, fillColor: '#8b5cf6', fillOpacity: 0.9,
          }).addTo(map).bindTooltip('Nearby Safora user', { direction: 'top', offset: [0, -6] });
          otherLiveMarkersRef.current.set(loc.id, marker);
        }
      }
    }

    // Drop markers for users no longer present (or when the toggle is off).
    for (const [id, marker] of otherLiveMarkersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(marker);
        otherLiveMarkersRef.current.delete(id);
      }
    }
  }, [useRealLocation, liveLocations, containerId]);

  // Safe Route -> travel() along the real road, live risk score as it moves.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    if (!route) {
      inst.stopTravel();
      setLiveStatus(null);
      return;
    }
    const origin = percentToLatLng(route.start.x, route.start.y);
    const destination = percentToLatLng(route.end.x, route.end.y);
    setLiveStatus(null);
    inst.travel(origin, destination, {
      speedMetersPerSec: 15,
      updateIntervalMs: 400,
      useRealRouting: true,
      onPositionUpdate: (_pos, riskScore) => setLiveStatus({ risk: scoreToRisk(riskScore), arrived: false }),
      onArrive: () => setLiveStatus((prev) => (prev ? { ...prev, arrived: true } : { risk: 'low', arrived: true })),
    });
    return () => { inst.stopTravel(); };
  }, [route]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div id={containerId} className="h-full w-full" />

      {/* Live on-road risk readout while traveling — mirrors the module's onPositionUpdate callback */}
      {route && liveStatus && (
        <div
          className="pointer-events-none absolute left-4 top-4 z-[1000] rounded-lg border border-white/10 bg-black/80 px-3 py-2 text-[11px] font-semibold backdrop-blur-sm"
          style={{ color: RISK_COLOR[liveStatus.risk] }}
        >
          {liveStatus.arrived ? 'Arrived' : `Live on-road risk: ${RISK_LABEL[liveStatus.risk]}`}
        </div>
      )}

      {/* Real GPS risk readout — only shown when tracking the device's actual location */}
      {useRealLocation && realLocationRisk && (
        <div
          className="pointer-events-none absolute left-4 top-4 z-[1000] rounded-lg border border-white/10 bg-black/80 px-3 py-2 text-[11px] font-semibold backdrop-blur-sm"
          style={{ color: RISK_COLOR[realLocationRisk] }}
        >
          Your live risk: {RISK_LABEL[realLocationRisk]}
        </div>
      )}
      {useRealLocation && !myLocation && geoSupported && !geoError && (
        <div className="pointer-events-none absolute left-4 top-4 z-[1000] rounded-lg border border-white/10 bg-black/80 px-3 py-2 text-[11px] text-gray-300 backdrop-blur-sm">
          Getting your location…
        </div>
      )}
    </div>
  );
}
