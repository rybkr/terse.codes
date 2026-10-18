import type { RoomSnapshot } from "../api";
import type { Ranking } from "../hooks/useRoom";
import { formatSolveTime } from "../formatSolveTime";
import { Avatar, Icon, cx } from "./ui";

function StatusBadges({ player }: { player: Ranking }) {
  return (
    <>
      {player.lockedAt !== null && (
        <span className="pill pill-warn">
          <Icon.lock size={10} strokeWidth={2} />
          Locked
        </span>
      )}
      {player.resigned && <span className="pill">Resigned</span>}
      {player.away && (
        <span className="pill border-dashed text-fg-subtle">Away</span>
      )}
    </>
  );
}

export function StandingsStrip({ room, isHost, onKick }: { room: RoomSnapshot; isHost: boolean; onKick: (userId: string) => void }) {
  return (
    <section aria-label="Live standings" className="flex-none px-2 py-1">
      <ol className="panel grid grid-cols-2 gap-1 p-1 sm:grid-cols-4 lg:grid-cols-8">
        {room.rankings.map((player) => (
          <li
            key={player.userId}
            aria-current={player.userId === room.me.userId || undefined}
            title={player.name}
            className={cx(
              "group flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2",
              player.userId === room.me.userId
                ? "border-accent/35 bg-accent/[0.07]"
                : "border-line bg-surface",
            )}
          >
            <Avatar name={player.name} size={18} />
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {(() => {
                const member = room.members.find((item) => item.userId === player.userId);
                return (
                  <span
                    role="img"
                    aria-label={member?.online ? "Online" : "Offline"}
                    title={member?.online ? "Online" : "Offline"}
                    className={`size-1.5 flex-none rounded-full ${member?.online ? "bg-ok" : "bg-bad"}`}
                  />
                );
              })()}
              <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">{player.name}</p>
              {player.lockedAt !== null && (
                <span role="img" aria-label="Locked" title="Score locked" className="flex-none text-warn">
                  <Icon.lock size={12} strokeWidth={2} />
                </span>
              )}
              {player.resigned && (
                <span role="img" aria-label="Resigned" title="Resigned" className="flex-none text-bad">
                  <Icon.x size={12} strokeWidth={2} />
                </span>
              )}
              <p className={cx("flex flex-none items-center gap-1 text-[11px]", player.solved ? "text-ok" : "text-fg-subtle")}>
                {player.solved ? (
                  <>
                    <Icon.check size={11} />
                    <span className="sr-only">Solved, </span>
                    <span className="font-mono tabular-nums">{player.charCount} chars</span>
                  </>
                ) : "Unsolved"}
              </p>
              {isHost && player.userId !== room.me.userId && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon kick-reveal -mr-1 rounded-full text-bad"
                  onClick={() => onKick(player.userId)}
                  aria-label={`Remove ${player.name} from room`}
                  title={`Remove ${player.name}`}
                >
                  <Icon.x size={12} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Full results table for the finished-round view. */
export function ResultsTable({
  room,
  ownCode,
  onReview,
  isHost,
  onKick,
}: {
  room: RoomSnapshot;
  ownCode: string;
  onReview: (userId: string, name: string, code: string) => void;
  isHost: boolean;
  onKick: (userId: string) => void;
}) {
  const firstPlaceSolvers = room.rankings.filter((player) => player.position === 1 && player.solved);
  const soleCompetitiveWinner = room.rankings.length > 1 && firstPlaceSolvers.length === 1
    ? firstPlaceSolvers[0]?.userId
    : null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed text-center text-[13px]">
        <colgroup>
          <col className="w-[7%]" />
          <col className="w-[21%]" />
          <col className="w-[24%]" />
          <col className="w-[14%]" />
          <col className="w-[16%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-line text-[12px] text-fg-subtle">
            <th scope="col" className="px-3 py-3 text-center font-medium">#</th>
            <th scope="col" className="px-3 py-3 font-medium">Player</th>
            <th scope="col" className="px-3 py-3 font-medium">Result</th>
            <th scope="col" className="px-3 py-3 font-medium">Tests</th>
            <th scope="col" className="px-3 py-3 font-medium">Solve time</th>
            <th scope="col" className="px-3 py-3 font-medium">Code</th>
          </tr>
        </thead>
        <tbody>
          {room.rankings.map((player) => {
            const me = player.userId === room.me.userId;
            const winner = player.userId === soleCompetitiveWinner;
            const code = player.code ?? (me ? ownCode : room.problem?.starterCode ?? "");
            return (
              <tr
                key={player.userId}
                className={cx(
                  "group border-b border-line transition-colors last:border-b-0 hover:bg-white/[0.02]",
                  me && "bg-accent/[0.04]",
                )}
              >
                <td className="px-3 py-3">
                  {winner ? (
                    <span className="mx-auto flex size-6 items-center justify-center rounded-md border border-warn/30 bg-warn/10 text-warn">
                      <Icon.trophy size={13} />
                    </span>
                  ) : (
                    <span className="mx-auto flex size-6 items-center justify-center font-mono text-[12px] tabular-nums text-fg-subtle">
                      {player.position}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <span className="flex min-w-0 items-center justify-center gap-2">
                    <span className="truncate font-medium text-fg" title={player.name}>{player.name}</span>
                    {me && <span className="pill flex-none">You</span>}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <span className="flex flex-wrap items-center justify-center gap-1.5">
                    {player.solved ? (
                      <span className="font-mono tabular-nums text-ok">
                        {player.charCount} chars
                      </span>
                    ) : (
                      <span className="text-fg-subtle">Unsolved</span>
                    )}
                    <StatusBadges player={player} />
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono tabular-nums text-fg-muted">
                  {player.testsPassed}
                  <span className="text-fg-subtle"> / {player.testsTotal}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono tabular-nums text-fg-muted">
                  {player.solveTime === null ? "-" : formatSolveTime(player.solveTime)}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onReview(player.userId, player.name, code)}
                    aria-label={`View ${player.name}'s code`}
                    title={player.code === null && !me ? "View starter code. No submission." : undefined}
                  >
                    <Icon.eye size={14} />
                    View code
                  </button>
                  {isHost && !me && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon kick-reveal ml-1 rounded-full text-bad"
                      onClick={() => onKick(player.userId)}
                      aria-label={`Remove ${player.name} from room`}
                      title={`Remove ${player.name}`}
                    >
                      <Icon.x size={13} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
