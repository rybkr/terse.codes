import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import type { Profile } from "../api";
import { Avatar, Icon, Spinner } from "../components/ui";

const metrics = [
  { key: "rating", label: "Rating" },
  { key: "careerPoints", label: "Career points" },
  { key: "solvedProblems", label: "Unique solved" },
  { key: "roundWins", label: "Round wins" },
  { key: "tournamentWins", label: "Tournament wins" },
  { key: "roundWinStreak", label: "Current round streak" },
  { key: "bestRoundWinStreak", label: "Best round streak" },
  { key: "tournamentWinStreak", label: "Current tournament streak" },
  { key: "bestTournamentWinStreak", label: "Best tournament streak" },
] as const;

export default function ProfilePage({ profile }: { profile: Profile }) {
  const [freshProfile, setFreshProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const displayedProfile = freshProfile ?? profile;

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      setFreshProfile(await api.profile.query());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  function format(value: number, maxFractionDigits = 0) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: maxFractionDigits }).format(value);
  }

  return (
    <main className="relative flex min-h-full flex-col items-center overflow-y-auto px-5 py-12 sm:py-16">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <div className="relative w-full max-w-2xl">
        <Link to="/" className="btn btn-secondary btn-sm mb-6">
          <Icon.arrowLeft size={14} /> Back to rooms
        </Link>
        <section className="pop overflow-hidden">
          <header className="flex items-center gap-4 border-b border-line px-5 py-5 sm:px-7">
            <Avatar name={displayedProfile.username} size={48} />
            <div className="min-w-0">
              <p className="section-label">Player profile</p>
              <h1 className="truncate text-[21px] font-semibold tracking-[-0.02em] text-fg">{displayedProfile.username}</h1>
            </div>
            <div className="ml-auto flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-fg-muted">
              <Icon.trophy size={14} className="text-warn" />
              <span className="font-mono tabular-nums text-fg">{format(displayedProfile.rating, 2)}</span>
            </div>
          </header>
          {(loading || error) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 text-[12.5px] sm:px-7">
              {loading ? (
                <p role="status" className="flex items-center gap-2 text-fg-muted"><Spinner /> Updating profile stats…</p>
              ) : (
                <p role="alert" className="text-bad">Couldn’t refresh stats: {error}. Showing the last saved profile.</p>
              )}
              {error && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Retry</button>}
            </div>
          )}
          <dl className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
            {metrics.filter((metric) => metric.key !== "rating").map((metric, index) => (
              <div key={metric.key} className={`flex items-center justify-between gap-4 px-5 py-4 sm:px-7 ${index % 2 === 0 ? "sm:border-r sm:border-line" : ""} ${index >= 2 ? "sm:border-t sm:border-line" : ""}`}>
                <dt className="text-[13px] text-fg-muted">{metric.label}</dt>
                <dd className="font-mono text-[15px] tabular-nums text-fg">{format(displayedProfile[metric.key], metric.key === "careerPoints" ? 2 : 0)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}
