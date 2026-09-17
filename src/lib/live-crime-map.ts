/**
 * live-crime-map.ts
 * ------------------------------------------------------------------
 * Single-file TypeScript module: a live-updating crime heatmap with
 * a moving "live location" marker (like Google Maps live location)
 * that travels along real roads from an origin to a destination,
 * showing on-road crime risk as it moves.
 *
 * This is the module supplied for the project, unchanged in behavior.
 * Two small public accessors were added at the bottom of the class
 * (getMap, setHeatmapVisible) purely so the map can be embedded inside
 * the existing Safora React app (click-to-drop-pin, incident markers,
 * heatmap/markers toggle) without touching the module's own logic.
 *
 * DEPENDENCIES (install in your project):
 *   npm i leaflet leaflet.heat
 *   npm i -D @types/leaflet
 *
 * Leaflet's CSS must also be included once in your app, e.g.:
 *   import "leaflet/dist/leaflet.css";
 *
 * ROUTING:
 *   Uses the free public OSRM demo server to get a real road route.
 *   If it's unreachable, it automatically falls back to a straight
 *   line between origin and destination so the module never breaks.
 *   Swap `fetchRoute` with your own routing API (Google Directions,
 *   Mapbox, GraphHopper, etc.) for production use.
 *
 * CRIME DATA:
 *   Ships with a random sample-data generator so it works out of the
 *   box. Call `setCrimeData()` with your real crime records
 *   ({ lat, lng, intensity, type, timestamp }[]) to replace it.
 *
 * USAGE EXAMPLE:
 *   import { LiveCrimeMap } from "./live-crime-map";
 *
 *   const map = new LiveCrimeMap("map-container-id");
 *
 *   map.setCrimeData(myRealCrimeRecords); // optional
 *
 *   map.travel(
 *     { lat: 28.6692, lng: 77.4538 },   // origin
 *     { lat: 28.7041, lng: 77.5021 },   // destination
 *     {
 *       speedMetersPerSec: 15,
 *       onPositionUpdate: (pos, riskScore) => {
 *         console.log("Current position:", pos, "Risk (0-1):", riskScore);
 *       },
 *       onArrive: () => console.log("Arrived!"),
 *     }
 *   );
 * ------------------------------------------------------------------
 */

import * as L from "leaflet";
import "leaflet.heat";

export interface CrimePoint {
  lat: number;
  lng: number;
  intensity: number; // 0-1 relative severity/frequency
  type?: string;
  timestamp?: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TravelOptions {
  speedMetersPerSec?: number;
  updateIntervalMs?: number;
  onPositionUpdate?: (pos: LatLng, riskScore: number) => void;
  onArrive?: () => void;
  useRealRouting?: boolean; // uses OSRM public router if true
}

export class LiveCrimeMap {
  private map: L.Map;
  private heatLayer: any;
  private personMarker: L.Marker | null = null;
  private destinationMarker: L.Marker | null = null;
  private routeLine: L.Polyline | null = null;
  private crimeData: CrimePoint[] = [];
  private travelTimer: number | null = null;
  private heatmapVisible = true;

  constructor(
    containerId: string,
    initialCenter: LatLng = { lat: 28.6692, lng: 77.4538 },
    zoom = 14
  ) {
    this.map = L.map(containerId).setView([initialCenter.lat, initialCenter.lng], zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(this.map);

    // Sample data so the map is populated out of the box.
    // Replace with real data via setCrimeData().
    this.crimeData = this.generateSampleCrimeData(initialCenter, 60);
    this.renderHeatmap();
  }

  /** Replace all crime data (e.g. from your backend / police API). */
  public setCrimeData(points: CrimePoint[]): void {
    this.crimeData = points;
    this.renderHeatmap();
  }

  /** Push a single new crime report and refresh the heatmap live. */
  public addCrimePoint(point: CrimePoint): void {
    this.crimeData.push(point);
    this.renderHeatmap();
  }

  public getCrimeData(): CrimePoint[] {
    return this.crimeData;
  }

  private renderHeatmap(): void {
    if (this.heatLayer) {
      this.map.removeLayer(this.heatLayer);
    }
    const heatPoints = this.crimeData.map((p) => [p.lat, p.lng, p.intensity]);
    // @ts-ignore — leaflet.heat extends the L namespace with heatLayer
    this.heatLayer = (L as any)
      .heatLayer(heatPoints, {
        radius: 30,
        blur: 20,
        maxZoom: 17,
        gradient: { 0.2: "blue", 0.4: "lime", 0.6: "yellow", 0.8: "orange", 1.0: "red" },
      });
    if (this.heatmapVisible) {
      this.heatLayer.addTo(this.map);
    }
  }

  private generateSampleCrimeData(center: LatLng, count: number): CrimePoint[] {
    const points: CrimePoint[] = [];
    const types = ["theft", "assault", "vandalism", "robbery", "harassment"];
    for (let i = 0; i < count; i++) {
      points.push({
        lat: center.lat + (Math.random() - 0.5) * 0.05,
        lng: center.lng + (Math.random() - 0.5) * 0.05,
        intensity: Math.random(),
        type: types[Math.floor(Math.random() * types.length)],
        timestamp: Date.now(),
      });
    }
    return points;
  }

  /** Distance in km between two lat/lng points (Haversine formula). */
  private haversine(a: LatLng, b: LatLng): number {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Crime-risk score (0-1) near a given point, based on nearby crime data. */
  private computeRiskAt(pos: LatLng, radiusKm = 0.3): number {
    let score = 0;
    for (const p of this.crimeData) {
      const d = this.haversine(pos, p);
      if (d <= radiusKm) {
        score += p.intensity * (1 - d / radiusKm);
      }
    }
    return Math.min(1, score);
  }

  /** Fetch a real road route from OSRM; falls back to a straight line. */
  private async fetchRoute(origin: LatLng, destination: LatLng): Promise<LatLng[]> {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const data = await res.json();
      const coords = data.routes[0].geometry.coordinates as [number, number][];
      return coords.map(([lng, lat]) => ({ lat, lng }));
    } catch (e) {
      console.warn("[LiveCrimeMap] Routing service unavailable, using straight line.", e);
      return [origin, destination];
    }
  }

  /**
   * Move a live marker from origin to destination along the road,
   * updating a color-coded crime-risk indicator as it goes.
   * Resolves when the marker arrives.
   */
  public async travel(
    origin: LatLng,
    destination: LatLng,
    options: TravelOptions = {}
  ): Promise<void> {
    const {
      speedMetersPerSec = 15,
      updateIntervalMs = 1000,
      onPositionUpdate,
      onArrive,
      useRealRouting = true,
    } = options;

    this.stopTravel();

    const path = useRealRouting ? await this.fetchRoute(origin, destination) : [origin, destination];

    if (this.routeLine) this.map.removeLayer(this.routeLine);
    this.routeLine = L.polyline(
      path.map((p) => [p.lat, p.lng]),
      { color: "#2563eb", weight: 4 }
    ).addTo(this.map);

    if (!this.personMarker) {
      const personIcon = L.divIcon({
        className: "live-person-marker",
        html: `<div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.5)"></div>`,
        iconSize: [16, 16],
      });
      this.personMarker = L.marker([origin.lat, origin.lng], { icon: personIcon }).addTo(this.map);
    } else {
      this.personMarker.setLatLng([origin.lat, origin.lng]);
    }

    if (this.destinationMarker) this.map.removeLayer(this.destinationMarker);
    this.destinationMarker = L.marker([destination.lat, destination.lng]).addTo(this.map);

    this.map.fitBounds(path.map((p) => [p.lat, p.lng]) as any, { padding: [40, 40] });

    // Precompute segment lengths so movement speed stays constant.
    const segLengths: number[] = [];
    let totalKm = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const d = this.haversine(path[i], path[i + 1]);
      segLengths.push(d);
      totalKm += d;
    }

    let traveledKm = 0;
    const speedKmPerTick = (speedMetersPerSec / 1000) * (updateIntervalMs / 1000);

    return new Promise((resolve) => {
      this.travelTimer = window.setInterval(() => {
        traveledKm += speedKmPerTick;

        if (traveledKm >= totalKm) {
          this.personMarker!.setLatLng([destination.lat, destination.lng]);
          const risk = this.computeRiskAt(destination);
          this.updateMarkerRiskStyle(risk);
          onPositionUpdate?.(destination, risk);
          this.stopTravel();
          onArrive?.();
          resolve();
          return;
        }

        // Find which road segment we're currently on.
        let remaining = traveledKm;
        let idx = 0;
        while (idx < segLengths.length && remaining > segLengths[idx]) {
          remaining -= segLengths[idx];
          idx++;
        }

        const segStart = path[idx];
        const segEnd = path[idx + 1] ?? path[idx];
        const frac = segLengths[idx] ? remaining / segLengths[idx] : 0;

        const currentPos: LatLng = {
          lat: segStart.lat + (segEnd.lat - segStart.lat) * frac,
          lng: segStart.lng + (segEnd.lng - segStart.lng) * frac,
        };

        this.personMarker!.setLatLng([currentPos.lat, currentPos.lng]);
        this.map.panTo([currentPos.lat, currentPos.lng], { animate: true });

        const risk = this.computeRiskAt(currentPos);
        this.updateMarkerRiskStyle(risk);
        onPositionUpdate?.(currentPos, risk);
      }, updateIntervalMs);
    });
  }

  /** Colors the live marker green/amber/red based on current road risk. */
  private updateMarkerRiskStyle(risk: number): void {
    if (!this.personMarker) return;
    const color = risk > 0.66 ? "#dc2626" : risk > 0.33 ? "#f59e0b" : "#22c55e";
    const el = this.personMarker.getElement();
    if (el) {
      const dot = el.querySelector("div") as HTMLDivElement | null;
      if (dot) dot.style.background = color;
    }
  }

  /** Stop an in-progress journey without removing the map. */
  public stopTravel(): void {
    if (this.travelTimer !== null) {
      window.clearInterval(this.travelTimer);
      this.travelTimer = null;
    }
  }

  /** Fully tear down the map instance (e.g. on component unmount). */
  public destroy(): void {
    this.stopTravel();
    this.stopLiveLocation();
    this.map.remove();
  }

  // ---- Real device GPS tracking (navigator.geolocation) ------------------
  // Everything below uses the browser's actual location APIs — no simulation.
  // This is what makes the "live location" marker genuinely live when this
  // runs on a real device with location permission granted.

  private liveWatchId: number | null = null;
  private liveMarker: L.Marker | null = null;
  private liveAccuracyCircle: L.Circle | null = null;
  private liveNavDestination: LatLng | null = null;
  private liveNavArrived = false;
  private onLiveArrive?: () => void;

  /**
   * Start tracking the browser's real GPS position with navigator.geolocation
   * .watchPosition, rendering it as a live marker + accuracy circle that update
   * continuously as the device actually moves.
   */
  public startLiveLocation(
    options: {
      onUpdate?: (pos: LatLng, accuracyMeters: number, riskScore: number) => void;
      onError?: (message: string) => void;
      panTo?: boolean;
    } = {}
  ): void {
    if (!("geolocation" in navigator)) {
      options.onError?.("Geolocation is not supported by this browser.");
      return;
    }
    this.stopLiveLocation();

    const icon = L.divIcon({
      className: "live-gps-marker",
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#1fc7c7;border:3px solid white;box-shadow:0 0 8px rgba(31,199,199,0.8)"></div>`,
      iconSize: [16, 16],
    });

    this.liveWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const pos: LatLng = { lat: position.coords.latitude, lng: position.coords.longitude };
        const accuracy = position.coords.accuracy;

        if (!this.liveMarker) {
          this.liveMarker = L.marker([pos.lat, pos.lng], { icon }).addTo(this.map);
        } else {
          this.liveMarker.setLatLng([pos.lat, pos.lng]);
        }

        if (!this.liveAccuracyCircle) {
          this.liveAccuracyCircle = L.circle([pos.lat, pos.lng], {
            radius: accuracy,
            color: "#1fc7c7",
            weight: 1,
            fillOpacity: 0.08,
          }).addTo(this.map);
        } else {
          this.liveAccuracyCircle.setLatLng([pos.lat, pos.lng]);
          this.liveAccuracyCircle.setRadius(accuracy);
        }

        if (options.panTo !== false) this.map.panTo([pos.lat, pos.lng], { animate: true });

        const risk = this.computeRiskAt(pos);
        options.onUpdate?.(pos, accuracy, risk);

        if (this.liveNavDestination && !this.liveNavArrived) {
          const distMeters = this.haversine(pos, this.liveNavDestination) * 1000;
          if (distMeters <= 30) {
            this.liveNavArrived = true;
            this.onLiveArrive?.();
          }
        }
      },
      (err) => options.onError?.(err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  /** Stop real GPS tracking and remove its marker/accuracy circle. */
  public stopLiveLocation(): void {
    if (this.liveWatchId !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(this.liveWatchId);
    }
    this.liveWatchId = null;
    if (this.liveMarker) {
      this.map.removeLayer(this.liveMarker);
      this.liveMarker = null;
    }
    if (this.liveAccuracyCircle) {
      this.map.removeLayer(this.liveAccuracyCircle);
      this.liveAccuracyCircle = null;
    }
    this.liveNavDestination = null;
    this.liveNavArrived = false;
    this.onLiveArrive = undefined;
  }

  public isLiveLocationActive(): boolean {
    return this.liveWatchId !== null;
  }

  /**
   * Real navigation: fetches the on-road route from the device's actual current
   * GPS fix to `destination` (for the risk-colored road overlay), then tracks
   * real device movement — via startLiveLocation — until within ~30m of the
   * target. Unlike `travel()`, nothing here is time-simulated; the marker only
   * moves when the device's real position changes.
   */
  public async navigateLiveTo(
    destination: LatLng,
    options: {
      onPositionUpdate?: (pos: LatLng, riskScore: number) => void;
      onArrive?: () => void;
      onError?: (message: string) => void;
      useRealRouting?: boolean;
    } = {}
  ): Promise<void> {
    if (!("geolocation" in navigator)) {
      options.onError?.("Geolocation is not supported by this browser.");
      return;
    }

    const origin = await new Promise<LatLng | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
    if (!origin) {
      options.onError?.("Couldn't get your current location. Check location permissions.");
      return;
    }

    const path = options.useRealRouting !== false ? await this.fetchRoute(origin, destination) : [origin, destination];
    if (this.routeLine) this.map.removeLayer(this.routeLine);
    this.routeLine = L.polyline(path.map((p) => [p.lat, p.lng]), { color: "#1fc7c7", weight: 4 }).addTo(this.map);

    if (this.destinationMarker) this.map.removeLayer(this.destinationMarker);
    this.destinationMarker = L.marker([destination.lat, destination.lng]).addTo(this.map);
    this.map.fitBounds(path.map((p) => [p.lat, p.lng]) as any, { padding: [40, 40] });

    this.liveNavDestination = destination;
    this.liveNavArrived = false;
    this.onLiveArrive = () => {
      this.stopLiveLocation();
      options.onArrive?.();
    };

    this.startLiveLocation({
      onUpdate: (pos, _accuracy, risk) => options.onPositionUpdate?.(pos, risk),
      onError: options.onError,
      panTo: true,
    });
  }

  // ---- Added purely for embedding inside the Safora app -----------------
  // The module above is used as-is; these just expose the underlying
  // Leaflet map so the host component can add its own pin/incident
  // markers and a heatmap/markers toggle, without editing the class logic.

  /** The underlying Leaflet map instance, for host-app integrations. */
  public getMap(): L.Map {
    return this.map;
  }

  /** Crime-risk score (0-1) near an arbitrary point — exposes the same math
   * used internally while traveling, so a host app can score a real GPS
   * position too, not just points along a simulated route. */
  public getRiskAt(pos: LatLng, radiusKm = 0.3): number {
    return this.computeRiskAt(pos, radiusKm);
  }

  /** Show/hide the heatmap layer without discarding the crime data. */
  public setHeatmapVisible(visible: boolean): void {
    this.heatmapVisible = visible;
    if (!this.heatLayer) return;
    const hasLayer = this.map.hasLayer(this.heatLayer);
    if (visible && !hasLayer) this.heatLayer.addTo(this.map);
    if (!visible && hasLayer) this.map.removeLayer(this.heatLayer);
  }
}
