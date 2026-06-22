/**
 * Anthropic client + small typed helpers.
 *
 * SERVER ONLY. This module reads ANTHROPIC_API_KEY from the environment and must
 * never be imported into a client component. The SDK is marked as a server
 * external package in next.config.mjs.
 *
 * House style (the intent):
 *  - Structured outputs (extraction, classification, defense list, answer
 *    fields): a zod-validated `messages.parse` pass. Read the parsed result and
 *    null-guard it.
 *  - Hard reasoning (defense-spotting, answer draft): turn on extended thinking.
 *  - Chat/copilot: stream text deltas, then get the final assembled message.
 *  - Vision: image block before the text block. PDF: document block before text.
 *  - Citations are incompatible with structured-output parsing — never combine
 *    in one call. For v1 extraction we do the structured pass only.
 *
 * SDK-VERSION NOTE (@anthropic-ai/sdk 0.69.0 — pinned by package.json):
 *  - The zod structured-output helper is `betaZodOutputFormat`, imported from
 *    `@anthropic-ai/sdk/helpers/beta/zod`, and parsing lives on the BETA surface
 *    (`client.beta.messages.parse({ ..., output_format })`). The parsed value is
 *    on `message.parsed_output`. This is the shape this SDK version ships; if the
 *    SDK is later upgraded to a version exposing `client.messages.parse` +
 *    `output_config: { format: zodOutputFormat(...) }`, update this file to the
 *    non-beta surface — the exported helper signatures below stay the same.
 *  - This version does not expose adaptive thinking or `output_config.effort`.
 *    `hardReasoning` therefore maps to extended thinking
 *    (`thinking: { type: "enabled", budget_tokens }`), with the budget kept
 *    below `max_tokens` as the API requires. Swap to
 *    `thinking: { type: "adaptive" }` + `output_config: { effort: "high" }` once
 *    the SDK supports them.
 */
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/**
 * Model-name constants. Exact ids — never append a date suffix.
 *  - OPUS:   default for quality/safety/trust surfaces (vision intake, faithful
 *            transcription, defense-spotting, answer draft, grounded Q&A).
 *  - HAIKU:  cheap classification (advice-detection, case-type, triage).
 *  - SONNET: middle tier where noted.
 */
export const OPUS = "claude-opus-4-8" as const;
export const HAIKU = "claude-haiku-4-5" as const;
export const SONNET = "claude-sonnet-4-6" as const;

export type ModelName = typeof OPUS | typeof HAIKU | typeof SONNET;

/**
 * Shared singleton client. `new Anthropic()` resolves ANTHROPIC_API_KEY from the
 * environment. Constructed lazily so importing this module doesn't throw at
 * build time when the key is absent.
 */
let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client === null) {
    _client = new Anthropic();
  }
  return _client;
}

/** Re-export the SDK namespace so callers use SDK types (no hand-rolling). */
export { Anthropic };
export type MessageParam = Anthropic.MessageParam;

/**
 * Map a "hard reasoning" flag to an extended-thinking config for this SDK
 * version. budget_tokens must be ≥1024 and strictly less than max_tokens.
 */
function thinkingFor(
  hardReasoning: boolean,
  maxTokens: number,
): Anthropic.ThinkingConfigParam | undefined {
  if (!hardReasoning) return undefined;
  // Generous budget, capped to stay safely under max_tokens.
  const budget = Math.max(1024, Math.min(12000, maxTokens - 1024));
  return { type: "enabled", budget_tokens: budget };
}

/** Options shared by the structured-extract helper. */
export interface StructuredExtractOptions<T extends z.ZodType> {
  /** Zod schema describing the structured output. */
  schema: T;
  /** Conversation to send. Build vision/PDF blocks with the helpers below. */
  messages: MessageParam[];
  /** Optional system prompt. */
  system?: string;
  /** Model. Defaults to OPUS (trust/quality surface). */
  model?: ModelName;
  /** Token cap. Defaults to 16000 (structured passes). */
  maxTokens?: number;
  /**
   * Turn on hard reasoning (extended thinking). Use for defense-spotting and
   * answer-draft passes. Defaults to false.
   */
  hardReasoning?: boolean;
}

/** Result of a structured-extract call. `parsedOutput` is null-guarded by the caller. */
export interface StructuredExtractResult<T extends z.ZodType> {
  /** Validated parsed output, or null if the model returned nothing parseable. */
  parsedOutput: z.infer<T> | null;
  /** The raw final message, for provenance/audit (usage, model, stop_reason). */
  message: Anthropic.Beta.Messages.BetaMessage;
}

/**
 * Structured extraction / classification helper.
 *
 * Uses the beta `messages.parse` + `betaZodOutputFormat`. The caller MUST
 * null-guard `parsedOutput` — on a refusal or max_tokens stop the model may
 * return nothing that validates against the schema.
 *
 * Citations are NOT used here (incompatible with structured-output parsing).
 */
export async function structuredExtract<T extends z.ZodType>(
  opts: StructuredExtractOptions<T>,
): Promise<StructuredExtractResult<T>> {
  const {
    schema,
    messages,
    system,
    model = OPUS,
    maxTokens = 16000,
    hardReasoning = false,
  } = opts;

  const thinking = thinkingFor(hardReasoning, maxTokens);

  const message = await getClient().beta.messages.parse({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking } : {}),
    output_format: betaZodOutputFormat(schema),
    messages,
  });

  return {
    parsedOutput: (message.parsed_output ?? null) as z.infer<T> | null,
    message,
  };
}

/** Options for the streaming-chat helper. */
export interface StreamChatOptions {
  messages: MessageParam[];
  system?: string;
  /** Model. Defaults to OPUS for the conversational copilot. */
  model?: ModelName;
  /** Token cap. Defaults to 64000 (streaming, so timeouts aren't a concern). */
  maxTokens?: number;
  /** Turn on extended thinking for the chat turn. Defaults to false. */
  thinking?: boolean;
  /** Called for each streamed text delta. */
  onText?: (delta: string) => void;
}

/**
 * Streaming chat helper for the conversational copilot.
 *
 * Streams text deltas via `onText` and resolves with the final assembled
 * message (`client.messages.stream(...)` + `stream.finalMessage()`).
 *
 * NOTE: advice-seeking turns must be detected and hard-routed to a human BEFORE
 * reaching this helper — this helper does not itself answer advice questions.
 */
export async function streamChat(
  opts: StreamChatOptions,
): Promise<Anthropic.Message> {
  const {
    messages,
    system,
    model = OPUS,
    maxTokens = 64000,
    thinking = false,
    onText,
  } = opts;

  const stream = getClient().messages.stream({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking: thinkingFor(true, maxTokens) } : {}),
    messages,
  });

  if (onText) {
    stream.on("text", onText);
  }

  return stream.finalMessage();
}

/**
 * Returns the underlying stream object directly, for callers that need to wire
 * the SSE stream into a streaming HTTP response (route handlers). Prefer
 * {@link streamChat} when you only need the final message + a text callback.
 */
export function chatStream(opts: Omit<StreamChatOptions, "onText">) {
  const { messages, system, model = OPUS, maxTokens = 64000, thinking = false } = opts;
  return getClient().messages.stream({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking: thinkingFor(true, maxTokens) } : {}),
    messages,
  });
}

// ---------------------------------------------------------------------------
// Content-block helpers (vision + PDF). The image/document block goes BEFORE
// the text block in a user content array.
// ---------------------------------------------------------------------------

/** Supported base64 image media types for vision intake. */
export type ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/**
 * Build a user message with a base64 image placed before the text prompt.
 * (HEIC is not a supported vision media type — convert to JPEG/PNG upstream.)
 */
export function imageMessage(
  base64Data: string,
  mediaType: ImageMediaType,
  text: string,
): MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64Data },
      },
      { type: "text", text },
    ],
  };
}

/** Build a user message with a base64 PDF document placed before the text prompt. */
export function pdfMessage(base64Data: string, text: string): MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64Data,
        },
      },
      { type: "text", text },
    ],
  };
}
