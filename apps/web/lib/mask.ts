/**
 * Masks an email for display, the way `P01/1b` shows it: `a•••@ojafoods.ng`.
 *
 * Purely cosmetic — it reduces shoulder-surfing on a shared BPO floor, and it
 * keeps a full address out of a screenshot pasted into a support ticket. It is
 * NOT a security control: the person reading it typed the address a moment ago.
 *
 * The address itself never leaves the browser here, and nothing on this path
 * logs it (`CLAUDE.md` section 6.1).
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '•••';
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}•••${domain}`;
}
