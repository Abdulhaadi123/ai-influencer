/**
 * Utility to resolve API endpoints dynamically.
 * On Web: Returns relative paths (handled by Vite dev proxy or Vercel production hosting).
 * On Mobile (Capacitor): Appends the Vercel API production base URL.
 */
export function getApiUrl(path) {
  // Check if running inside Capacitor (native WebView)
  const isCapacitor = 
    typeof window !== 'undefined' && 
    (!!window.Capacitor || 
     window.location.origin.startsWith('capacitor://') || 
     (window.location.origin.startsWith('http://localhost') && !window.location.port));

  if (isCapacitor) {
    const apiBase = import.meta.env.VITE_API_BASE || '';
    if (apiBase) {
      const base = apiBase.replace(/\/+$/, '');
      const rel = path.replace(/^\/+/, '');
      return `${base}/${rel}`;
    }
  }
  
  return path;
}
