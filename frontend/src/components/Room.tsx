import { useEffect, useRef, type MutableRefObject } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useClerk } from "@clerk/react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { useRoom, formatTimer, type RoomState } from "../hooks/useRoom";
import { usePaneLayout, type PaneLayout } from "../hooks/usePaneLayout";
import CodeEditor, { type EditorInstance } from "./CodeEditor";
import { ChatDock } from "./Chat";
import { ResultsPane } from "./Results";
import { ProblemDescription } from "./ProblemDescription";
import { Finished, Lobby, TournamentResults } from "./RoomViews";
import { StandingsStrip } from "./Standings";
import { editorFont, graphiteTheme } from "./editorTheme";
import {
  Avatar,
  DifficultyPill,
  Icon,
  Kbd,
  LogoMark,
  Spinner,
  cx,
  shortcuts,
} from "./ui";

function listNames(names: string[]) {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function Timer({ remaining, total }: { remaining: number; total: number }) {
  const danger = remaining <= 30;
  return (
    <div
      role="timer"
      aria-label={`${formatTimer(remaining)} remaining`}
      className={cx(
        "flex h-8 items-center gap-2 rounded-lg border px-2 transition-colors sm:px-3",
        danger
          ? "border-bad/35 bg-bad/10 text-bad"
          : "border-line bg-surface text-fg",
      )}
    >
      <Icon.clock size={15} className={danger ? "text-bad" : "text-fg-subtle"} />
      <span
        className={cx(
          "font-mono text-[18px] font-medium leading-none tracking-[-0.02em] tabular-nums sm:text-[20px]",
          danger && "animate-pulse-soft",
        )}
      >
        {formatTimer(remaining)}
      </span>
      <span className="sr-only">of {formatTimer(total)}</span>
    </div>
  );
}

function Header({ r }: { r: RoomState }) {
  const { signOut } = useClerk();
  const room = r.room!;
  const playing = room.state === "playing";
  const progress = playing && room.timeLimit ? Math.max(0, room.remaining / room.timeLimit) : 0;

  return (
    <header className="relative grid h-12 flex-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-line px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={() => {
            void r.leave();
          }}
          disabled={!r.canAct}
          aria-label="Leave room and go home"
          title="Leave room and go home"
          className="flex flex-none items-center gap-2 rounded-md disabled:opacity-45"
        >
          <LogoMark size={22} />
          <span className="hidden text-[14px] font-semibold tracking-[-0.02em] text-fg xl:inline">
            terse<span className="text-fg-muted">.codes</span>
          </span>
        </button>
        <span aria-hidden className="hidden h-4 w-px flex-none bg-line-strong sm:block" />
        <span className="hidden h-7 flex-none items-center rounded-md border border-line bg-surface px-2 font-mono text-[12px] tracking-[0.14em] text-fg-muted sm:inline-flex">
          {r.roomId}
        </span>
      </div>

      <div className="flex items-center justify-center gap-2 sm:gap-3">
        {room.state !== "lobby" && (
          <span className="flex-none whitespace-nowrap text-[12px] tabular-nums text-fg-muted">
            Round {room.currentRound}/{room.totalRounds}
          </span>
        )}
        {playing && !r.review && r.judging ? (
          <span role="status" className="whitespace-nowrap text-[12.5px] text-warn">Judging submissions…</span>
        ) : playing && !r.review ? (
          <Timer remaining={room.remaining} total={room.timeLimit} />
        ) : room.state === "finished" && room.breakRemaining !== null ? (
          <span className="flex items-center gap-2 text-[12.5px] text-fg-subtle">
            Next round in
            <span className="font-mono text-[15px] tabular-nums text-fg">
              {formatTimer(room.breakRemaining)}
            </span>
          </span>
        ) : room.state === "lobby" ? null : (
          <span className="text-[12.5px] text-fg-subtle">Race complete</span>
        )}
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
        <Link to="/profile" aria-label="Open player profile" title="Player profile" className="rounded-full">
          <Avatar name={room.me.name} size={22} />
        </Link>
        <button type="button" onClick={() => void signOut({ redirectUrl: "/sign-in" })} className="btn btn-ghost btn-sm px-1.5 sm:px-2" aria-label="Sign out">
          <Icon.leave size={14} /> <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>

      {playing && !r.review && (
        <div aria-hidden className="absolute inset-x-0 -bottom-px h-px">
          <div
            className={cx(
              "h-full transition-[width] duration-1000 ease-linear",
              room.remaining <= 30 ? "bg-bad" : "bg-accent/70",
            )}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </header>
  );
}

function FinishedBanner({ r }: { r: RoomState }) {
  const room = r.room!;
  if (r.review || !r.finished || room.state !== "playing") return null;
  const waiting = r.waitingOn.length
    ? `waiting on ${listNames(r.waitingOn)}`
    : "wrapping up the round";
  return (
    <div
      role="status"
      className={cx(
        "flex flex-none items-center gap-2 border-b px-3 py-2 text-[12.5px]",
        room.me.locked
          ? "border-warn/15 bg-warn/[0.06] text-warn"
          : "border-line bg-white/[0.025] text-fg-muted",
      )}
    >
      {room.me.locked ? <Icon.lock size={14} /> : <Icon.flag size={14} />}
      <span className="min-w-0 truncate">
        <span className={cx("font-medium", room.me.locked ? "text-warn" : "text-fg")}>
          {room.me.locked
            ? `Score locked${r.me?.charCount ? ` at ${r.me.charCount} chars` : ""}`
            : "You resigned"}
        </span>
        <span className="text-fg-muted"> · {waiting}</span>
      </span>
      {r.waitingOn.length > 0 && <Spinner className="ml-auto text-fg-subtle" />}
    </div>
  );
}

function EditorToolbar({ r }: { r: RoomState }) {
  const chars = Array.from(r.review?.code ?? r.code).length;
  return (
    <header className="@container flex h-10 flex-none items-center gap-2 border-b border-line pl-3 pr-1.5">
      <span className="flex flex-none items-center gap-1.5 text-fg-muted">
        <Icon.file size={14} className="text-fg-subtle" />
        <span className="font-mono text-[12.5px]">solution.py</span>
      </span>
      <span className="hidden whitespace-nowrap font-mono text-[12px] tabular-nums text-fg-subtle @[36rem]:inline">
        {chars} chars
      </span>
      {r.review && (
        <span className="pill pill-accent ml-1 min-w-0 shrink">
          <Icon.eye size={11} className="flex-none" />
          <span className="truncate">
            {r.review.userId === r.room?.me.userId ? "Your code" : `${r.review.name}’s code`}
          </span>
        </span>
      )}
      <div className="ml-auto flex flex-none items-center gap-1.5">
        {r.review ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => r.setReview(null)}>
            <Icon.arrowLeft size={14} />
            Back to results
          </button>
        ) : (
          <>
            {!r.finished && (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={!r.canAct || r.readOnly}
                  onClick={() => {
                    void r.resign();
                  }}
                  title="Give up this round"
                >
                  <Icon.flag size={13} className="hidden @[26rem]:block" />
                  Resign
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!r.canAct || r.readOnly || !r.me?.solved}
                  onClick={() => {
                    void r.lock();
                  }}
                  title={
                    r.me?.solved
                      ? "Lock in your best solution and finish the round"
                      : "Solve the problem to lock your score"
                  }
                >
                  <Icon.lock size={13} className="hidden @[26rem]:block" />
                  Lock score
                </button>
              </>
            )}
            {r.finished ? (
              <span className="pill mr-1.5">Read-only</span>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!r.canAct || r.readOnly}
                onClick={r.submit}
              >
                {r.pending ? <Spinner /> : null}
                {r.pending ? "Running" : "Submit"}
                {!r.pending && <Kbd keys={shortcuts.submit} className="hidden @[28rem]:inline-flex" />}
              </button>
            )}
          </>
        )}
      </div>
    </header>
  );
}

function Workspace({
  r,
  layout,
  editorRef,
}: {
  r: RoomState;
  layout: PaneLayout;
  editorRef: MutableRefObject<EditorInstance | null>;
}) {
  const room = r.room!;
  const problem = room.problem!;
  const wide = layout.wide;

  useEffect(
    () => () => {
      editorRef.current = null;
    },
    [editorRef],
  );

  return (
    <>
      <section
        aria-label="Problem"
        className={cx("panel flex min-h-0 flex-col overflow-hidden", !wide && "h-[420px] flex-none")}
        style={wide ? { flex: "1 1 0", minWidth: 0 } : undefined}
      >
        <header className="flex h-10 flex-none items-center gap-2 border-b border-line px-3">
          <Icon.doc size={14} className="text-fg-subtle" />
          <h2 className="text-[13px] font-medium text-fg">Description</h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-5">
          <h1 className="text-[19px] font-semibold leading-snug tracking-[-0.02em] text-fg">
            {problem.title}
          </h1>
          <div className="mb-5 mt-2">
            <DifficultyPill difficulty={problem.difficulty} />
          </div>
          <ProblemDescription statement={problem.statement} />
        </div>
      </section>

      {wide && <div {...layout.handleProps("problem")} className="handle" />}

      <div
        ref={layout.columnRef}
        className={cx("flex min-h-0 flex-col", !wide && "flex-none gap-2")}
        style={wide ? { flex: `0 0 ${layout.editorWidth}px` } : undefined}
      >
        <section
          aria-label="Editor"
          className={cx("panel flex min-h-0 flex-col overflow-hidden", wide ? "flex-1" : "h-[460px] flex-none")}
        >
          <EditorToolbar r={r} />
          {r.judging && <div role="status" className="border-b border-warn/20 bg-warn/[0.06] px-3 py-1.5 text-[12px] text-warn">Time is up. Judging queued submissions…</div>}
          <FinishedBanner r={r} />
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <CodeEditor
                key={room.roundId}
                value={r.review?.code ?? r.code}
                onChange={r.changeCode}
                readOnly={r.readOnly}
                onSubmit={r.submit}
                theme={graphiteTheme}
                fontFamily={editorFont}
                onEditor={(editor) => {
                  editorRef.current = editor;
                  void document.fonts
                    ?.load(`14px ${editorFont}`)
                    .then(() => monaco.editor.remeasureFonts());
                }}
                loading={
                  <span className="flex items-center gap-2 text-[13px] text-fg-subtle">
                    <Spinner /> Loading editor…
                  </span>
                }
              />
            </div>
          </div>
        </section>

        {wide && <div {...layout.handleProps("results")} className="handle" />}

        <section
          aria-label="Results"
          className="panel flex flex-none flex-col overflow-hidden"
          style={{ height: wide ? layout.resultsHeight : 280 }}
        >
          <ResultsPane
            result={r.review ? null : r.result}
            pending={r.pending && !r.review}
            review={
              r.review
                ? {
                    name: r.review.name,
                    row: room.rankings.find((player) => player.userId === r.review?.userId),
                  }
                : null
            }
          />
        </section>
      </div>
    </>
  );
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
      <AnimatePresence>
        {message && (
          <motion.div
            key="toast"
            role="alert"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="pop pointer-events-auto flex max-w-[520px] items-start gap-2.5 py-2.5 pl-3 pr-1.5"
          >
            <Icon.alert size={16} className="mt-[1px] flex-none text-bad" />
            <p className="min-w-0 flex-1 py-[1px] text-[13px] text-fg [overflow-wrap:anywhere]">{message}</p>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss error"
              className="btn btn-ghost btn-sm btn-icon -my-0.5"
            >
              <Icon.x size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Connecting({ roomId, error }: { roomId: string; error: string }) {
  return (
    <main className="relative flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <LogoMark size={36} />
      <p className="relative flex items-center gap-2 text-[14px] text-fg-muted">
        {error ? <Icon.wifiOff size={15} className="text-bad" /> : <Spinner />}
        {error ? "Couldn’t connect to room" : "Connecting to room"}
        <span className="font-mono tracking-[0.12em] text-fg">{roomId}</span>
      </p>
      {error && (
        <p role="alert" className="relative max-w-sm text-[13px] text-bad">
          {error}
        </p>
      )}
      <Link to="/" className="btn btn-secondary btn-sm relative">
        <Icon.arrowLeft size={14} />
        Back home
      </Link>
    </main>
  );
}

export default function Room() {
  const r = useRoom();
  const location = useLocation();
  const editorRef = useRef<EditorInstance | null>(null);
  const layout = usePaneLayout({
    messageCount: r.room?.messages.length ?? 0,
    onChatClosed: () => editorRef.current?.focus(),
  });

  if (!r.roomId) return <Navigate to="/" replace />;
  if (!r.token || !r.room) return <Connecting roomId={r.roomId} error={r.error} />;

  const room = r.room;
  if (location.pathname === "/room/results") {
    return room.state === "finished"
      ? <TournamentResults r={r} />
      : <Navigate to={`/room?id=${encodeURIComponent(r.roomId)}`} replace />;
  }
  const workspace = room.problem !== null && (room.state === "playing" || r.review !== null);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col overflow-hidden">
        <Header r={r} />
        {room.state === "playing" && !r.review && (
          <StandingsStrip room={room} isHost={r.isHost} onKick={r.kick} />
        )}
        <div
          ref={layout.containerRef}
          className={cx(
            "flex min-h-0 flex-1 px-2 pb-2",
            !(room.state === "playing" && !r.review) && "pt-2",
            layout.wide ? "flex-row" : "flex-col gap-2 overflow-y-auto",
          )}
        >
          {workspace ? (
            <Workspace r={r} layout={layout} editorRef={editorRef} />
          ) : room.state === "lobby" ? (
            <Lobby r={r} />
          ) : (
            <Finished r={r} />
          )}
          <ChatDock room={room} layout={layout} onSend={r.sendChat} />
        </div>
        <Toast message={r.error} onDismiss={() => r.setError("")} />
      </div>
    </MotionConfig>
  );
}
