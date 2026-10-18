import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import {
  api,
  errorMessage,
  type RoomSnapshot,
  type Submission,
} from "../api";

export type Ranking = RoomSnapshot["rankings"][number];

export function formatTimer(seconds: number) {
  const rounded = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function copySelection(text: string) {
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("Copy blocked");
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

export function useRoom() {
  const [params] = useSearchParams();
  const roomId = params.get("id") ?? "";
  const { getToken, isSignedIn } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Submission | null>(null);
  const [review, setReview] = useState<{ userId: string; name: string; code: string } | null>(
    null,
  );
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const nextToken = isSignedIn ? await getToken({ skipCache: true }) : null;
      if (active) setToken(nextToken);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [getToken, isSignedIn]);

  useEffect(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("leetrace:draft:")) sessionStorage.removeItem(key);
    }
  }, []);

  useEffect(() => {
    if (!roomId || !token) return;
    let active = true;
    let heartbeatTimer: number | undefined;
    const heartbeat = () => {
      if (!navigator.onLine) return;
      void api.heartbeat.mutate({ roomId }).catch((failure: unknown) => {
        if (active) setError(errorMessage(failure));
      });
    };
    const startHeartbeats = () => {
      if (heartbeatTimer !== undefined) return;
      heartbeat();
      heartbeatTimer = window.setInterval(heartbeat, 5_000);
      window.addEventListener("online", heartbeat);
    };
    const stopHeartbeats = () => {
      if (heartbeatTimer === undefined) return;
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      window.removeEventListener("online", heartbeat);
    };
    const subscription = api.roomUpdates.subscribe(
      { roomId, token },
      {
        onStarted() {
          setConnected(true);
          setError("");
          startHeartbeats();
        },
        onConnectionStateChange(state) {
          setConnected(state.state === "pending");
        },
        onData(snapshot) {
          setRoom(snapshot);
          setServerOffset(snapshot.serverNow - Date.now());
          setClockNow(Date.now());
          setConnected(true);
          startHeartbeats();
        },
        onError(error) {
          setConnected(false);
          setError(errorMessage(error));
          stopHeartbeats();
        },
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
      stopHeartbeats();
    };
  }, [roomId, token]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const starterCode = room?.problem?.starterCode;
  const roundId = room?.roundId;
  useEffect(() => {
    setCode(starterCode ?? "");
    setResult(null);
    setReview(null);
  }, [roomId, roundId, starterCode]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  const serverNow = clockNow + serverOffset;
  const clockRoom = room ? {
    ...room,
    remaining: room.endsAt === null ? room.remaining : Math.max(0, Math.ceil((room.endsAt - serverNow) / 1_000)),
    breakRemaining: room.breakUntil === null ? room.breakRemaining : Math.max(0, Math.ceil((room.breakUntil - serverNow) / 1_000)),
  } : null;
  const judging = clockRoom?.state === "playing" && clockRoom.remaining === 0;
  const finished = room ? room.me.locked || room.me.resigned : false;
  const readOnly =
    !room || room.state !== "playing" || finished || judging || review !== null;
  const canAct = connected && !pending;

  function submit() {
    if (readOnly || !connected) return;
    void perform(async () => {
      setResult(await api.submit.mutate({ roomId, code }));
    });
  }

  async function leave() {
    if (await perform(() => api.leave.mutate({ roomId }))) {
      navigate("/");
    }
  }

  async function copyRoom(kind: "code" | "link" = "code") {
    const text = kind === "link" ? `${window.location.origin}/join/${encodeURIComponent(roomId)}` : roomId;
    try {
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          copySelection(text);
        }
      } else {
        copySelection(text);
      }
      setError("");
      setCopied(kind);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      setError(`Couldn't copy the ${kind}. Copy it manually: ${text}`);
    }
  }

  const me = room?.rankings.find((player) => player.userId === room.me.userId);
  const waitingOn =
    room?.state === "playing"
      ? room.rankings
          .filter(
            (player) =>
              !player.resigned && player.lockedAt === null && !player.away,
          )
          .map((player) => player.name)
      : [];

  return {
    roomId,
    token,
    room: clockRoom,
    connected,
    error,
    setError,
    pending,
    canAct,
    code,
    changeCode: setCode,
    result: result ?? room?.me.submission ?? null,
    review,
    setReview,
    copied,
    copyRoom,
    me,
    isHost: room ? room.hostId === room.me.userId : false,
    finished,
    judging,
    readOnly,
    waitingOn,
    submit,
    leave,
    start: () => perform(() => api.start.mutate({ roomId })),
    lock: () => perform(() => api.lock.mutate({ roomId })),
    resign: () => perform(() => api.resign.mutate({ roomId })),
    kick: (userId: string) => perform(() => api.kick.mutate({ roomId, userId })),
    advance: () =>
      perform(() =>
        room?.breakRemaining !== null
          ? api.skipBreak.mutate({ roomId })
          : api.restart.mutate({ roomId }),
      ),
    sendChat: async (message: string) => {
      try {
        await api.chat.mutate({ roomId, message });
        return true;
      } catch (error) {
        setError(errorMessage(error));
        return false;
      }
    },
  };
}

export type RoomState = ReturnType<typeof useRoom>;
