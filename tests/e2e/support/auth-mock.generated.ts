// GENERATED from docs/api/auth.openapi.yaml — DO NOT EDIT.
// Regenerate with: pnpm --filter @kasuwa/e2e generate-mock
//
// Every body below is an `example` the contract publishes, copied verbatim.
// Hand-editing one makes the mock disagree with the API that is being built
// against the same file, silently, which is the entire failure mode this
// generation exists to prevent.
//
// `implemented` is the operation's `x-kasuwa-implemented` flag:
//   true    — T-0001 builds it; the screen wires to the real endpoint
//   partial — some methods are real, some return 501
//   false   — contract only; the screen stays on this mock (P01/3, P01/4)

export interface MockOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly implemented: 'true' | 'partial' | 'false' | 'unknown';
  readonly screens: readonly string[];
  /** status -> example name -> body. `default` is the spec's single `example:`. */
  readonly responses: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';

export const AUTH_OPERATIONS = [
  {
    "operationId": "getCurrentUser",
    "method": "GET",
    "path": "/api/v1/auth/me",
    "implemented": "true",
    "screens": [],
    "responses": {
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      }
    }
  },
  {
    "operationId": "lookupSso",
    "method": "POST",
    "path": "/api/v1/auth/sso/lookup",
    "implemented": "true",
    "screens": [
      "P01/1",
      "P01/1c"
    ],
    "responses": {
      "200": {
        "default": {
          "provider": "oidc",
          "displayName": "Sahel BPO single sign-on",
          "redirectUrl": "https://api.kasuwa.example/api/v1/auth/sso/start/1f2e"
        }
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "sso_domain_not_found",
          "message": "We could not find single sign-on for that domain."
        }
      }
    }
  },
  {
    "operationId": "reissueMfaChallenge",
    "method": "POST",
    "path": "/api/v1/auth/mfa/challenge",
    "implemented": "partial",
    "screens": [
      "P01/2",
      "P01/2a",
      "P01/2b"
    ],
    "responses": {
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "401": {
        "wrongCode": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_code_invalid",
          "message": "That code did not match. Check your authenticator app and try again.",
          "attemptsRemaining": 4
        },
        "expired": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_challenge_expired",
          "message": "That code has expired. Codes last ten minutes."
        },
        "unusable": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_challenge_invalid",
          "message": "Sign in again to continue."
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "resend_too_soon",
          "message": "Wait a moment before asking for another code.",
          "retryAt": "2026-09-27T10:03:00.000Z",
          "timeZone": "Africa/Lagos"
        }
      },
      "501": {
        "default": {
          "statusCode": 501,
          "error": "Not Implemented",
          "code": "not_implemented",
          "message": "This endpoint is not available yet."
        }
      }
    }
  },
  {
    "operationId": "resendOtp",
    "method": "POST",
    "path": "/api/v1/auth/verify-otp/resend",
    "implemented": "false",
    "screens": [
      "P01/4"
    ],
    "responses": {
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "resend_too_soon",
          "message": "Wait a moment before asking for another code.",
          "retryAt": "2026-09-27T10:03:00.000Z",
          "timeZone": "Africa/Lagos"
        }
      },
      "501": {
        "default": {
          "statusCode": 501,
          "error": "Not Implemented",
          "code": "not_implemented",
          "message": "This endpoint is not available yet."
        }
      }
    }
  },
  {
    "operationId": "signIn",
    "method": "POST",
    "path": "/api/v1/auth/sign-in",
    "implemented": "true",
    "screens": [
      "P01/1",
      "P01/1a",
      "P01/1b",
      "P01/1d"
    ],
    "responses": {
      "200": {
        "default": {
          "mfaRequired": true,
          "challengeId": "11111111-0000-4000-8000-000000000001.7d2b2e14-9f4a-4a0e-8b1f-0c2a6d5e4f31",
          "method": "totp",
          "methods": [
            {
              "type": "totp",
              "available": true,
              "deliveryHint": null
            },
            {
              "type": "sms",
              "available": false,
              "deliveryHint": "+234 ••• ••• 0142"
            },
            {
              "type": "backup_code",
              "available": false,
              "deliveryHint": null
            }
          ],
          "enrolmentRequired": false,
          "expiresAt": "2026-09-27T10:12:00.000Z",
          "resendAvailableAt": null
        }
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "invalid_credentials",
          "message": "Sign-in failed. Check your email address and password, then try again.",
          "attemptsRemaining": 4
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "account_locked",
          "message": "Too many sign-in attempts. Try again later.",
          "retryAt": "2026-09-27T10:27:00.000Z",
          "timeZone": "Africa/Lagos"
        }
      }
    }
  },
  {
    "operationId": "signOut",
    "method": "POST",
    "path": "/api/v1/auth/sign-out",
    "implemented": "true",
    "screens": [],
    "responses": {
      "204": {
        "default": null
      }
    }
  },
  {
    "operationId": "signUp",
    "method": "POST",
    "path": "/api/v1/auth/sign-up",
    "implemented": "false",
    "screens": [
      "P01/3"
    ],
    "responses": {
      "202": {
        "default": {
          "verificationId": "4a1c9b60-2d77-4c55-9a3e-8f6b1d0e2c44",
          "emailHint": "a•••a@example.test",
          "phoneHint": "+234 ••• ••• 0000",
          "expiresAt": "2026-09-27T10:08:00.000Z",
          "resendAvailableAt": "2026-09-27T09:59:00.000Z"
        }
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "resend_too_soon",
          "message": "Wait a moment before asking for another code.",
          "retryAt": "2026-09-27T10:03:00.000Z",
          "timeZone": "Africa/Lagos"
        }
      },
      "501": {
        "default": {
          "statusCode": 501,
          "error": "Not Implemented",
          "code": "not_implemented",
          "message": "This endpoint is not available yet."
        }
      }
    }
  },
  {
    "operationId": "verifyMfa",
    "method": "POST",
    "path": "/api/v1/auth/mfa",
    "implemented": "true",
    "screens": [
      "P01/2",
      "P01/2b"
    ],
    "responses": {
      "200": {
        "default": {
          "accessToken": "ksw_s1_pQ8s3J1mR4xY7Kd2Lf0Vb9Nc6Wt5Zg1Hj4Ur8Ao3Ei0",
          "tokenType": "Bearer",
          "expiresAt": "2026-09-27T22:00:00.000Z",
          "user": {
            "id": "11111111-0000-4000-8000-0000000d0001",
            "tenantId": "11111111-0000-4000-8000-000000000001",
            "email": "tunde.agent@tenant-a.test",
            "displayName": "Tunde Adeyemi",
            "locale": "en-NG"
          }
        }
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "401": {
        "wrongCode": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_code_invalid",
          "message": "That code did not match. Check your authenticator app and try again.",
          "attemptsRemaining": 4
        },
        "expired": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_challenge_expired",
          "message": "That code has expired. Codes last ten minutes."
        },
        "unusable": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "mfa_challenge_invalid",
          "message": "Sign in again to continue."
        }
      }
    }
  },
  {
    "operationId": "verifyOtp",
    "method": "POST",
    "path": "/api/v1/auth/verify-otp",
    "implemented": "false",
    "screens": [
      "P01/4"
    ],
    "responses": {
      "200": {
        "default": {
          "emailVerified": true,
          "phoneVerified": true,
          "nextStep": "onboarding"
        }
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "email",
              "code": "invalid_string"
            }
          ]
        }
      },
      "401": {
        "invalid": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "otp_invalid",
          "message": "That code did not match. Check it and try again.",
          "attemptsRemaining": 4
        },
        "expired": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "otp_expired",
          "message": "That code has expired. Codes last ten minutes."
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "otp_too_many_attempts",
          "message": "Too many attempts. Ask for a new code.",
          "retryAt": "2026-09-27T10:12:00.000Z",
          "timeZone": "Africa/Lagos"
        }
      },
      "501": {
        "default": {
          "statusCode": 501,
          "error": "Not Implemented",
          "code": "not_implemented",
          "message": "This endpoint is not available yet."
        }
      }
    }
  }
] as const;

/** The same list behind the documented shape, so a change to it fails here. */
export const AUTH_CONTRACT: readonly MockOperation[] = AUTH_OPERATIONS;

export type AuthOperationId = (typeof AUTH_OPERATIONS)[number]['operationId'];

/** The body the contract publishes for one outcome. Throws if it is not there. */
export function contractExample(
  operationId: AuthOperationId,
  status: number,
  example = 'default',
): unknown {
  const operation = AUTH_CONTRACT.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) {
    throw new Error(`${operationId} is not in ${AUTH_CONTRACT_SOURCE}`);
  }
  const bodies = operation.responses[String(status)];
  if (bodies === undefined) {
    throw new Error(`${operationId} publishes no ${status} in ${AUTH_CONTRACT_SOURCE}`);
  }
  if (!(example in bodies)) {
    throw new Error(
      `${operationId} ${status} has no example "${example}" in ${AUTH_CONTRACT_SOURCE} ` +
        `(it has: ${Object.keys(bodies).join(', ')})`,
    );
  }
  return bodies[example];
}
