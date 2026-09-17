import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

/**
 * Gates a route behind sign-in. Without this, every page in the app was
 * reachable by URL regardless of auth state — anyone could open /app,
 * /profile, /report, /sos, etc. directly.
 *
 * Works the same whether Firebase is configured (real Firebase Auth) or not
 * (the local, no-backend auth system in src/lib/localAuth.ts) — AuthContext
 * picks the right one transparently, so this component just checks `user`.
 */
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-ink">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    );
  }

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <>{children}</>;
}
