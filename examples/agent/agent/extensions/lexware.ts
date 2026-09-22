import lexware from "@kevinludwig/eve-lexware-office";
import { memoryStore } from "@kevinludwig/lexware-office";

/**
 * The extension, mounted as `lexware`: tools become `lexware__read`,
 * `lexware__send_payment_reminder`, …
 *
 * This example keeps records in memory and only logs the mails it would
 * send. For real use, drop `storage.store` (Vercel Blob is the default) and
 * pass a `sendMail` that delivers.
 */
export default lexware({
  apiKey: process.env.LEXWARE_API_KEY ?? "",
  storage: { store: memoryStore() },
  reminders: {
    mode: "test",
    ownerEmail: process.env.OWNER_EMAIL ?? "owner@example.com",
    sender: { name: "Beispiel GmbH", legal: ["Beispiel GmbH, Musterstraße 1, 12345 Musterstadt"] },
    async sendMail(mail) {
      console.info(`[example] would send "${mail.subject}" to ${mail.to} (cc ${mail.cc.join(", ") || "–"}), ${mail.attachments.length} attachment(s)`);
    },
  },
  onApprovalCard(callId, card) {
    console.info(`[example] card ${callId}: ${card.title} — ${card.subtitle ?? ""} | findings: ${card.findings.map((f) => `${f.title}: ${f.value}`).join("; ")}`);
  },
});
