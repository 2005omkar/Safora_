// Shared geo constants/helpers. Pulled out of MapView so LocationContext can
// convert a real GPS lat/lng into the same 0-100 percent space the map,
// incidents, and heatmap already use.

export const MAP_BOUNDS = { north: 26.89, south: 26.75, west: 80.85, east: 81.05 };
export const CENTER = { lat: 26.8467, lng: 80.9462 }; // Lucknow

export function percentToLatLng(x: number, y: number) {
  return {
    lat: MAP_BOUNDS.north - (y / 100) * (MAP_BOUNDS.north - MAP_BOUNDS.south),
    lng: MAP_BOUNDS.west + (x / 100) * (MAP_BOUNDS.east - MAP_BOUNDS.west),
  };
}

export function latLngToPercent(lat: number, lng: number) {
  const x = ((lng - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * 100;
  const y = ((MAP_BOUNDS.north - lat) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * 100;
  return { x, y };
}

/** True if a lat/lng falls inside the stylized map's bounds. */
export function isWithinMapBounds(lat: number, lng: number) {
  return (
    lat <= MAP_BOUNDS.north && lat >= MAP_BOUNDS.south &&
    lng >= MAP_BOUNDS.west && lng <= MAP_BOUNDS.east
  );
}
