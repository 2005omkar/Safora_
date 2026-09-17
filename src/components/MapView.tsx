import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { GoogleMap, useJsApiLoader, OverlayView, Polyline, HeatmapLayer} from '@react-google-maps/api';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Navigation, Radar } from 'lucide-react';
import { CITY_ZONES, INCIDENT_TYPES, RISK_COLOR, RISK_LABEL, type Incident, type RiskLevel } from '@/data/incidents';

export interface RoutePoint { x: number; y: number; label: string }

// How close (meters) an incident needs to be to a road segment / the live
// traveler to count as "on this stretch of road" when scoring live risk.
const ON_ROAD_RISK_RADIUS_M = 300;

interface MapViewProps {
  incidents: Incident[];
  height?: string;
  onMapClick?: (pos: { x: number; y: number }) => void;
  pin?: { x: number; y: number } | null;
  route?: { start: RoutePoint; end: RoutePoint } | null;
  selectedIncidentId?: string | null;
  onSelectIncident?: (id: string) => void;
  showZoneLabels?: boolean;
  showHeatmap?: boolean;
}

// FIX 1: Properly type the libraries array and keep it outside the component 
// to prevent infinite reloading loops.
// 'geometry' is required for spherical distance/interpolation/heading math used
// by the live traveler animation and on-road risk coloring below.
const LIBRARIES: ("visualization" | "geometry")[] = ['visualization', 'geometry'];

const MAP_BOUNDS = { north: 26.89, south: 26.75, west: 80.85, east: 81.05 };
const CENTER = { lat: 26.8467, lng: 80.9462 }; // Lucknow

function percentToLatLng(x: number, y: number) {
  return {
    lat: MAP_BOUNDS.north - (y / 100) * (MAP_BOUNDS.north - MAP_BOUNDS.south),
    lng: MAP_BOUNDS.west + (x / 100) * (MAP_BOUNDS.east - MAP_BOUNDS.west)
  };
}

function latLngToPercent(lat: number, lng: number) {
  const x = ((lng - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * 100;
  const y = ((MAP_BOUNDS.north - lat) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * 100;
  return { x, y };
}

const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#182427" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#4b6b66" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#14201f" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#1a2c2b" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#162322" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#101817" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#4b6b66" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] }
];

export default function MapView({
  incidents, height = '100%', onMapClick, pin, route, selectedIncidentId, onSelectIncident, showZoneLabels = true, showHeatmap = false
}: MapViewProps) {
  
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    // Read from env, never hardcode a real key in source — it ships in the
    // public JS bundle either way, so the only real protection is
    // restricting it by HTTP referrer in Google Cloud Console (see
    // SECURITY.md). A key that WAS hardcoded here previously should be
    // treated as leaked and rotated.
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '',
    version: '3.64',
    libraries: LIBRARIES,
  });
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const followRef = useRef(true);

  // ---- Live "person on the road" travel simulation ----------------------
  // When a route is active, we fetch the real road path (Google Directions),
  // then animate a moving dot along it — just like a live GPS location —
  // while coloring the road itself by nearby crime risk as the dot passes.
  const [roadPath, setRoadPath] = useState<google.maps.LatLng[] | null>(null);
  const [travelerPos, setTravelerPos] = useState<google.maps.LatLngLiteral | null>(null);
  const [travelerHeading, setTravelerHeading] = useState(0);
  const [travelProgress, setTravelProgress] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [trail, setTrail] = useState<google.maps.LatLngLiteral[]>([]);
  const [totalMeters, setTotalMeters] = useState(0);
  const [remainingMeters, setRemainingMeters] = useState(0);
  const [replayTick, setReplayTick] = useState(0);
  const [followTraveler, setFollowTraveler] = useState(true);
  const rafRef = useRef<number | null>(null);

  // Fetch the real on-road path between the two route points.
  useEffect(() => {
    if (!isLoaded || !window.google || !route) {
      setRoadPath(null);
      setTravelerPos(null);
      setArrived(false);
      setTrail([]);
      return;
    }
    let cancelled = false;
    const origin = percentToLatLng(route.start.x, route.start.y);
    const destination = percentToLatLng(route.end.x, route.end.y);

    const fallbackToStraightLine = () => {
      if (cancelled) return;
      setRoadPath([
        new window.google.maps.LatLng(origin.lat, origin.lng),
        new window.google.maps.LatLng(destination.lat, destination.lng),
      ]);
    };

    try {
      const service = new window.google.maps.DirectionsService();
      service.route(
        { origin, destination, travelMode: window.google.maps.TravelMode.WALKING },
        (result, status) => {
          if (cancelled) return;
          if (status === 'OK' && result?.routes?.[0]?.overview_path?.length) {
            setRoadPath(result.routes[0].overview_path);
          } else {
            fallbackToStraightLine();
          }
        }
      );
    } catch {
      fallbackToStraightLine();
    }
    return () => { cancelled = true; };
  }, [route, isLoaded]);

  // Animate the traveler dot along the fetched road path at a steady pace.
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (!roadPath || roadPath.length < 2 || !window.google) return;

    const geom = window.google.maps.geometry.spherical;
    const cumulative: number[] = [0];
    for (let i = 1; i < roadPath.length; i++) {
      cumulative.push(cumulative[i - 1] + geom.computeDistanceBetween(roadPath[i - 1], roadPath[i]));
    }
    const routeTotalMeters = cumulative[cumulative.length - 1] || 1;
    // Simulated walking pace: ~1.4 m/s, clamped so short/long routes both feel watchable.
    const durationMs = Math.min(45000, Math.max(7000, (routeTotalMeters / 1.4) * 90));

    setArrived(false);
    setTravelProgress(0);
    setTrail([]);
    setTotalMeters(routeTotalMeters);
    setRemainingMeters(routeTotalMeters);
    const startTime = performance.now();
    let lastUiUpdate = 0;
    let lastTrailUpdate = 0;
    let lastPan = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const targetDist = t * routeTotalMeters;
      let idx = 0;
      while (idx < cumulative.length - 2 && cumulative[idx + 1] < targetDist) idx++;
      const p1 = roadPath[idx];
      const p2 = roadPath[idx + 1] ?? p1;
      const segStart = cumulative[idx];
      const segEnd = cumulative[idx + 1] ?? segStart;
      const segT = segEnd > segStart ? (targetDist - segStart) / (segEnd - segStart) : 0;
      const pos = geom.interpolate(p1, p2, segT);
      const heading = geom.computeHeading(p1, p2);
      const liveLatLng = { lat: pos.lat(), lng: pos.lng() };

      // Throttle React state updates (~12/sec) — smooth enough, cheap enough.
      if (now - lastUiUpdate > 80 || t >= 1) {
        setTravelerPos(liveLatLng);
        setTravelerHeading(heading);
        setTravelProgress(t);
        setRemainingMeters(Math.max(0, routeTotalMeters - targetDist));
        lastUiUpdate = now;
      }
      // Leave a breadcrumb of the path already walked, like a live-tracking trail.
      if (now - lastTrailUpdate > 500 || t >= 1) {
        setTrail((prev) => [...prev, liveLatLng]);
        lastTrailUpdate = now;
      }
      // Keep the camera centered on the traveler, like live GPS navigation.
      if (followRef.current && mapRef.current && now - lastPan > 250) {
        mapRef.current.panTo(liveLatLng);
        lastPan = now;
      }
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setArrived(true);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [roadPath, replayTick]);

  // Score how dangerous the incident data says a given point on the road is,
  // weighting by how close the incident is and how recently it was reported —
  // not just a nearest-match check, so the "live crime rate" feels realistic.
  const scoreRiskNear = useCallback((point: google.maps.LatLng): { risk: RiskLevel; score: number } => {
    if (!window.google) return { risk: 'low', score: 0 };
    const geom = window.google.maps.geometry.spherical;
    let weighted = 0;
    for (const inc of incidents) {
      const p = percentToLatLng(inc.x, inc.y);
      const d = geom.computeDistanceBetween(point, new window.google.maps.LatLng(p.lat, p.lng));
      if (d >= ON_ROAD_RISK_RADIUS_M) continue;
      const proximity = 1 - d / ON_ROAD_RISK_RADIUS_M; // closer = stronger signal
      const severity = inc.risk === 'high' ? 3 : inc.risk === 'medium' ? 2 : 1;
      const recency = inc.hoursAgo < 24 ? 1.3 : inc.hoursAgo < 72 ? 1 : 0.7;
      weighted += proximity * severity * recency;
    }
    const score = Math.min(100, Math.round(weighted * 18));
    const risk: RiskLevel = score >= 55 ? 'high' : score >= 22 ? 'medium' : 'low';
    return { risk, score };
  }, [incidents]);

  // Break the road path into colored segments — a live "crime rate on this
  // road" layer, the same way Google colors roads by traffic congestion.
  const roadRiskSegments = useMemo(() => {
    if (!roadPath || roadPath.length < 2 || !window.google) return [];
    return roadPath.slice(1).map((p2, i) => {
      const p1 = roadPath[i];
      const mid = window.google.maps.geometry.spherical.interpolate(p1, p2, 0.5);
      return { path: [p1, p2], ...scoreRiskNear(mid) };
    });
  }, [roadPath, scoreRiskNear]);

  const currentRoad = useMemo(() => {
    if (!travelerPos || !window.google) return null;
    return scoreRiskNear(new window.google.maps.LatLng(travelerPos.lat, travelerPos.lng));
  }, [travelerPos, scoreRiskNear]);

  const heatmapData = useMemo(() => {
    if (!isLoaded || !window.google) return [];
    return incidents.map(inc => {
      const pos = percentToLatLng(inc.x, inc.y);
      return {
        location: new window.google.maps.LatLng(pos.lat, pos.lng),
        weight: inc.risk === 'high' ? 3 : inc.risk === 'medium' ? 2 : 1
      };
    });
  }, [incidents, isLoaded]);

  const onLoad = useCallback(function callback(map: google.maps.Map) {
    setMap(map);
    mapRef.current = map;
  }, []);

  const onUnmount = useCallback(function callback(map: google.maps.Map) {
    setMap(null);
    mapRef.current = null;
  }, []);

  useEffect(() => { followRef.current = followTraveler; }, [followTraveler]);

  function handleMapClick(e: google.maps.MapMouseEvent) {
    if (!onMapClick || !e.latLng) return;
    const { x, y } = latLngToPercent(e.latLng.lat(), e.latLng.lng());
    onMapClick({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }

  if (loadError) return <div className="flex items-center justify-center h-full w-full bg-red-900/20 text-red-400">Map failed to load</div>;
  if (!isLoaded) return <div className="w-full bg-[#182427] animate-pulse" style={{ height }} />;

  return (
    <div className="relative w-full" style={{ height }}>
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={CENTER}
        zoom={12}
        options={{
          styles: darkMapStyle,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: onMapClick ? 'greedy' : 'auto'
        }}
        onLoad={onLoad}
        onUnmount={onUnmount}
        onClick={handleMapClick}
      >
        {/* Zone Halos & Labels */}
        {CITY_ZONES.map((z) => {
          const zoneIncidents = incidents.filter((i) => i.zoneId === z.id);
          const highCount = zoneIncidents.filter((i) => i.risk === 'high').length;
          const risk = highCount >= 3 ? 'high' : highCount >= 1 ? 'medium' : z.baseRisk;
          
          return (
            <OverlayView
              key={z.id}
              position={percentToLatLng(z.x, z.y)}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
            >
              <div 
                className="absolute -translate-x-1/2 -translate-y-1/2 cursor-default"
                onMouseEnter={() => setHoveredZone(z.id)} 
                onMouseLeave={() => setHoveredZone(null)}
              >
                <motion.div
                  className="rounded-full blur-2xl"
                  style={{ width: 90, height: 90, backgroundColor: RISK_COLOR[risk], opacity: 0.16 }}
                  animate={{ opacity: [0.1, 0.22, 0.1] }} transition={{ duration: 3, repeat: Infinity }}
                />
                {showZoneLabels && (
                  <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9px] tracking-widest text-white/40 drop-shadow-md">
                    {z.name.toUpperCase()}
                  </span>
                )}
              </div>
            </OverlayView>
          );
        })}

        {/* Route Line */}
        {route && (
          <>
            {/* Faint base line so the road is visible even before segments compute */}
            <Polyline
              path={[percentToLatLng(route.start.x, route.start.y), percentToLatLng(route.end.x, route.end.y)]}
              options={{ strokeColor: '#3b82f6', strokeOpacity: roadRiskSegments.length ? 0 : 0.6, strokeWeight: 3 }}
            />

            {/* On-road live crime-rate coloring — each stretch of the actual
                road is tinted by how much reported risk sits near it, the
                same way Google colors roads by traffic. */}
            {roadRiskSegments.map((seg, i) => (
              <Polyline
                key={i}
                path={seg.path}
                options={{
                  strokeColor: RISK_COLOR[seg.risk],
                  strokeOpacity: seg.risk === 'low' ? 0.55 : 0.9,
                  strokeWeight: seg.risk === 'high' ? 6 : seg.risk === 'medium' ? 5 : 4,
                  zIndex: seg.risk === 'high' ? 3 : seg.risk === 'medium' ? 2 : 1,
                }}
              />
            ))}

            {/* Breadcrumb of the ground already covered — dim, behind the traveler */}
            {trail.length > 1 && (
              <Polyline
                path={trail}
                options={{ strokeColor: '#ffffff', strokeOpacity: 0.35, strokeWeight: 2, zIndex: 4 }}
              />
            )}

            <OverlayView position={percentToLatLng(route.start.x, route.start.y)} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
              <MapMarker color="#3b82f6" label={route.start.label} icon={<span className="h-2 w-2 rounded-full bg-white" />} />
            </OverlayView>
            <OverlayView position={percentToLatLng(route.end.x, route.end.y)} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
              <MapMarker color="#3b82f6" label={route.end.label} icon={<Navigation className="h-3 w-3 text-white" />} />
            </OverlayView>

            {/* Live moving "person on the road" — animates start → destination */}
            {travelerPos && (
              <OverlayView position={travelerPos} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
                <div className="absolute -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none">
                  {/* GPS-accuracy style pulse ring */}
                  <motion.span
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ width: 34, height: 34, backgroundColor: currentRoad ? RISK_COLOR[currentRoad.risk] : '#3b82f6' }}
                    animate={{ opacity: [0.35, 0, 0.35], scale: [0.6, 1.6, 0.6] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                  />
                  {/* Heading cone */}
                  <div
                    className="absolute left-1/2 top-1/2"
                    style={{ transform: `translate(-50%, -50%) rotate(${travelerHeading}deg)` }}
                  >
                    <div
                      className="h-8 w-8 rounded-full flex items-center justify-center ring-2 ring-white shadow-[0_0_10px_rgba(0,0,0,0.5)]"
                      style={{ backgroundColor: '#3b82f6' }}
                    >
                      <Navigation className="h-4 w-4 text-white" style={{ transform: 'translateY(-0.5px)' }} />
                    </div>
                  </div>

                  {/* Live on-road risk readout, follows the traveler */}
                  {currentRoad && (
                    <div
                      className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-black/80 px-2.5 py-1.5 text-[10px] font-semibold backdrop-blur-sm"
                    >
                      <div className="flex items-center gap-1" style={{ color: RISK_COLOR[currentRoad.risk] }}>
                        <Radar className="h-3 w-3 animate-pulse" />
                        {arrived ? 'Arrived' : RISK_LABEL[currentRoad.risk]} · {currentRoad.score}/100
                      </div>
                      {!arrived && (
                        <div className="mt-0.5 text-white/50">
                          {Math.round(travelProgress * 100)}% · {remainingMeters >= 1000 ? `${(remainingMeters / 1000).toFixed(1)} km` : `${Math.round(remainingMeters)} m`} left
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </OverlayView>
            )}
          </>
        )}

        {/* Incident Markers OR Heatmap */}
        {showHeatmap && isLoaded && heatmapData.length > 0 ? (
          <HeatmapLayer
            data={heatmapData}
            options={{
              radius: 40,
              opacity: 0.8,
              gradient: [
                'rgba(0, 255, 255, 0)',
                'rgba(0, 255, 255, 1)',
                'rgba(89, 255, 0, 1)',
                'rgba(191, 255, 0, 1)',
                'rgba(255, 255, 0, 1)',
                'rgba(255, 176, 32, 1)',
                'rgba(255, 77, 77, 1)',
                'rgba(255, 0, 0, 1)',
              ]
            }}
          />
        ) : (
          <AnimatePresence>
            {incidents.map((inc) => {
              const meta = INCIDENT_TYPES.find((t) => t.value === inc.type)!;
              const selected = inc.id === selectedIncidentId;
              return (
                <OverlayView key={inc.id} position={percentToLatLng(inc.x, inc.y)} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
                  <motion.button
                    initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                    onClick={(e) => { e.stopPropagation(); onSelectIncident?.(inc.id); }}
                  >
                    <motion.span
                      className="absolute -inset-2.5 rounded-full"
                      style={{ backgroundColor: RISK_COLOR[inc.risk] }}
                      animate={{ opacity: [0.35, 0.05, 0.35] }} transition={{ duration: 2, repeat: Infinity }}
                    />
                    <span
                      className={`relative flex h-5 w-5 items-center justify-center rounded-full text-[10px] ring-2 transition-transform ${selected ? 'scale-125 ring-white' : 'ring-[#182427]/60 hover:scale-110'}`}
                      style={{ backgroundColor: RISK_COLOR[inc.risk] }}
                    >
                      {meta.emoji}
                    </span>
                  </motion.button>
                </OverlayView>
              );
            })}
          </AnimatePresence>
        )}

        {/* Drop Pin */}
        {pin && (
          <OverlayView position={percentToLatLng(pin.x, pin.y)} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
            <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="absolute -translate-x-1/2 -translate-y-full z-20 pointer-events-none">
              <MapPin className="h-8 w-8 text-redbrand drop-shadow-lg" fill="#ff4d4d" fillOpacity={0.25} />
            </motion.div>
          </OverlayView>
        )}
      </GoogleMap>

      {hoveredZone && (
        <div className="pointer-events-none absolute left-3 top-3 z-30 rounded-lg border border-white/10 bg-black/70 px-3 py-1.5 font-mono text-[10px] text-white backdrop-blur-sm">
          {CITY_ZONES.find((z) => z.id === hoveredZone)?.name}
        </div>
      )}

      {/* Legend for the on-road live crime-rate coloring, only while a route is active */}
      {route && roadRiskSegments.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/70 px-3.5 py-1.5 font-mono text-[10px] text-white backdrop-blur-sm">
          <span className="text-white/50">ON-ROAD RISK</span>
          {(['low', 'medium', 'high'] as RiskLevel[]).map((r) => (
            <span key={r} className="flex items-center gap-1">
              <span className="h-1.5 w-4 rounded-full" style={{ backgroundColor: RISK_COLOR[r] }} />
              {RISK_LABEL[r]}
            </span>
          ))}
        </div>
      )}

      {/* Travel controls — follow camera toggle + replay, only while a route is active */}
      {route && roadPath && (
        <div className="absolute right-3 top-3 z-30 flex flex-col gap-1.5">
          <button
            onClick={() => setFollowTraveler((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold backdrop-blur-sm transition-colors ${
              followTraveler ? 'border-bluebrand bg-bluebrand/20 text-bluebrand' : 'border-white/10 bg-black/70 text-white/60 hover:bg-white/10'
            }`}
          >
            <Navigation className="h-3 w-3" /> {followTraveler ? 'Following' : 'Follow'}
          </button>
          {arrived && (
            <button
              onClick={() => setReplayTick((v) => v + 1)}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/70 px-2.5 py-1 text-[10px] font-semibold text-white/70 backdrop-blur-sm hover:bg-white/10"
            >
              <Radar className="h-3 w-3" /> Replay
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MapMarker({ color, label, icon }: { color: string; label: string; icon: React.ReactNode }) {
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center pointer-events-none">
      <span className="flex h-6 w-6 items-center justify-center rounded-full ring-2 ring-white/80" style={{ backgroundColor: color }}>{icon}</span>
      <span className="mt-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-white whitespace-nowrap">{label}</span>
    </div>
  );
}