import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SEED_INCIDENTS, generateLiveIncident, type Incident, type IncidentType, type RiskLevel } from '@/data/incidents';

export interface NewReportInput {
  type: IncidentType;
  x: number;
  y: number;
  zoneId: string;
  description: string;
  photoDataUrl?: string;
}

interface ReportsContextValue {
  incidents: Incident[];
  myReports: Incident[];
  addReport: (r: NewReportInput) => Incident;
  trustScore: number;
  trustLevel: 'New' | 'Trusted' | 'Verified Guardian' | 'Community Hero';
}

const ReportsContext = createContext<ReportsContextValue | undefined>(undefined);

const CURRENT_USER_LABEL = 'You';

export function ReportsProvider({ children }: { children: ReactNode }) {
  const [incidents, setIncidents] = useState<Incident[]>(SEED_INCIDENTS);

  // Genuinely live-updating feed: a new community report arrives on its own
  // every 20-45s, aging existing reports as time passes — so the heatmap and
  // "live" risk score actually change on their own, not just when the current
  // user submits something.
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const delay = 20000 + Math.random() * 25000; // 20-45s
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setIncidents((prev) => [generateLiveIncident(), ...prev]);
        scheduleNext();
      }, delay);
    };
    scheduleNext();

    // Age every incident's "hoursAgo" once a minute so times-ago labels and
    // recency-weighted risk scoring stay accurate to real elapsed time.
    const agingInterval = setInterval(() => {
      setIncidents((prev) => prev.map((i) => ({ ...i, hoursAgo: i.hoursAgo + 1 / 60 })));
    }, 60000);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      clearInterval(agingInterval);
    };
  }, []);

  function addReport(r: NewReportInput): Incident {
    const risk: RiskLevel = r.type === 'assault' || r.type === 'harassment' || r.type === 'fire' ? 'high' : 'medium';
    const incident: Incident = {
      id: `inc-user-${Date.now()}`,
      type: r.type,
      zoneId: r.zoneId,
      x: r.x,
      y: r.y,
      risk,
      title: r.description.slice(0, 60) || 'Community report',
      description: r.description || 'No additional details provided.',
      status: 'unverified',
      reportedBy: CURRENT_USER_LABEL,
      hoursAgo: 0,
      hourOfDay: new Date().getHours(),
      photoDataUrl: r.photoDataUrl,
    };
    setIncidents((prev) => [incident, ...prev]);
    return incident;
  }

  const myReports = incidents.filter((i) => i.reportedBy === CURRENT_USER_LABEL);
  const verifiedCount = myReports.filter((r) => r.status === 'verified' || r.status === 'resolved').length;

  // Trust score: base 40 + points per submitted report + bonus for verified ones, capped at 100
  const trustScore = Math.min(100, 40 + myReports.length * 6 + verifiedCount * 9);
  const trustLevel: ReportsContextValue['trustLevel'] =
    trustScore >= 90 ? 'Community Hero' : trustScore >= 70 ? 'Verified Guardian' : trustScore >= 50 ? 'Trusted' : 'New';

  return (
    <ReportsContext.Provider value={{ incidents, myReports, addReport, trustScore, trustLevel }}>
      {children}
    </ReportsContext.Provider>
  );
}

export function useReports() {
  const ctx = useContext(ReportsContext);
  if (!ctx) throw new Error('useReports must be inside ReportsProvider');
  return ctx;
}
