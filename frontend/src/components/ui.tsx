import type { ReactNode, SVGProps } from "react";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export const shortcuts = {
  submit: isMac ? ["⌘", "↵"] : ["Ctrl", "↵"],
  chat: isMac ? ["⌃", "D"] : ["Ctrl", "D"],
};

export function Kbd({
  keys,
  className,
}: {
  keys: string[];
  className?: string;
}) {
  return (
    <kbd className={cx("kbd", className)}>
      {keys.map((key) => (
        <span key={key}>{key}</span>
      ))}
    </kbd>
  );
}

function hashHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "?";
}

export function Avatar({
  name,
  size = 24,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const hue = hashHue(name);
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full font-medium select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        color: `hsl(${hue} 75% 82%)`,
        background: `hsl(${hue} 32% 20%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 40% 34% / 0.7)`,
      }}
    >
      {initials(name)}
    </span>
  );
}

const difficultyTone = {
  Easy: "pill-ok",
  Medium: "pill-warn",
  Hard: "pill-bad",
} as const;

export function DifficultyPill({ difficulty }: { difficulty: string | null }) {
  const tone =
    difficulty && difficulty in difficultyTone
      ? difficultyTone[difficulty as keyof typeof difficultyTone]
      : "";
  return <span className={cx("pill", tone)}>{difficulty ?? "Any"}</span>;
}

export const difficultyDot: Record<string, string> = {
  Any: "bg-fg-subtle",
  Easy: "bg-ok",
  Medium: "bg-warn",
  Hard: "bg-bad",
};

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="8"
        fill="#151519"
        stroke="#2e2e35"
        strokeWidth="1.5"
      />
      <path
        d="M7.5 11h6M5.5 16h8M7.5 21h6"
        stroke="#6b6b75"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M17 9.5l6.5 6.5-6.5 6.5"
        fill="none"
        stroke="#8b8cf8"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      <span
        className="font-semibold tracking-[-0.02em] text-fg"
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        terse<span className="text-fg-muted">.codes</span>
      </span>
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-3.5 flex-none animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80",
        className,
      )}
    />
  );
}

export function LiveDot({ tone = "ok" }: { tone?: "ok" | "warn" | "accent" }) {
  const color =
    tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <span aria-hidden className="relative inline-flex size-1.5 flex-none">
      <span
        className={cx(
          "absolute inset-0 rounded-full animate-ping-dot motion-reduce:hidden",
          color,
        )}
      />
      <span className={cx("relative size-1.5 rounded-full", color)} />
    </span>
  );
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function icon(path: ReactNode) {
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {path}
      </svg>
    );
  };
}

export const Icon = {
  user: icon(
    <>
      <circle cx="8" cy="5.25" r="2.5" />
      <path d="M3 13.5v-1.25a5 5 0 0 1 10 0v1.25z" />
    </>,
  ),
  copy: icon(
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
      <path d="M10.5 3.5v-.25A1.25 1.25 0 0 0 9.25 2h-6A1.25 1.25 0 0 0 2 3.25v6A1.25 1.25 0 0 0 3.25 10.5h.25" />
    </>,
  ),
  check: icon(<path d="M3.5 8.5l3 3 6-7" />),
  x: icon(<path d="M4 4l8 8M12 4l-8 8" />),
  chat: icon(
    <path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7l-3 2.5v-2.5h.25c-.83 0-1.5-.67-1.5-1.5z" />,
  ),
  send: icon(<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />),
  leave: icon(
    <>
      <path d="M6.5 2.75h-2.5c-.69 0-1.25.56-1.25 1.25v8c0 .69.56 1.25 1.25 1.25h2.5" />
      <path d="M10.5 11l3-3-3-3M13.25 8H6.5" />
    </>,
  ),
  play: icon(<path d="M5 3.5v9l7-4.5z" fill="currentColor" strokeWidth={1} />),
  lock: icon(
    <>
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ),
  flag: icon(
    <path d="M3.5 14V2.75M3.5 3h7.75l-1.5 3 1.5 3H3.5" />,
  ),
  clock: icon(
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2 1.5" />
    </>,
  ),
  file: icon(
    <>
      <path d="M9 2H4.75C4.06 2 3.5 2.56 3.5 3.25v9.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5z" />
      <path d="M9 2v3.5h3.5" />
    </>,
  ),
  doc: icon(
    <>
      <path d="M3.5 3.5h9M3.5 6.5h9M3.5 9.5h9M3.5 12.5h5.5" />
    </>,
  ),
  terminal: icon(
    <>
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" />
      <path d="M4.75 6.25L6.75 8l-2 1.75M8.5 10h2.75" />
    </>,
  ),
  alert: icon(
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5v3.25M8 10.75v.01" />
    </>,
  ),
  circleCheck: icon(
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.75 8.25l1.5 1.5 3-3.25" />
    </>,
  ),
  circleX: icon(
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.25 6.25l3.5 3.5M9.75 6.25l-3.5 3.5" />
    </>,
  ),
  arrowLeft: icon(<path d="M12.5 8h-9M7 4.5L3.5 8 7 11.5" />),
  eye: icon(
    <>
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.75" />
    </>,
  ),
  users: icon(
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2 13c0-2.2 1.8-3.75 4-3.75s4 1.55 4 3.75" />
      <path d="M10.5 3.4a2.25 2.25 0 0 1 0 4.2M12 9.6c1.2.5 2 1.75 2 3.4" />
    </>,
  ),
  minus: icon(<path d="M4 8h8" />),
  plus: icon(<path d="M8 4v8M4 8h8" />),
  trophy: icon(
    <>
      <path d="M5 2.75h6v3.5a3 3 0 0 1-6 0z" />
      <path d="M5 4H3.25v.75A2.25 2.25 0 0 0 5.2 7M11 4h1.75v.75A2.25 2.25 0 0 1 10.8 7M8 9.25v2.5M5.5 13.25h5" />
    </>,
  ),
  wifiOff: icon(
    <>
      <path d="M2 2l12 12M8 12.5v.01M5.75 10.25a3.2 3.2 0 0 1 4.1-.35M3.5 7.75a6.3 6.3 0 0 1 3-1.6M12.5 7.75a6.3 6.3 0 0 0-1.55-1.1" />
    </>,
  ),
};
