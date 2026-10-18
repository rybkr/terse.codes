import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { formatTimer, type RoomState } from "../hooks/useRoom";
import { ResultsTable } from "./Standings";
import { Avatar, DifficultyPill, Icon, Spinner, cx } from "./ui";

const enter = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
} as const;

export function Lobby({ r }: { r: RoomState }) {
  const room = r.room!;
  const members = room.members;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <motion.div {...enter} className="relative mx-auto my-auto w-full max-w-[540px] flex-none px-4 py-10 sm:py-14">
        <div className="mb-6 text-center">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">
            Room Invite
          </h1>
        </div>

        <section className="pop overflow-hidden">
          <div className="flex flex-col items-center gap-4 px-6 py-6">
            <button
              type="button"
              onClick={() => {
                void r.copyRoom();
              }}
              aria-label={r.copied === "code" ? `Room code ${r.roomId} copied` : `Copy room code ${r.roomId}`}
              title={r.copied === "code" ? "Copied" : "Copy room code"}
              className="group max-w-full rounded-xl p-1 transition-colors"
            >
              <span className={cx(
                "block max-w-full break-all rounded-lg border bg-sunken px-4 py-3 font-mono text-[16px] font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition-colors sm:text-[18px]",
                r.copied === "code" ? "border-ok/50 text-ok" : "border-line-strong text-fg group-hover:border-line-hover",
              )}>
                {r.roomId}
              </span>
            </button>
            <button
              type="button"
              onClick={() => { void r.copyRoom("link"); }}
              className="btn btn-secondary"
            >
              <span aria-live="polite">{r.copied === "link" ? "Link copied!" : "Copy join link"}</span>
            </button>
          </div>

          <dl className="grid grid-cols-3 border-y border-line bg-surface/60 text-center">
            <div className="flex flex-col items-center gap-1 px-3 py-3.5 sm:px-5">
              <dt className="section-label">Difficulty</dt>
              <dd>
                <DifficultyPill difficulty={room.difficulty} />
              </dd>
            </div>
            <div className="flex flex-col items-center gap-1 border-x border-line px-3 py-3.5 sm:px-5">
              <dt className="section-label">Time per round</dt>
              <dd className="font-mono text-[14px] tabular-nums text-fg">
                {formatTimer(room.timeLimit)}
              </dd>
            </div>
            <div className="flex flex-col items-center gap-1 px-3 py-3.5 sm:px-5">
              <dt className="section-label">Rounds</dt>
              <dd className="font-mono text-[14px] tabular-nums text-fg">
                {room.totalRounds}
              </dd>
            </div>
          </dl>

          <div className="flex flex-col items-center px-5 py-4">
            <h2 className="section-label mb-3 flex items-center gap-1.5">
              Players
              <span className="font-mono tabular-nums text-fg-muted">
                {members.length}
              </span>
            </h2>
            <ul aria-label="Players" className="flex flex-wrap items-center justify-center gap-3">
              {members.map((member) => (
                <motion.li
                  key={`player:${member.userId}`}
                  layout
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="group relative flex items-center gap-1 rounded-full"
                  aria-label={`${member.name}${member.online ? ", online" : ", offline"}`}
                  title={`${member.name}${member.host ? " (host)" : ""}${member.userId === room.me.userId ? " (you)" : ""}`}
                >
                  <span className="relative">
                    <Avatar name={member.name} size={32} />
                    <span
                      role="img"
                      aria-label={member.online ? "Online" : "Offline"}
                      title={member.online ? "Online" : "Offline"}
                      className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-raised ${member.online ? "bg-ok" : "bg-bad"}`}
                    />
                  </span>
                  {r.isHost && member.userId !== room.me.userId && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon kick-reveal rounded-full text-bad"
                      onClick={() => void r.kick(member.userId)}
                      aria-label={`Remove ${member.name} from room`}
                      title={`Remove ${member.name}`}
                    >
                      <Icon.x size={13} />
                    </button>
                  )}
                </motion.li>
              ))}
            </ul>
          </div>

          <footer className="flex items-center justify-center border-t border-line bg-surface/60 px-5 py-3.5">
            {r.isHost ? (
              <button
                type="button"
                disabled={!r.canAct}
                className="btn btn-primary"
                onClick={() => {
                  void r.start();
                }}
              >
                {r.pending ? <Spinner /> : <Icon.play size={13} />}
                {r.pending ? "Starting…" : "Start race"}
              </button>
            ) : (
              <p className="flex items-center gap-2.5 text-[13px] text-fg-muted">
                <Spinner className="text-fg-subtle" />
                <span>
                  Waiting for <span className="font-medium text-fg">{room.host}</span> to
                  start the race
                </span>
              </p>
            )}
          </footer>
        </section>
      </motion.div>
    </div>
  );
}

export function Finished({ r }: { r: RoomState }) {
  const room = r.room!;
  const breakLeft = room.breakRemaining;
  const firstPlaceSolvers = room.rankings.filter((player) => player.position === 1 && player.solved);
  const leader = firstPlaceSolvers[0];
  const competitive = room.rankings.length > 1;
  const lastRound = breakLeft === null;

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <motion.div {...enter} className="mx-auto w-full max-w-[780px] px-4 py-10 sm:py-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="section-label mb-2">
              Round {room.currentRound} of {room.totalRounds}
            </p>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">
              {lastRound ? "Race complete" : `Round ${room.currentRound} complete`}
            </h1>
            <p className="mt-1.5 text-[14px] text-fg-muted">
              {firstPlaceSolvers.length > 1 ? (
                "Tied first place."
              ) : leader && !competitive ? (
                "Solo round solved."
              ) : leader ? (
                <>
                  <span className="font-medium text-fg">
                    {leader.userId === room.me.userId ? "You" : leader.name}
                  </span>{" "}
                  took the round with{" "}
                  <span className="font-mono tabular-nums text-ok">{leader.charCount}</span>{" "}
                  characters.
                </>
              ) : (
                "Nobody solved this one."
              )}
            </p>
          </div>
          {!lastRound && (
            <div className="panel flex items-center gap-3 px-4 py-2.5">
              <Icon.clock size={15} className="text-fg-subtle" />
              <div>
                <p className="text-[11.5px] text-fg-subtle">Next round in</p>
                <p
                  className="font-mono text-[20px] font-medium leading-tight tabular-nums text-fg"
                  aria-live="off"
                >
                  {formatTimer(breakLeft ?? 0)}
                </p>
              </div>
            </div>
          )}
        </div>

        <section className="panel overflow-hidden">
          {room.problem && (
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Icon.doc size={14} className="text-fg-subtle" />
              <h2 className="truncate text-[13px] font-medium text-fg">{room.problem.title}</h2>
              <DifficultyPill difficulty={room.problem.difficulty} />
            </header>
          )}
          <ResultsTable room={room} ownCode={r.code} onReview={(userId, name, code) => r.setReview({ userId, name, code })} isHost={r.isHost} onKick={r.kick} />
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          {lastRound && (
            <Link className="btn btn-secondary mr-auto" to={`/room/results?id=${encodeURIComponent(r.roomId)}`}>
              <Icon.trophy size={14} /> Tournament results
            </Link>
          )}
          {!r.isHost && (
            <p className="text-[12.5px] text-fg-subtle">
              {lastRound
                ? `Waiting for ${room.host} to start a new race.`
                : `${room.host} can skip the break.`}
            </p>
          )}
          {r.isHost && (
            <button
              type="button"
              disabled={!r.canAct}
              className="btn btn-primary"
              onClick={() => {
                void r.advance();
              }}
            >
              {r.pending ? <Spinner /> : <Icon.play size={13} />}
              {lastRound ? "Play again" : "Continue"}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export function TournamentResults({ r }: { r: RoomState }) {
  const room = r.room!;
  const standings = [...room.standings].sort((left, right) => right.points - left.points);
  let rank = 0;
  let previousPoints: number | null = null;

  return (
    <main className="relative h-full overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto w-full max-w-4xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="section-label">Tournament complete</p>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Final standings</h1>
          </div>
          <Link className="btn btn-secondary btn-sm" to={`/room?id=${encodeURIComponent(r.roomId)}`}>
            <Icon.arrowLeft size={14} /> Latest round
          </Link>
        </div>
        <section className="panel mb-6 overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead><tr className="border-b border-line text-fg-subtle"><th scope="col" className="px-4 py-3">#</th><th scope="col" className="px-4 py-3">Player</th><th scope="col" className="px-4 py-3 text-right">Points</th></tr></thead>
            <tbody>
              {standings.map((standing, index) => {
                if (standing.points !== previousPoints) rank = index + 1;
                previousPoints = standing.points;
                return (
                  <tr key={standing.userId} className={`border-b border-line last:border-b-0 ${standing.userId === room.me.userId ? "bg-accent/[0.05]" : ""}`}>
                    <td className="px-4 py-3 font-mono tabular-nums text-fg-subtle">{rank}</td>
                    <td className="px-4 py-3 font-medium text-fg">{standing.name}{standing.userId === room.me.userId ? <span className="pill ml-2">You</span> : null}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-fg">{new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(standing.points)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <section className="panel overflow-hidden">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-medium text-fg">Latest round · {room.currentRound}</h2>
            <span className="section-label">Code review retained</span>
          </header>
          <ResultsTable room={room} ownCode={r.code} onReview={(userId, name, code) => r.setReview({ userId, name, code })} isHost={r.isHost} onKick={r.kick} />
        </section>
      </div>
    </main>
  );
}
