declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

// leaflet.heat ships no types of its own — it just extends the Leaflet
// namespace at runtime (L.heatLayer). This satisfies the side-effect import.
declare module 'leaflet.heat';