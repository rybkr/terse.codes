import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Landing from "./pages/Landing";
import ProfilePage from "./pages/Profile";
import { api, errorMessage, setTokenProvider, type UserState } from "./api";
import { Icon, LogoMark, Spinner } from "./components/ui";

const Room = lazy(() => import("./components/Room"));

const sessions = new Map<string, Promise<UserState>>();
const usernamePattern = "[A-Za-z0-9_]{4,12}";
const validUsername = /^[A-Za-z0-9_]{4,12}$/;
const usernameMessage = "Use 4–12 letters, numbers, or underscores.";

function returnPath(value: string | null) {
  const hasControlCharacter = value?.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || hasControlCharacter) return "/";
  if (value.startsWith("/sign-in") || value.startsWith("/sign-up")) return "/";
  const target = new URL(value, window.location.origin);
  if (target.origin !== window.location.origin) return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-full items-center justify-center overflow-y-auto px-5 py-12">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <div className="relative flex w-full flex-col items-center gap-5">
        <Link to="/" aria-label="Terse home"><LogoMark size={38} /></Link>
        {children}
        <footer className="max-w-sm text-center text-[12px] leading-relaxed text-fg-muted">
          <p>Terse is a competitive code golf game. Solve programming problems with friends using the fewest characters.</p>
          <Link to="/privacy" className="mt-2 inline-block text-accent underline underline-offset-4 hover:text-fg">Privacy policy</Link>
        </footer>
      </div>
    </main>
  );
}

function AuthPages() {
  const location = useLocation();
  const signupRef = useRef<HTMLDivElement>(null);
  const isSignUp = location.pathname.startsWith("/sign-up");
  const query = new URLSearchParams(location.search);
  const redirect = returnPath(query.get("redirect_url"));
  const appearance = {
    variables: {
      colorPrimary: "#8b8cf8",
      colorBackground: "#151519",
      colorInputBackground: "#0b0b0e",
      colorInputText: "#ededef",
      colorText: "#ededef",
      colorTextSecondary: "#a1a1aa",
      colorNeutral: "#a1a1aa",
      borderRadius: "0.65rem",
      fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
    },
    elements: {
      card: "!bg-raised !border-line-strong !shadow-pop",
      headerTitle: "!text-fg",
      headerSubtitle: "!text-fg-muted",
      formFieldLabel: "!text-fg-muted",
      formFieldInput: "!bg-sunken !border-line-strong !text-fg",
      footerActionText: "!text-fg-muted",
      footerActionLink: "!text-accent",
      dividerLine: "!bg-line-strong",
      dividerText: "!text-fg-subtle",
      socialButtonsBlockButton: "!bg-surface !border-line-strong !text-fg",
    },
  } as const;

  useEffect(() => {
    const root = signupRef.current;
    if (!isSignUp || !root) return;

    const configureUsernameInputs = () => {
      const inputs = root.querySelectorAll<HTMLInputElement>('input[name="username"]');
      inputs.forEach((input) => {
        input.pattern = usernamePattern;
        input.minLength = 4;
        input.maxLength = 12;
        input.required = true;
        input.setCustomValidity(input.value && !validUsername.test(input.value) ? usernameMessage : "");
      });
    };

    configureUsernameInputs();
    const observer = new MutationObserver(configureUsernameInputs);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isSignUp]);

  function validateUsernameInput(event: FormEvent<HTMLDivElement>) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "username") return;
    input.pattern = usernamePattern;
    input.minLength = 4;
    input.maxLength = 12;
    input.required = true;
    input.setCustomValidity(input.value && !validUsername.test(input.value) ? usernameMessage : "");
  }

  return (
    <AuthCard>
      {isSignUp ? (
        <div ref={signupRef} onInputCapture={validateUsernameInput} className="flex flex-col items-center gap-3">
          <p className="max-w-[360px] text-center text-[12.5px] text-fg-muted">Choose a unique username using 4–12 letters, numbers, or underscores. Players will see this name in rooms.</p>
          <SignUp
            routing="path"
            path="/sign-up"
            signInUrl={`/sign-in?redirect_url=${encodeURIComponent(redirect)}`}
            forceRedirectUrl={redirect}
            fallbackRedirectUrl={redirect}
            appearance={appearance}
          />
        </div>
      ) : (
        <SignIn
          routing="path"
          path="/sign-in"
          signUpUrl={`/sign-up?redirect_url=${encodeURIComponent(redirect)}`}
          forceRedirectUrl={redirect}
          fallbackRedirectUrl={redirect}
          appearance={appearance}
        />
      )}
    </AuthCard>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <main className="flex h-full items-center justify-center gap-2.5 text-[13px] text-fg-subtle">
      <Spinner /> {label}
    </main>
  );
}

function AuthActions() {
  const { signOut } = useClerk();
  const location = useLocation();
  if (location.pathname === "/room") return null;
  return (
    <nav aria-label="Account" className="absolute right-4 top-4 z-20 flex items-center gap-2">
      <Link className="btn btn-secondary btn-sm" to="/profile">
        <Icon.user size={13} /> Profile
      </Link>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => void signOut({ redirectUrl: "/sign-in" })}>
        Sign out
      </button>
    </nav>
  );
}

export default function App() {
  const { isLoaded, isSignedIn, sessionId, getToken } = useAuth();
  const clerk = useClerk();
  const location = useLocation();
  const authPage = location.pathname.startsWith("/sign-in") || location.pathname.startsWith("/sign-up");
  const [loadedState, setLoadedState] = useState<{ sessionId: string; state: UserState } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setTokenProvider(getToken);
    return () => setTokenProvider(null);
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !sessionId) {
      if (isLoaded && !isSignedIn) sessions.clear();
      setLoadedState(null);
      setError("");
      return;
    }

    let active = true;
    let request = sessions.get(sessionId);
    if (!request) {
      const bootstrap = api.signIn.mutate().then(() => api.me.query());
      sessions.set(sessionId, bootstrap);
      request = bootstrap;
    }
    const currentRequest = request;
    setError("");
    void currentRequest.then(
      (state) => {
        if (active) setLoadedState({ sessionId, state });
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [getToken, isLoaded, isSignedIn, retry, sessionId]);

  if (!isLoaded) return <Loading label="Loading account…" />;
  if (authPage) {
    const destination = returnPath(new URLSearchParams(location.search).get("redirect_url"));
    return isSignedIn ? <Navigate to={destination} replace /> : <AuthPages />;
  }
  if (!isSignedIn) {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/sign-in?redirect_url=${encodeURIComponent(returnPath(redirect))}`} replace />;
  }
  if (error) {
    return (
      <AuthCard>
        <section className="pop w-full max-w-md p-6 text-center">
          <h1 className="text-[17px] font-semibold text-fg">Couldn’t connect your account</h1>
          <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p>
          <p className="mt-3 text-[12.5px] text-fg-muted">If this account was signed in somewhere else, this session may have been replaced. Sign out and sign in again to continue.</p>
          <div className="mt-5 flex justify-center gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => { if (sessionId) sessions.delete(sessionId); setRetry((value) => value + 1); }}>Try again</button>
            <button type="button" className="btn btn-primary" onClick={() => void clerk.signOut({ redirectUrl: "/sign-in" })}>Sign out</button>
          </div>
        </section>
      </AuthCard>
    );
  }
  const userState = loadedState?.sessionId === sessionId ? loadedState.state : null;
  if (!userState) return <Loading label="Connecting your account…" />;

  return (
    <>
      <AuthActions />
      <Suspense fallback={<Loading label="Loading room…" />}>
        <Routes>
          <Route path="/" element={<Landing userState={userState} />} />
          <Route path="/join/:roomId" element={<Landing userState={userState} />} />
          <Route path="/profile" element={<ProfilePage profile={userState.profile} />} />
          <Route path="/room" element={<Room />} />
          <Route path="/room/results" element={<Room />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
