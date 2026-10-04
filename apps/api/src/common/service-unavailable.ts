import { HttpStatus } from '@nestjs/common';

/**
 * The ONE 503 body (T-0045, D-L56), for both kinds of load shedding the API
 * does: no database connection came free in time (`UnexpectedErrorFilter`),
 * and the password-hashing queue is full (`signInUnavailable`).
 *
 * One body and one `Retry-After` on every route. A bearer read must not answer
 * 401 (that signs a real user out because the database was busy), the two
 * sign-in branches - a workspace that exists and one that does not - must not
 * differ (the ADR-0009 enumeration oracle), and the two causes must not differ
 * either: which resource ran out is the server's business, not the caller's.
 * Nothing in it comes from the request or the error.
 */
export const SERVICE_UNAVAILABLE_BODY = Object.freeze({
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'Service Unavailable',
  code: 'service_unavailable',
  message: 'The service is busy right now. Please try again in a moment.',
});

/**
 * Seconds a client should wait before retrying a 503. A constant, never
 * derived from load: a value that moved with pool or queue pressure would be a
 * side channel on other tenants' traffic.
 */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The header every 503 carries. */
export const SERVICE_UNAVAILABLE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Retry-After': String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS),
});
