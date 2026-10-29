const WINDOW_MS = 24 * 60 * 60 * 1000;

/** WhatsApp session window: open for 24h after the last inbound customer message. */
export function isWhatsappWindowOpen(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  if (lastInboundAt === null) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}
