import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { RoomSnapshot } from "../api";
import type { PaneLayout } from "../hooks/usePaneLayout";
import { Avatar, Icon, cx, shortcuts } from "./ui";

const MAX_LENGTH = 200;

function ChatPanel({
  room,
  onSend,
  onClose,
  inputRef,
}: {
  room: RoomSnapshot;
  onSend: (message: string) => Promise<boolean>;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [room.messages.length]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    if (await onSend(message)) setText("");
    setSending(false);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 flex-none items-center gap-2 border-b border-line pl-3 pr-1.5">
        <Icon.chat size={14} className="text-fg-subtle" />
        <h2 className="text-[13px] font-medium text-fg">Chat</h2>
        <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
          {room.messages.length}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            title={`Close chat (${shortcuts.chat.join(" + ")})`}
            className="btn btn-ghost btn-sm btn-icon"
          >
            <Icon.x size={14} />
          </button>
        </span>
      </header>

      <div
        ref={list}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {room.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13px] text-fg-muted">No messages yet</p>
            <p className="text-[12px] text-fg-subtle">
              Everyone in the room can see what you send.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col">
            {room.messages.map((message, index) => {
              const mine = message.senderId === room.me.userId;
              const grouped = room.messages[index - 1]?.sender === message.sender;
              return (
                <li
                  key={message.id}
                  className={cx(
                    "flex gap-2",
                    grouped ? "mt-1" : index > 0 && "mt-3",
                    mine && "flex-row-reverse",
                  )}
                >
                  {!mine &&
                    (grouped ? (
                      <span className="w-[22px] flex-none" />
                    ) : (
                      <Avatar name={message.sender} size={22} className="mt-[1px]" />
                    ))}
                  <div className={cx("flex min-w-0 max-w-[85%] flex-col", mine && "items-end")}>
                    {!grouped && !mine && (
                      <span className="mb-0.5 text-[12px] font-medium text-fg-muted">
                        {message.sender}
                      </span>
                    )}
                    <p
                      className={cx(
                        "whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[13px] leading-snug [overflow-wrap:anywhere]",
                        mine
                          ? "border border-accent/25 bg-accent-strong/15 text-fg"
                          : "border border-line bg-raised text-[#dcdce0]",
                      )}
                    >
                      {message.message}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <form
        onSubmit={(event) => {
          void send(event);
        }}
        className="flex-none border-t border-line p-2"
      >
        <div className="flex items-center gap-1 rounded-lg border border-line-strong bg-sunken pr-1 transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(139_140_248/0.18)]">
          <input
            ref={inputRef}
            aria-label="Chat message"
            className="h-9 min-w-0 flex-1 bg-transparent pl-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_LENGTH}
            placeholder="Message the room…"
            autoComplete="off"
          />
          {text.length > MAX_LENGTH - 50 && (
            <span
              className={cx(
                "font-mono text-[11px] tabular-nums",
                text.length >= MAX_LENGTH ? "text-warn" : "text-fg-subtle",
              )}
            >
              {MAX_LENGTH - text.length}
            </span>
          )}
          <button
            type="submit"
            disabled={sending || !text.trim()}
            aria-label="Send message"
            className="btn btn-primary btn-sm btn-icon !h-7 !w-7"
          >
            <Icon.send size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-strong px-1 font-mono text-[10px] font-medium tabular-nums text-white shadow-[0_0_0_2px_var(--color-surface)]">
      {count > 9 ? "9+" : count}
    </span>
  );
}

const CHAT_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const CHAT_MS = 240;

/** The chat rail expands into a single resizable pane on wide screens. */
export function ChatDock({
  room,
  layout,
  onSend,
}: {
  room: RoomSnapshot;
  layout: PaneLayout;
  onSend: (message: string) => Promise<boolean>;
}) {
  const { chatOpen: open, chatWidth, dragging, unread, toggleChat } = layout;

  if (!layout.wide)
    return (
      <>
        <button
          type="button"
          onClick={() => toggleChat(true)}
          aria-label={unread ? `Open chat, ${unread} unread` : "Open chat"}
          aria-expanded={open}
          className="pop fixed bottom-4 right-4 z-30 flex h-11 items-center gap-2 rounded-full pl-3.5 pr-3 text-[13px] font-medium text-fg"
          style={{ visibility: open ? "hidden" : "visible" }}
        >
          <Icon.chat size={16} />
          Chat
          {unread > 0 && (
            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-strong px-1 font-mono text-[10.5px] tabular-nums text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
        <AnimatePresence>
          {open && (
            <>
              <motion.div
                key="scrim"
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => toggleChat(false)}
                className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
              />
              <motion.aside
                key="drawer"
                aria-label="Room chat"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="fixed inset-y-0 right-0 z-50 w-[min(360px,100vw)] border-l border-line-strong bg-surface shadow-[var(--shadow-pop)]"
              >
                <ChatPanel
                  room={room}
                  onSend={onSend}
                  onClose={() => toggleChat(false)}
                  inputRef={layout.chatInputRef}
                />
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      </>
    );

  return (
    <div
      className="flex min-h-0 min-w-0"
      style={{
        flex: `0 0 ${open ? chatWidth + 16 : 52}px`,
        transition: dragging ? "none" : `flex-basis ${CHAT_MS}ms ${CHAT_EASE}`,
      }}
    >
      <div
        {...layout.handleProps("chat")}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        className="handle"
        style={{ width: open ? 8 : 0, visibility: open ? "visible" : "hidden" }}
      />
      <aside aria-label="Chat dock" className="panel relative ml-2 flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          role="region"
          aria-label="Room chat"
          aria-hidden={!open}
          className="min-h-0 flex-none"
          style={{ display: open ? undefined : "none", width: chatWidth - 2 }}
        >
          <ChatPanel
            room={room}
            onSend={onSend}
            onClose={() => toggleChat(false)}
            inputRef={layout.chatInputRef}
          />
        </div>
        <nav
          aria-label="Side panels"
          className="absolute inset-y-0 right-0 flex w-[42px] items-center justify-center"
          style={{ visibility: open ? "hidden" : "visible" }}
        >
          <button
            type="button"
            onClick={() => toggleChat()}
            aria-label={open ? "Close chat" : unread ? `Open chat, ${unread} unread` : "Open chat"}
            aria-expanded={open}
            title={`Chat (${shortcuts.chat.join(" + ")})`}
            className={cx(
              "relative flex size-8 items-center justify-center rounded-md transition-colors",
              open
                ? "bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgb(139_140_248/0.3)]"
                : "text-fg-subtle hover:bg-white/5 hover:text-fg",
            )}
          >
            <Icon.chat size={16} />
            <UnreadBadge count={unread} />
          </button>
        </nav>
      </aside>
    </div>
  );
}
