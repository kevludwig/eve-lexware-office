import type { JsonStore, LexwareClient, ReminderPolicy, ReminderSender, RenderReminderMail, SendReminderMail } from "@kevinludwig/lexware-office";
import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { ApprovalCard, AttachmentFallback, CapturedPurchase, Responder } from "./lib/types";

const isFunction = (value: unknown) => typeof value === "function";
const isObjectWith = (...keys: string[]) => (value: unknown) =>
  typeof value === "object" && value !== null && keys.every((key) => key in value);

/**
 * What a consumer passes at the mount (agent/extensions/<name>.ts). Values
 * only — no environment is read here; the mount decides where they come from.
 */
export default defineExtension({
  config: z
    .object({
      /** Public API key of the Lexware Office account. Not needed when `client` is passed. */
      apiKey: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
      appUrl: z.string().url().optional(),
      /**
       * A client the consumer already uses for this account. Pass it when your
       * own code calls the API too: one client, one rate-limit queue.
       */
      client: z.custom<LexwareClient>(isObjectWith("request", "download", "upload")).optional(),

      /**
       * Where journal, reminder records, and send claims live. Default: Vercel
       * Blob (needs BLOB_READ_WRITE_TOKEN) under `prefix`.
       */
      storage: z
        .object({
          store: z.custom<JsonStore>(isObjectWith("read", "write", "create", "delete")).optional(),
          prefix: z.string().default("lexware-office"),
        })
        .prefault({}),

      /** Who may approve a writing tool. Default: anyone who may reach the session. */
      canApprove: z.custom<(responder: Responder) => boolean | Promise<boolean>>(isFunction).optional(),

      /** Receives the finished approval card of each writing tool, e.g. to show it in a web UI. */
      onApprovalCard: z.custom<(callId: string, card: ApprovalCard) => void | Promise<void>>(isFunction).optional(),

      /** Links to a conversation, for "waits in another conversation". */
      conversationUrl: z.custom<(sessionId: string) => string>(isFunction).optional(),

      /**
       * A second source for attachments, when eve's sandbox lost a file between
       * upload and approval — e.g. a copy the channel archived on arrival.
       */
      attachments: z.custom<AttachmentFallback>(isObjectWith("read")).optional(),

      /** Told about each purchase invoice approved for capture — its figures, before it is written. */
      onPurchaseCaptured: z.custom<(purchase: CapturedPurchase) => void | Promise<void>>(isFunction).optional(),

      reminders: z
        .object({
          /** "test": every reminder goes to ownerEmail, marked as a test. "live": to the customer. */
          mode: z.enum(["test", "live"]).default("test"),
          /** Receives test reminders, and live ones in Cc when ccOwner is set. */
          ownerEmail: z.string().email().optional(),
          ccOwner: z.boolean().default(true),
          policy: z.custom<Partial<ReminderPolicy>>((value) => typeof value === "object" && value !== null).default({}),
          /** Record namespace. Default: "reminders/<mode>". Keep test and live apart. */
          namespace: z.string().optional(),
          /** Sends a reminder. Without it, nothing is sent and the card says so. */
          sendMail: z.custom<SendReminderMail>(isFunction).optional(),
          /** Renders subject and body. Default: a friendly German reminder signed by `sender`. */
          render: z.custom<RenderReminderMail>(isFunction).optional(),
          sender: z.custom<ReminderSender>(isObjectWith("name")).optional(),
        })
        .prefault({}),
    })
    .refine((config) => Boolean(config.apiKey || config.client), { message: "apiKey oder client angeben." }),
});
