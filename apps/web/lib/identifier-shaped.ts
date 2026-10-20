/**
 * D-L135's identifier rule (`lib/search-query.ts` explains it): an email, or
 * six or more digits once punctuation is gone. Its own module (T-0145), so
 * the record and pipeline clients that ask it do not ship the search query
 * model with it.
 */
export function identifierShaped(text: string): boolean {
  const normal = text.normalize('NFKC');
  if (normal.includes('@')) return true;
  return /\p{Nd}{6,}/u.test(normal.replace(/[^\p{L}\p{Nd}]/gu, ''));
}
