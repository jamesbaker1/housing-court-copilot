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
 *   { type: "text", delta: string }
 *   { type: "review_update", review, audit_event }   // advisory; ignored here
 *   { type: "done" }
 *   { type: "error", message: string }
 */
"use client";

import { useRef, useState, useEffect } from "react";
import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";

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
  /** Surfaced when the route emits a `review_update` (e.g. advice hard-route). */
  onReviewUpdate?: (review: unknown) => void;
  className?: string;
}

const DEFAULT_SUGGESTIONS = [
  "What is a nonpayment case?",
  "What does my court date mean?",
  "What happens at my first court appearance?",
  "What is an answer?",
];

const FIXED_NON_ADVICE_TEXT =
  "That's an important question. I can't tell you what to do or whether you " +
  "have a case — a lawyer needs to answer that. I've flagged your question for " +
  "the legal team so a person can help you.";

let _seq = 0;
function nextId() {
  _seq += 1;
  return `m_${Date.now()}_${_seq}`;
}

export default function ChatPanel({
  caseId,
  caseObject,
  suggestions = DEFAULT_SUGGESTIONS,
  onReviewUpdate,
  className = "",
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setError(null);
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

    const history: ChatTurn[] = prior.map((m) => ({
      role: m.role,
      content: m.text,
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          turnContext: "chat",
          caseId,
          ...(caseObject != null ? { caseObject } : {}),
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
            acc = ev.payload?.message?.trim() || FIXED_NON_ADVICE_TEXT;
            update();
            break;
          case "text":
            acc += ev.delta ?? "";
            update();
            break;
          case "error":
            throw new Error(ev.message ?? "stream error");
          case "review_update":
            if (ev.review != null) onReviewUpdate?.(ev.review);
            break;
          case "done":
          default:
            break;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
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

      if (routed && !acc.trim()) acc = FIXED_NON_ADVICE_TEXT;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: acc, routed, streaming: false }
            : m,
        ),
      );
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      setError(
        "Something went wrong reaching the assistant. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const empty = messages.length === 0;

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      <Disclaimer context={DisclaimerContext.Chat} variant="chip" />

      <div
        ref={scrollRef}
        className="mt-3 max-h-[60vh] min-h-[200px] flex-1 space-y-3 overflow-y-auto rounded-lg border border-trust-200 bg-white p-3"
        aria-live="polite"
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
                    className="w-full rounded-md border border-trust-200 bg-trust-50 px-3 py-2 text-left text-sm text-trust-800 hover:bg-trust-100 focus:outline-none focus:ring-2 focus:ring-trust-400"
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
            <RoutedCard key={m.id} text={m.text} streaming={m.streaming} />
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[90%] space-y-2">
                <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-trust-100 px-3 py-2 text-sm text-trust-900">
                  {m.text || (m.streaming ? "…" : "")}
                  {m.streaming && m.text && (
                    <span aria-hidden="true" className="ml-0.5 animate-pulse">
                      ▍
                    </span>
                  )}
                </div>
                {!m.streaming && (
                  <p className="px-1 text-xs text-verify-800">
                    <span aria-hidden="true">ⓘ </span>
                    Helpful info — double-check it. <TalkToAPersonLink />
                  </p>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md bg-deadline-50 px-3 py-2 text-sm text-deadline-700"
        >
          {error}
        </p>
      )}

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
          disabled={busy || !input.trim()}
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
}: {
  text: string;
  streaming?: boolean;
}) {
  const body = text.trim() || FIXED_NON_ADVICE_TEXT;
  return (
    <div className="flex justify-start">
      <div className="hcc-deadline max-w-[90%] space-y-2 rounded-2xl rounded-bl-sm">
        <p className="font-semibold">
          <span aria-hidden="true">🤝 </span>
          {TALK_TO_A_PERSON_CTA.heading}
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
          <p className="font-medium">{TALK_TO_A_PERSON_CTA.hotlineName}</p>
          <p className="mt-0.5">{TALK_TO_A_PERSON_CTA.hotlineNote}</p>
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
