/**
 * ChatPanel — the conversational copilot UI (streaming).
 *
 * Calls POST /api/chat and renders the assistant reply as it streams. Every
 * assistant turn is wrapped in the Chat contextual disclaimer ("Helpful info —
 * double-check it") with a "talk to a person" link.
 *
 * Backstop #2 (advice routing) is honored at the UI layer: the /api/chat route
 * runs the advice-detection classifier server-side. If a turn is advice-seeking
 * it is hard-routed to a human and the route emits a `routed` event with the
 * fixed non-advice response instead of a substantive answer. We surface that
 * distinctly (a "talk to a person" card), never as a normal answer. We never
 * attempt to answer advice questions on the client.
 *
 * Wire protocol (matches app/api/chat/route.ts): the request body is
 * `{ message, history, turnContext, caseObject }`; the response is an NDJSON
 * stream (one JSON object per line) of events:
 *   { type: "routed", payload: { message, cta, disclaimer } }
 *   { type: "heartbeat" }                             // S1: liveness during the buffered wait
 *   { type: "text", delta: string }
 *   { type: "review_update", review, audit_event }   // advisory; server persists, ignored here
 *   { type: "done" }
 *   { type: "error", message, code }                 // message is a sentinel; we render t.chatError
 */
"use client";

import { useRef, useState, useEffect } from "react";
import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import Turnstile from "@/components/Turnstile";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
import { fetchLlm, readWithIdleTimeout } from "@/lib/fetch";
import {
  type Strings,
  DEFAULT_LANGUAGE,
  getStrings,
  errorMessage,
} from "@/lib/i18n";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** True when this assistant turn is the fixed non-advice (hard-routed) reply. */
  routed?: boolean;
  /** True while this assistant turn is still streaming. */
  streaming?: boolean;
}

export interface ChatPanelProps {
  caseId: string;
  /** Optional Case Object passed to the route for grounding. */
  caseObject?: unknown;
  /** Optional starter suggestions shown when the chat is empty. */
  suggestions?: string[];
  /**
   * Localized UI strings (M7). The copilot page passes its `t` so chat errors,
   * the retry control, and the inline "talk to a person" helper are in the
   * tenant's language. Falls back to English when used standalone.
   */
  strings?: Strings;
  className?: string;
}

const DEFAULT_SUGGESTIONS = [
  "What is a nonpayment case?",
  "What does my court date mean?",
  "What happens at my first court appearance?",
  "What is an answer?",
];

let _seq = 0;
function nextId() {
  _seq += 1;
  return `m_${Date.now()}_${_seq}`;
}

/**
 * The shape of a REAL persisted case_id (mirrors app/api/chat/route.ts:`caseId`
 * and lib/retention.ts). When `caseId` matches, the server rehydrates the
 * authoritative Case from storage, so the client does NOT need to upload the
 * full case snapshot (S13). A `sess_…` placeholder (the unauthenticated / not-
 * yet-persisted path) does NOT match, and on that path the snapshot is still
 * sent because the server has nothing to load.
 */
const PERSISTED_CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * Window the uploaded history (S13). The model only needs recent context, and
 * the FULL transcript is redundant uplink that grows unbounded on a metered
 * connection. We keep the last N turns; the safety classifier screens only the
 * CURRENT turn text server-side, so windowing context never weakens a guardrail.
 */
const MAX_HISTORY_TURNS = 12;

export default function ChatPanel({
  caseId,
  caseObject,
  suggestions = DEFAULT_SUGGESTIONS,
  strings,
  className = "",
}: ChatPanelProps) {
  const t = strings ?? getStrings(DEFAULT_LANGUAGE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The text of the send that just failed — kept so we can re-populate the input
  // and offer a one-tap Retry (M7). Cleared on a successful send.
  const [failedText, setFailedText] = useState<string | null>(null);
  // Bot protection for the chat send (single-use; null until solved). The server
  // fails closed in prod, so we gate the send on having a token.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // S6: the single dedicated polite live region's content. Screen readers are
  // told ONLY about meaningful state changes — the "working" status (S1) while a
  // reply buffers, and the FINAL assistant/routed message when it completes —
  // never the per-token mutations of the scrolling transcript (WCAG 4.1.3).
  const [srAnnounce, setSrAnnounce] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || turnstileToken == null) return;

    setError(null);
    setFailedText(null);
    const userMsg: ChatMessage = { id: nextId(), role: "user", text: trimmed };
    const assistantId = nextId();
    const prior = messages;

    setMessages([
      ...prior,
      userMsg,
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);
    setInput("");
    setBusy(true);
    // S6/S1: announce that we're working (polite, once) while the reply buffers.
    setSrAnnounce(t.chatWorking);

    // S13: window the uploaded history to the last N turns so the uplink doesn't
    // grow unbounded on a metered connection (the server accepts any length).
    const history: ChatTurn[] = prior.slice(-MAX_HISTORY_TURNS).map((m) => ({
      role: m.role,
      content: m.text,
    }));

    // S13: when caseId is a REAL persisted id the server rehydrates the
    // authoritative Case, so the full client snapshot is dead weight every turn
    // — send only caseId. On the unauthenticated / not-yet-persisted path
    // (a `sess_…` id) the server has nothing to load, so we still send the
    // grounding snapshot. caseObject is grounding-only/fallback; the safety-
    // critical review subtree is always server-loaded, so this is safe.
    const sendCaseSnapshot =
      caseObject != null && !PERSISTED_CASE_ID_RE.test(caseId);

    try {
      const res = await fetchLlm("/api/chat", {
        // Streaming: the LLM budget bounds only time-to-first-byte; the buffered
        // reply can legitimately take longer than that, and readWithIdleTimeout
        // (below) bounds the stream itself. A total-request timeout here would
        // abort a healthy, actively-streaming answer mid-generation.
        streaming: true,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          turnContext: "chat",
          caseId,
          ...(sendCaseSnapshot ? { caseObject } : {}),
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Chat request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let routed = false;

      const update = () =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: acc, routed, streaming: true }
              : m,
          ),
        );

      const handleEvent = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let ev: {
          type?: string;
          delta?: string;
          message?: string;
          payload?: { message?: string };
          review?: unknown;
        };
        try {
          ev = JSON.parse(line);
        } catch {
          return; // ignore unparseable frames
        }
        switch (ev.type) {
          case "routed":
            routed = true;
            // M10: the `routed` flag is the server-authoritative signal (the
            // advice hard-route decision); the displayed body is pure non-advice
            // UI copy, so we render it in the tenant's language. We do NOT use
            // the server payload's English prose here (it would leak English to
            // a limited-English tenant at the most safety-load-bearing moment).
            acc = t.routedChatBody;
            update();
            break;
          case "text":
            acc += ev.delta ?? "";
            update();
            break;
          case "error":
            // S10c: the wire `message` is a fixed server-side sentinel (raw
            // err.message is logged server-side, never sent). We throw a generic
            // sentinel — NOT ev.message — so the catch always renders the
            // localized t.chatError (errorMessage falls back to it) and no
            // server-internal string can ever leak to the tenant.
            throw new Error("chat_stream_error");
          case "review_update":
            // Advisory only. The /api/chat route is now the SOLE server-side
            // writer of review.advice_routed + the audit event; the client no
            // longer PATCHes the review subtree back (it would be an untrusted
            // writer of a safety signal). We intentionally ignore this frame.
            break;
          case "heartbeat":
            // S1: liveness frame during the buffered server-side wait. It
            // carries no content; receiving it confirms the stream is alive (and
            // resets readWithIdleTimeout). Re-assert the polite "working" status
            // so a screen reader still has something meaningful to say, and keep
            // the animated placeholder visible. No transcript mutation.
            setSrAnnounce(t.chatWorking);
            break;
          case "done":
          default:
            break;
        }
      };

      for (;;) {
        // Bound each chunk read: a half-open stream (connected but silent) must
        // not hang the UI forever. A stalled read throws (catchable below).
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          handleEvent(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) handleEvent(buffer);

      if (routed && !acc.trim()) acc = t.routedChatBody;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: acc, routed, streaming: false }
            : m,
        ),
      );
      // S6: announce ONLY the finished message via the dedicated polite region.
      // For a routed turn, prefix a short "routed to a person" cue (the body is
      // already the localized non-advice copy). Per-token mutations were never
      // announced (the scrolling container no longer carries aria-live).
      setSrAnnounce(
        routed ? `${t.talkToAPerson.heading}. ${acc}` : acc,
      );
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      // S6: clear the polite region so the stale "working" status isn't read out
      // after a failure; the visible role="alert" block carries the error.
      setSrAnnounce("");
      setError(errorMessage(t, err, t.chatError));
      // Preserve the typed text so the tenant doesn't have to retype it; re-fill
      // the input AND keep it for the Retry button (M7). A timeout/abort from
      // lib/fetch surfaces the localized timeout message via errorMessage().
      setFailedText(trimmed);
      setInput(trimmed);
    } finally {
      // The Turnstile token is single-use; force a re-solve before the next send.
      setTurnstileToken(null);
      setBusy(false);
    }
  }

  const empty = messages.length === 0;

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      <Disclaimer context={DisclaimerContext.Chat} variant="chip" strings={t} />

      {/* S6: the ONLY aria-live region. Token-by-token mutation of the big
          transcript flooded/garbled screen readers (WCAG 4.1.3); the transcript
          below no longer carries aria-live. This visually-hidden region speaks
          only meaningful state changes — the "working" status while a reply
          buffers, and the FINAL assistant/routed message — never per-token text. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {srAnnounce}
      </div>

      <div
        ref={scrollRef}
        className="mt-3 max-h-[60vh] min-h-[200px] flex-1 space-y-3 overflow-y-auto rounded-lg border border-trust-200 bg-white p-3"
        aria-label="Conversation with the copilot"
      >
        {empty && (
          <div className="py-6 text-center text-sm text-trust-700">
            <p className="font-medium">
              Ask me to explain how housing court works.
            </p>
            <p className="mt-1">
              I can explain words and steps. I can&apos;t tell you what to do —
              a lawyer does that.
            </p>
            <ul className="mt-4 space-y-2 text-left">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => send(s)}
                    disabled={busy || turnstileToken == null}
                    className="w-full rounded-md border border-trust-200 bg-trust-50 px-3 py-2 text-left text-sm text-trust-800 hover:bg-trust-100 focus:outline-none focus:ring-2 focus:ring-trust-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-trust-600 px-3 py-2 text-sm text-white">
                {m.text}
              </div>
            </div>
          ) : m.routed ? (
            <RoutedCard
              key={m.id}
              text={m.text}
              streaming={m.streaming}
              strings={t}
            />
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[90%] space-y-2">
                {/* S6: mark the in-progress bubble aria-busy so assistive tech
                    knows it's still being populated (the dedicated live region
                    above carries the actual announcement). */}
                <div
                  aria-busy={m.streaming ? true : undefined}
                  className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-trust-100 px-3 py-2 text-sm text-trust-900"
                >
                  {m.text || (m.streaming ? (
                    // S1: animate the waiting placeholder so the buffered 10-40s
                    // wait reads as ALIVE (it's the highest-abandonment moment),
                    // not a frozen "…". Heartbeat frames keep the stream live.
                    <span
                      aria-hidden="true"
                      className="inline-flex animate-pulse text-trust-500"
                    >
                      ● ● ●
                    </span>
                  ) : (
                    ""
                  ))}
                  {m.streaming && m.text && (
                    <span aria-hidden="true" className="ml-0.5 animate-pulse">
                      ▍
                    </span>
                  )}
                </div>
                {!m.streaming && (
                  <p className="px-1 text-xs text-verify-800">
                    <span aria-hidden="true">ⓘ </span>
                    {t.disclaimers.chat.label}. <TalkToAPersonLink strings={t} />
                  </p>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-2 space-y-2 rounded-md bg-deadline-50 px-3 py-2 text-sm text-deadline-700"
        >
          <p>{error}</p>
          {failedText && (
            <button
              type="button"
              onClick={() => void send(failedText)}
              disabled={busy || turnstileToken == null}
              className="rounded-md bg-trust-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
            >
              {t.retry}
            </button>
          )}
          {/* Surface the human handoff INLINE at the moment of failure (M7): a
              tenant who can't reach the assistant shouldn't have to hunt for the
              hotline. */}
          <p className="text-xs text-deadline-800">
            <span className="font-medium">{t.needHelpNow}</span>{" "}
            <TalkToAPersonLink strings={t} />
          </p>
          <div className="rounded-md bg-white/60 px-2 py-1.5 text-xs text-deadline-900">
            <p className="font-medium">{t.talkToAPerson.hotlineName}</p>
            <p className="mt-0.5">{t.talkToAPerson.hotlineNote}</p>
            <a
              href={`tel:${TALK_TO_A_PERSON_CTA.hotlinePhone}`}
              className="mt-1 inline-block font-semibold text-trust-700 underline underline-offset-2"
            >
              Call {TALK_TO_A_PERSON_CTA.hotlinePhone}
            </a>
          </div>
        </div>
      )}

      {/* Bot protection before each send. Dev renders a no-op placeholder and
          emits a sentinel token so local dev still works. */}
      <Turnstile token={turnstileToken} onToken={setTurnstileToken} action="chat" className="mt-3" />

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="hcc-chat-input" className="sr-only">
          Ask the copilot a question
        </label>
        <textarea
          id="hcc-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          placeholder="Ask a question…"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-trust-300 bg-white px-3 py-2 text-base focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim() || turnstileToken == null}
          className="min-h-[44px] shrink-0 rounded-lg bg-trust-600 px-4 py-2 text-sm font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

/** The fixed non-advice card shown when a turn is hard-routed to a human. */
function RoutedCard({
  text,
  streaming,
  strings,
}: {
  text: string;
  streaming?: boolean;
  strings?: Strings;
}) {
  // M10: the human-routing copy (the UPL protection) shows in the tenant's
  // language. The routed payload's message is already localized server-side;
  // this fallback + the CTA labels stay in-language too.
  const t = strings ?? getStrings(DEFAULT_LANGUAGE);
  const body = text.trim() || t.routedChatBody;
  return (
    <div className="flex justify-start">
      {/* S6: aria-busy while the routed card is still streaming; the final
          "routed to a person" + body is announced via the dedicated live
          region, not by mutating this card. */}
      <div
        aria-busy={streaming ? true : undefined}
        className="hcc-deadline max-w-[90%] space-y-2 rounded-2xl rounded-bl-sm"
      >
        <p className="font-semibold">
          <span aria-hidden="true">🤝 </span>
          {t.talkToAPerson.heading}
        </p>
        <p className="text-sm">
          {body}
          {streaming && (
            <span aria-hidden="true" className="ml-0.5 animate-pulse">
              ▍
            </span>
          )}
        </p>
        <div className="rounded-md bg-white/60 px-2 py-1.5 text-xs text-deadline-900">
          <p className="font-medium">{t.talkToAPerson.hotlineName}</p>
          <p className="mt-0.5">{t.talkToAPerson.hotlineNote}</p>
          <a
            href={`tel:${TALK_TO_A_PERSON_CTA.hotlinePhone}`}
            className="mt-1 inline-block font-semibold text-trust-700 underline underline-offset-2"
          >
            Call {TALK_TO_A_PERSON_CTA.hotlinePhone}
          </a>
        </div>
      </div>
    </div>
  );
}
