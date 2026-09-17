import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { SOSProvider } from '@/context/SOSContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { ReportsProvider } from '@/context/ReportsContext';
import { LocationProvider } from '@/context/LocationContext';
import Nav from '@/components/Nav';
import FloatingSOS from '@/components/FloatingSOS';
import Hero from '@/components/Hero';
import Stories from '@/components/Stories';
import VerifiedAlerts from '@/components/VerifiedAlerts';
import Features from '@/components/Features';
import HeatmapPreview from '@/components/HeatmapPreview';
import Stats from '@/components/Stats';
import GetFullStory from '@/components/GetFullStory';
import Testimonial from '@/components/Testimonial';
import GreaterGood from '@/components/GreaterGood';
import FAQ from '@/components/FAQ';
import FinalCTA from '@/components/FinalCTA';
import Footer from '@/components/Footer';
import LoginPage from '@/pages/LoginPage';
import SOSPage from '@/pages/SOSPage';
import AppPage from '@/pages/AppPage';
import AnalyticsPage from '@/pages/AnalyticsPage';
import ProfilePage from '@/pages/ProfilePage';
import ReportIncidentPage from '@/pages/ReportIncidentPage';
import CommunityPage from '@/pages/CommunityPage';
import SafeWalkPage from '@/pages/SafeWalkPage';
import GuidesPage from '@/pages/GuidesPage';
import LeaderboardPage from '@/pages/LeaderboardPage';
import FeaturesPage from '@/pages/marketing/FeaturesPage';
import AboutPage from '@/pages/marketing/AboutPage';
import SupportPage from '@/pages/marketing/SupportPage';
import BlogPage from '@/pages/marketing/BlogPage';
import ProtectedRoute from '@/components/ProtectedRoute';

function HomePage() {
  return (
    <div className="bg-ink">
      <Hero />
      <Stories />
      <VerifiedAlerts />
      <Features />
      <HeatmapPreview />
      <Stats />
      <GetFullStory />
      <Testimonial />
      <GreaterGood />
      <FAQ />
      <FinalCTA />
      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <LocationProvider>
          <SOSProvider>
            <ReportsProvider>
              <Nav />
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/app" element={<ProtectedRoute><AppPage /></ProtectedRoute>} />
                <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
                <Route path="/report" element={<ProtectedRoute><ReportIncidentPage /></ProtectedRoute>} />
                <Route path="/sos" element={<ProtectedRoute><SOSPage /></ProtectedRoute>} />
                <Route path="/community" element={<ProtectedRoute><CommunityPage /></ProtectedRoute>} />
                <Route path="/safewalk" element={<ProtectedRoute><SafeWalkPage /></ProtectedRoute>} />
                <Route path="/leaderboard" element={<ProtectedRoute><LeaderboardPage /></ProtectedRoute>} />
                <Route path="/guides" element={<GuidesPage />} />
                <Route path="/features" element={<FeaturesPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/support" element={<SupportPage />} />
                <Route path="/blog" element={<BlogPage />} />
                <Route path="*" element={<HomePage />} />
              </Routes>
              <FloatingSOS />
            </ReportsProvider>
          </SOSProvider>
        </LocationProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
