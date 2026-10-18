import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Icon, LogoMark } from "../components/ui";

export default function PrivacyPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Privacy policy · Terse";
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <main className="relative min-h-full overflow-y-auto px-5 py-10 sm:py-16">
      <div aria-hidden className="backdrop-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-3xl">
        <nav aria-label="Privacy navigation" className="mb-8 flex items-center justify-between">
          <Link to="/" aria-label="Terse home"><LogoMark size={34} /></Link>
          <Link to="/" className="btn btn-secondary btn-sm"><Icon.arrowLeft size={14} /> Back to Terse</Link>
        </nav>
        <article className="panel p-6 sm:p-10">
          <header className="mb-8 border-b border-line pb-6">
            <h1 className="text-3xl font-semibold tracking-tight text-fg">Privacy policy</h1>
            <p className="mt-2 text-[12px] text-fg-subtle">Last updated <time dateTime="2026-10-18">October 18, 2026</time></p>
          </header>
          <div className="space-y-7 text-[14px] leading-7 text-fg-muted [&_h2]:mb-2 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-fg [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-fg [&_p+p]:mt-3">
            <p>
              Terse, available at terse.codes, is a competitive code golf game. This policy explains how
              we handle information when you create an account, play in rooms, and visit the website.
            </p>
            <section aria-labelledby="privacy-account">
              <h2 id="privacy-account">Account information</h2>
              <p>
                Clerk manages authentication, passwords, email verification, and sign-in sessions.
                Depending on how you sign up, Clerk receives your email address, username, password,
                and basic profile information from Google or GitHub, such as your name and profile picture.
                Terse does not store your password in its application database or display your email to other players.
              </p>
              <p>
                Our application database stores your Clerk account ID, username, session identifiers,
                and gameplay records. These records include solved problems, scores, ratings, round and
                tournament results, wins, and streaks. We use them to run matches, maintain your profile,
                calculate statistics, and prevent duplicate results.
              </p>
              <p>
                Google account information is used to authenticate and manage your account. We do not
                sell Google account information or use it for advertising.
              </p>
            </section>
            <section aria-labelledby="privacy-rooms">
              <h2 id="privacy-rooms">Rooms, submissions, and other players</h2>
              <p>
                Players in your room can see your username, presence, chat messages, and match performance.
                Anyone with a room invite can attempt to join after signing in, subject to room capacity,
                round state, and host controls. Share invite links only with people you want to play with.
              </p>
              <p>
                Submission source code is processed for judging and held temporarily for review after a round.
                Other players in the room can view and copy the retained solution during that review.
                We do not save submission source code or chat messages in the application database.
                Retained solutions are cleared when the next round starts or the room ends.
                Rooms end when everyone leaves, and room state is lost if the server restarts.
                Copies made by other players are outside our control.
              </p>
            </section>
            <section aria-labelledby="privacy-storage">
              <h2 id="privacy-storage">Browser storage and technical information</h2>
              <p>
                Clerk uses cookies and browser storage to keep you signed in and secure your account.
                Terse saves editor pane layout preferences in local storage. Our server uses IP addresses
                temporarily to limit requests and prevent abuse. Our hosting and authentication providers
                may also process connection information, device and browser information, and operational logs
                to deliver and protect their services. Terse does not include advertising or analytics trackers.
              </p>
            </section>
            <section aria-labelledby="privacy-providers">
              <h2 id="privacy-providers">Services that process information</h2>
              <p>
                We use <a href="https://clerk.com/legal/privacy">Clerk</a> for authentication,
                <a href="https://www.convex.dev/legal/privacy"> Convex</a> for account and gameplay data,
                and <a href="https://fly.io/legal/privacy-policy/">Fly.io</a> to host the application and judge submissions.
                Your browser also requests fonts from <a href="https://developers.google.com/fonts/faq/privacy">Google Fonts</a>.
                Google or GitHub processes your sign-in if you choose that provider.
                These services may process information in countries other than your own.
              </p>
              <p>
                We share information with service providers as needed to operate Terse, with other players
                as described above, and when necessary to meet legal obligations or protect the service.
              </p>
            </section>
            <section aria-labelledby="privacy-retention">
              <h2 id="privacy-retention">Retention and account deletion</h2>
              <p>
                Account and gameplay records are kept while your account is active. Historical scoring
                records have no automatic expiry. When your Clerk account is deleted and the deletion event
                is processed, Terse disables the account and removes its username and active session information.
                Internal account IDs, statistics, and historical match records can remain to preserve scoring
                integrity and prevent a deleted account from being restored by delayed events.
                Provider logs and backups follow the relevant provider&apos;s retention practices.
              </p>
              <p>
                You can stop using Terse, revoke its access in your Google or GitHub account settings,
                or contact us to request access, correction, or deletion of your information.
                Revoking Google or GitHub access does not by itself delete your Terse account.
                We may need to verify account ownership before acting on a request.
              </p>
            </section>
            <section aria-labelledby="privacy-contact">
              <h2 id="privacy-contact">Contact</h2>
              <p>
                For privacy questions or requests about your account information, contact the Terse team
                at <a href="mailto:voldyone72@gmail.com">voldyone72@gmail.com</a>.
                Please do not send passwords or submission source code in your request.
              </p>
            </section>
            <section aria-labelledby="privacy-changes">
              <h2 id="privacy-changes">Changes to this policy</h2>
              <p>
                We will publish changes on this page and update the date above. If our data practices change
                materially, we will provide an appropriate notice.
              </p>
            </section>
          </div>
        </article>
      </div>
    </main>
  );
}
