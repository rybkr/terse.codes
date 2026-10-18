import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { api, errorMessage, type RouterInputs, type UserState } from "../api";
import { Icon, Kbd, Spinner, Wordmark, cx, difficultyDot } from "../components/ui";

type Difficulty = RouterInputs["createRoom"]["difficulty"];
type RoomMode = "create" | "join";

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: null, label: "Any" },
  { value: "Easy", label: "Easy" },
  { value: "Medium", label: "Medium" },
  { value: "Hard", label: "Hard" },
];

const ease = [0.22, 1, 0.36, 1] as const;

function Stepper({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}) {
  const clamp = (next: number) =>
    Math.min(max, Math.max(min, Math.round(next / step) * step));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-medium text-fg-muted">
        {label}
      </label>
      <div className="group flex h-10 items-center rounded-lg border border-line-strong bg-sunken transition-colors hover:border-line-hover focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(139_140_248/0.18)]">
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - step))}
          className="flex h-full w-9 flex-none items-center justify-center rounded-l-lg text-fg-subtle transition-colors hover:text-fg disabled:opacity-30 disabled:hover:text-fg-subtle"
        >
          <Icon.minus size={14} />
        </button>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.valueAsNumber || min)}
          onBlur={() => onChange(clamp(value))}
          className="h-full w-full min-w-0 bg-transparent text-center font-mono text-[14px] tabular-nums text-fg outline-none"
        />
        {suffix && (
          <span className="pointer-events-none -ml-1 pr-1 text-[12px] text-fg-subtle">
            {suffix}
          </span>
        )}
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + step))}
          className="flex h-full w-9 flex-none items-center justify-center rounded-r-lg text-fg-subtle transition-colors hover:text-fg disabled:opacity-30 disabled:hover:text-fg-subtle"
        >
          <Icon.plus size={14} />
        </button>
      </div>
    </div>
  );
}

export default function Landing({ userState }: { userState: UserState }) {
  const navigate = useNavigate();
  const { roomId: inviteCode } = useParams();
  const joiningFromLink = inviteCode !== undefined;
  const [currentUserState, setCurrentUserState] = useState(userState);
  const [difficulty, setDifficulty] = useState<Difficulty>(null);
  const [timeLimit, setTimeLimit] = useState(5);
  const [rounds, setRounds] = useState(1);
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [pending, setPending] = useState<RoomMode | "leave" | null>(null);
  const refreshPending = useRef(false);
  const mounted = useRef(false);

  const refreshUserState = useCallback(async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshError("");
    try {
      const freshState = await api.me.query();
      if (mounted.current) setCurrentUserState(freshState);
    } catch (failure) {
      if (mounted.current) setRefreshError(errorMessage(failure));
    } finally {
      refreshPending.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setCurrentUserState(userState);
    void refreshUserState();
    const refreshOnFocus = () => void refreshUserState();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refreshUserState, userState]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>, mode: RoomMode) {
    event.preventDefault();
    if (pending !== null) return;
    setError("");
    setPending(mode);
    try {
      const session =
        mode === "create"
          ? await api.createRoom.mutate({
              difficulty,
              timeLimit: Math.round(timeLimit * 60),
              rounds,
            })
          : await api.joinRoom.mutate({
              roomId: parseRoomId(inviteCode ?? roomCode),
            });
      setCurrentUserState((current) => ({ ...current, roomId: session.roomId }));
      navigate(`/room?id=${session.roomId}`);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function leaveActiveRoom() {
    const activeRoomId = currentUserState.roomId;
    if (!activeRoomId || pending !== null) return;
    setError("");
    setPending("leave");
    try {
      await api.leave.mutate({ roomId: activeRoomId });
      setCurrentUserState((current) => ({ ...current, roomId: null }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(null);
    }
  }

  function parseRoomId(value: string) {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/join\/([^/]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    } catch {
      // The field also accepts a raw invite ID.
    }
    return trimmed;
  }

  const targetRoomId = joiningFromLink
    ? parseRoomId(inviteCode)
    : roomCode.trim()
      ? parseRoomId(roomCode)
      : null;
  const joiningDifferentRoom = currentUserState.roomId !== null
    && targetRoomId !== null
    && currentUserState.roomId !== targetRoomId;

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-5 py-14 sm:py-20">
        <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[-160px] h-[560px] w-[900px] -translate-x-1/2 rounded-full opacity-70"
          style={{
            background:
              "radial-gradient(closest-side, rgb(110 110 246 / 0.16), rgb(110 110 246 / 0.04) 55%, transparent)",
          }}
        />

        <motion.header
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease }}
          className="relative mb-8 flex flex-col items-center text-center"
        >
          <Wordmark size={64} />
          <h1 className="mt-4 text-[20px] font-medium tracking-[-0.02em] text-fg-muted sm:text-[22px]">
            {joiningFromLink ? "Join your room" : "Competitive Code Golf"}
          </h1>
        </motion.header>

        <motion.main
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease }}
          className="relative w-full max-w-3xl"
        >
          <div className="mx-auto mb-7 flex w-full max-w-sm flex-col gap-1.5 text-center">
            <p className="text-[13px] text-fg-muted">Signed in as <span className="font-medium text-fg">{currentUserState.profile.username}</span></p>
            {currentUserState.roomId && (
              <div className="flex flex-col items-center gap-1.5">
                <Link to={`/room?id=${encodeURIComponent(currentUserState.roomId)}`} className="text-[12px] text-accent hover:text-fg">
                  Resume your active room
                </Link>
                {joiningDifferentRoom && (
                  <button type="button" className="text-[12px] text-fg-subtle underline decoration-line-strong underline-offset-2 hover:text-fg" disabled={pending !== null} onClick={() => void leaveActiveRoom()}>
                    {pending === "leave" ? "Leaving active room…" : "Leave active room first"}
                  </button>
                )}
              </div>
            )}
            {refreshError && <p role="status" className="text-[11.5px] text-fg-subtle">Couldn’t refresh active room status. <button type="button" className="text-accent hover:text-fg" onClick={() => void refreshUserState()}>Retry</button></p>}
            <AnimatePresence>
              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-1 flex items-start gap-2 overflow-hidden text-[13px] text-bad"
                >
                  <Icon.alert size={15} className="mt-[2px] flex-none" />
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          <div className={joiningFromLink ? "mx-auto w-full max-w-sm" : "grid grid-cols-1 gap-7 md:grid-cols-[1fr_auto_1fr]"}>
            {!joiningFromLink && <>
            <form
              id="create-room"
              aria-labelledby="create-heading"
              onSubmit={(event) => {
                void handleSubmit(event, "create");
              }}
              className="pop flex min-w-0 flex-col gap-5 bg-raised/90 p-5 backdrop-blur-xl sm:p-6"
            >
              <h2 id="create-heading" className="text-[16px] font-semibold text-fg">
                Create a room
              </h2>
              <div className="flex flex-col gap-1.5">
                <span id="difficulty-label" className="text-[12.5px] font-medium text-fg-muted">
                  Difficulty
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="difficulty-label"
                  className="grid grid-cols-4 gap-1 rounded-lg border border-line-strong bg-sunken p-1"
                >
                  {DIFFICULTIES.map((option) => {
                    const active = difficulty === option.value;
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setDifficulty(option.value)}
                        className={cx(
                          "inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition-colors",
                          active
                            ? "bg-overlay text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong),inset_0_1px_0_rgb(255_255_255/0.05)]"
                            : "text-fg-subtle hover:bg-white/[0.03] hover:text-fg-muted",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cx(
                            "size-1.5 rounded-full transition-opacity",
                            difficultyDot[option.label],
                            !active && "opacity-50",
                          )}
                        />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex gap-3">
                <Stepper
                  id="time-limit"
                  label="Time limit"
                  value={timeLimit}
                  onChange={setTimeLimit}
                  min={1}
                  max={60}
                  step={0.5}
                  suffix="min"
                />
                <Stepper
                  id="rounds"
                  label="Rounds"
                  value={rounds}
                  onChange={setRounds}
                  min={1}
                  max={10}
                  step={1}
                />
              </div>
              <button type="submit" disabled={pending !== null} className="btn btn-primary btn-lg mt-auto w-full">
                {pending === "create" ? (
                  <>
                    <Spinner /> Creating room…
                  </>
                ) : (
                  <>
                    Create room <Kbd keys={["↵"]} />
                  </>
                )}
              </button>
            </form>

            <div aria-hidden className="border-t border-dotted border-fg-subtle/50 md:border-l md:border-t-0" />
            </>}

            <form
              id="join-room"
              aria-labelledby="join-heading"
              onSubmit={(event) => {
                void handleSubmit(event, "join");
              }}
              className="pop flex min-w-0 flex-col gap-5 bg-raised/90 p-5 backdrop-blur-xl sm:p-6"
            >
              <h2 id="join-heading" className="text-[16px] font-semibold text-fg">
                  {joiningFromLink ? "Join room" : "Join a room"}
              </h2>
              {!joiningFromLink && <div className="flex flex-col gap-1.5">
                <label htmlFor="room-code" className="text-[12.5px] font-medium text-fg-muted">
                  Room code
                </label>
                <input
                  id="room-code"
                  required
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={roomCode}
                  onChange={(event) =>
                    setRoomCode(event.target.value)
                  }
                  placeholder="Paste a room link or invite ID"
                  className="field h-12 text-center font-mono text-[14px]"
                />
                <p className="text-[12px] text-fg-subtle">
                  Ask the host for their room link or invite ID.
                </p>
              </div>}
              <button type="submit" disabled={pending !== null} className="btn btn-primary btn-lg mt-auto w-full">
                {pending === "join" ? (
                  <>
                    <Spinner /> Joining…
                  </>
                ) : (
                  <>
                    Join room <Kbd keys={["↵"]} />
                  </>
                )}
              </button>
            </form>
          </div>
        </motion.main>
        <footer className="relative mt-8 text-[12px] text-fg-subtle">
          <Link to="/privacy" className="underline underline-offset-4 hover:text-fg">Privacy policy</Link>
        </footer>
      </div>
    </MotionConfig>
  );
}
