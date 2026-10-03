// GENERATED from docs/api/admin.openapi.yaml — DO NOT EDIT.
// Regenerate with: pnpm --filter @kasuwa/e2e generate-admin-mock
//
// Every body below is an `example` the contract publishes, copied verbatim.
// Hand-editing one makes the mock disagree with the API that will be built
// against the same file, silently — which is the entire failure mode this
// generation exists to prevent.
//
// `implemented` is the operation's `x-kasuwa-implemented` flag:
//   true    — real today
//   partial — some of the response is real, the rest is null or absent
//   false   — contract only; the screen stays on this mock

export interface MockOperation {
  readonly operationId: string;
  readonly method: string;
  /** The OpenAPI template path, e.g. `/api/v1/admin/programmes/{programmeId}`. */
  readonly path: string;
  readonly implemented: 'true' | 'partial' | 'false' | 'unknown';
  /** `x-kasuwa-audited` — this operation must write an audit row when built. */
  readonly audited: boolean;
  readonly screens: readonly string[];
  /** status -> example name -> body. `default` is the spec's single `example:`. */
  readonly responses: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

export const ADMIN_OPERATIONS = [
  {
    "operationId": "archiveProgramme",
    "method": "POST",
    "path": "/api/v1/admin/programmes/{programmeId}/archive",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B9"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "createAuditExport",
    "method": "POST",
    "path": "/api/v1/admin/audit/exports",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/E2"
    ],
    "responses": {
      "202": {
        "default": {
          "exportId": "11111111-0000-4000-8000-000000c10001",
          "status": "queued",
          "format": "csv",
          "estimatedRowCount": 4800,
          "deliveryEmailHint": "a•••a@example.test",
          "linkExpiresAfterHours": 24,
          "requestedAt": "2026-09-30T10:04:00.000Z"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "429": {
        "default": {
          "statusCode": 429,
          "error": "Too Many Requests",
          "code": "too_many_requests",
          "message": "Too many exports at once. Try again shortly.",
          "retryAt": "2026-09-30T10:20:00.000Z"
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
    "operationId": "createDisposition",
    "method": "POST",
    "path": "/api/v1/admin/programmes/{programmeId}/dispositions",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B5"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "createProgramme",
    "method": "POST",
    "path": "/api/v1/admin/programmes",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B",
      "P02/B1"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "createRole",
    "method": "POST",
    "path": "/api/v1/admin/roles",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/C"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "deleteDisposition",
    "method": "DELETE",
    "path": "/api/v1/admin/programmes/{programmeId}/dispositions/{dispositionId}",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B5"
    ],
    "responses": {
      "204": {
        "default": null
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "deleteRole",
    "method": "DELETE",
    "path": "/api/v1/admin/roles/{roleId}",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/C3"
    ],
    "responses": {
      "204": {
        "default": null
      },
      "400": {
        "default": {
          "statusCode": 400,
          "error": "Bad Request",
          "code": "validation_failed",
          "message": "Validation failed",
          "details": [
            {
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "dismissAdminAlert",
    "method": "PUT",
    "path": "/api/v1/admin/home/alerts/{alertId}/dismissal",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A"
    ],
    "responses": {
      "204": {
        "default": null
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getAdminHomeSummary",
    "method": "GET",
    "path": "/api/v1/admin/home/summary",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A"
    ],
    "responses": {
      "200": {
        "default": {
          "tenant": {
            "id": "11111111-0000-4000-8000-000000000001",
            "name": "Sabi Contact Centres Ltd",
            "planName": "Enterprise",
            "countryCount": 6,
            "userCount": 214
          },
          "dataRegion": {
            "code": "af-south-1",
            "displayName": "South Africa"
          },
          "health": {
            "score": 78,
            "outOf": 100,
            "pointsAvailable": 22,
            "checkedAt": "2026-09-30T09:55:00.000Z",
            "checks": [
              {
                "checkId": "sso_configured",
                "label": "SSO with Microsoft Entra ID",
                "status": "pass",
                "points": 0,
                "settingId": "u-sso"
              },
              {
                "checkId": "whatsapp_template_rejected",
                "label": "1 WhatsApp template rejected",
                "status": "fail",
                "points": 8,
                "settingId": "ch-wa"
              },
              {
                "checkId": "users_without_mfa",
                "label": "2 users without MFA",
                "status": "warn",
                "points": 6,
                "settingId": "u-mfa"
              }
            ]
          }
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "getAdminUsage",
    "method": "GET",
    "path": "/api/v1/admin/home/usage",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A"
    ],
    "responses": {
      "200": {
        "default": {
          "periodStart": "2026-09-01T00:00:00.000Z",
          "periodEnd": "2026-10-01T00:00:00.000Z",
          "meters": [
            {
              "meterId": "seats",
              "label": "Seats",
              "unit": "seat",
              "used": 142,
              "limit": 160,
              "warnAtPercent": null,
              "note": "18 seats left.",
              "spend": null
            },
            {
              "meterId": "whatsapp_conversations",
              "label": "WhatsApp conversations",
              "unit": "conversation",
              "used": 38420,
              "limit": null,
              "warnAtPercent": 90,
              "note": "Final cost follows Meta's rates.",
              "spend": {
                "amountMinor": "128430000",
                "currency": "NGN",
                "estimatedTotalMinor": "165000000"
              }
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "getAuditExport",
    "method": "GET",
    "path": "/api/v1/admin/audit/exports/{exportId}",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/E2"
    ],
    "responses": {
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getAuditFilterOptions",
    "method": "GET",
    "path": "/api/v1/admin/audit/filter-options",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/E"
    ],
    "responses": {
      "200": {
        "default": {
          "actors": [
            {
              "id": "11111111-0000-4000-8000-0000000d0001",
              "displayName": "Amaka Okafor",
              "kind": "user"
            },
            {
              "id": null,
              "displayName": "System",
              "kind": "system"
            }
          ],
          "actions": [
            "created",
            "updated",
            "deleted",
            "exported",
            "invited",
            "failed_sign_in",
            "rejected",
            "rotated"
          ],
          "objectTypes": [
            {
              "objectType": "mfa_policy",
              "label": "MFA policy"
            },
            {
              "objectType": "programme",
              "label": "Programme"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "getFieldSecurityMatrix",
    "method": "GET",
    "path": "/api/v1/admin/field-security/matrix",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/D",
      "P02/D1"
    ],
    "responses": {
      "200": {
        "default": {
          "objectApiName": "contact",
          "version": 5,
          "totalFieldCount": 14,
          "rows": [
            {
              "fieldApiName": "full_name",
              "label": "Full name",
              "classification": "none",
              "cells": [
                {
                  "permissionSetId": "agent",
                  "level": "edit",
                  "locked": false
                },
                {
                  "permissionSetId": "admin",
                  "level": "edit",
                  "locked": true
                }
              ]
            },
            {
              "fieldApiName": "bank_verification_number",
              "label": "BVN",
              "classification": "sensitive",
              "cells": [
                {
                  "permissionSetId": "agent",
                  "level": "none",
                  "locked": false
                },
                {
                  "permissionSetId": "admin",
                  "level": "edit",
                  "locked": true
                }
              ]
            }
          ]
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getProgramme",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/B2"
    ],
    "responses": {
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      }
    }
  },
  {
    "operationId": "getProgrammeArchivePreview",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/archive-preview",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B9"
    ],
    "responses": {
      "200": {
        "default": {
          "agentsLosingAccess": 64,
          "openInteractionsBecomingReadOnly": 212,
          "retentionSummary": "7 years",
          "portalUsersSignedOut": 0,
          "restorableUntilDays": 30
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getProgrammeKpis",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/kpis",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B2"
    ],
    "responses": {
      "200": {
        "default": {
          "window": "last_7_days",
          "kpis": [
            {
              "kpiId": "sla_met",
              "label": "SLA met",
              "format": "percent",
              "value": 96.2,
              "targetValue": 95,
              "status": "good"
            },
            {
              "kpiId": "average_handle_time",
              "label": "Average handle time",
              "format": "duration_seconds",
              "value": 372,
              "targetValue": 420,
              "status": "good"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getProgrammeRetention",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/retention",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/B7"
    ],
    "responses": {
      "200": {
        "default": {
          "version": 2,
          "callRecordingsDays": 2555,
          "messageTranscriptsDays": 2555,
          "screenRecordingsDays": 90,
          "qaEvaluationsDays": 1095,
          "onExpiry": "delete",
          "redactSensitiveNumbersInTranscripts": true,
          "legalHold": false,
          "workspaceDefaultDays": 730
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getProgrammeSkillCover",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/skill-cover",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B3"
    ],
    "responses": {
      "200": {
        "default": {
          "shiftDate": "2026-09-29",
          "shift": "day",
          "timeZone": "Africa/Lagos",
          "items": [
            {
              "skillId": "collections_l3",
              "label": "Collections L3",
              "rostered": 12,
              "needed": 10
            },
            {
              "skillId": "hausa",
              "label": "Hausa speakers",
              "rostered": 9,
              "needed": 12
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getProgrammeSla",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/sla",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/B4"
    ],
    "responses": {
      "200": {
        "default": {
          "version": 4,
          "targets": [
            {
              "channel": "whatsapp",
              "firstResponseSeconds": 120,
              "resolutionSeconds": 86400,
              "clock": "business_hours"
            },
            {
              "channel": "voice",
              "firstResponseSeconds": 20,
              "resolutionSeconds": null,
              "clock": "business_hours"
            }
          ],
          "pauseOutsideOperatingHours": true,
          "pauseAwaitingCustomer": true,
          "warnAtPercentOfTarget": 80,
          "warnNotifyRole": "team_lead",
          "breachNotifyRole": "programme_manager_and_client",
          "operatingHoursSummary": "Mon–Sat, 08:00–20:00 WAT",
          "timeZone": "Africa/Lagos"
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getRole",
    "method": "GET",
    "path": "/api/v1/admin/roles/{roleId}",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/C",
      "P02/C2"
    ],
    "responses": {
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "getSettingsMenuBadges",
    "method": "GET",
    "path": "/api/v1/admin/settings-menu/badges",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A1"
    ],
    "responses": {
      "200": {
        "default": {
          "badges": [
            {
              "settingId": "u-users",
              "count": 2,
              "severity": "warning"
            },
            {
              "settingId": "ch-wa",
              "count": 1,
              "severity": "danger"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "invitePortalUser",
    "method": "POST",
    "path": "/api/v1/admin/programmes/{programmeId}/portal-users/invitations",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B8"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "listAdminAlerts",
    "method": "GET",
    "path": "/api/v1/admin/home/alerts",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "id": "8f2c7a10-0000-4000-8000-00000000a001",
              "severity": "danger",
              "category": "channels",
              "title": "WhatsApp template rejected",
              "body": "“payment_reminder_v3” for Eko Bank Collections was rejected by Meta: promotional wording in a utility template.",
              "sourceLabel": "Meta",
              "raisedAt": "2026-09-30T07:30:00.000Z",
              "actionLabel": "Edit template",
              "settingId": "ch-wa",
              "dismissed": false
            },
            {
              "id": "8f2c7a10-0000-4000-8000-00000000a002",
              "severity": "warning",
              "category": "security",
              "title": "2 users without MFA",
              "body": "2 people still sign in with a password only. MFA becomes required on 1 Oct 2026.",
              "sourceLabel": "Security",
              "raisedAt": "2026-09-21T08:00:00.000Z",
              "actionLabel": "Remind them",
              "settingId": "u-mfa",
              "dismissed": false
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "listAuditEvents",
    "method": "GET",
    "path": "/api/v1/admin/audit/events",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A",
      "P02/E",
      "P02/E1"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "id": "11111111-0000-4000-8000-000000a10001",
              "occurredAt": "2026-09-27T13:32:00.000Z",
              "actor": {
                "kind": "user",
                "id": "11111111-0000-4000-8000-0000000d0001",
                "displayName": "Amaka Okafor",
                "roleName": "Tenant admin"
              },
              "action": "updated",
              "objectType": "mfa_policy",
              "objectLabel": "Workspace MFA policy",
              "objectId": "11111111-0000-4000-8000-000000b10001",
              "programmeId": null,
              "sourceIp": null,
              "sourceLocation": "Lagos, NG",
              "changes": [
                {
                  "field": "requirement",
                  "before": "optional",
                  "after": "required_for_all_users",
                  "redacted": false
                }
              ]
            },
            {
              "id": "11111111-0000-4000-8000-000000a10002",
              "occurredAt": "2026-09-26T14:22:00.000Z",
              "actor": {
                "kind": "system",
                "id": null,
                "displayName": "System",
                "roleName": "Scheduled job"
              },
              "action": "rotated",
              "objectType": "api_key",
              "objectLabel": "Payments integration key",
              "objectId": null,
              "programmeId": null,
              "sourceIp": null,
              "sourceLocation": "af-south-1",
              "changes": [
                {
                  "field": "key_ending",
                  "before": null,
                  "after": null,
                  "redacted": true
                }
              ]
            }
          ],
          "page": {
            "nextCursor": "eyJhdCI6IjIwMjYtMDktMjYifQ",
            "hasMore": true,
            "totalCount": null
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "listDispositions",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/dispositions",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B5"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "id": "11111111-0000-4000-8000-0000000e0001",
              "code": "PTP",
              "label": "Promise to pay",
              "category": "promise_to_pay",
              "noteRequired": true,
              "followUpRequired": true,
              "active": true,
              "position": 1,
              "usageCount90d": 3214
            }
          ],
          "usageWindowDays": 90
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "listFieldSecurityObjects",
    "method": "GET",
    "path": "/api/v1/admin/field-security/objects",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/D"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "objectApiName": "contact",
              "label": "Contact",
              "fieldCount": 14
            },
            {
              "objectApiName": "interaction",
              "label": "Interaction",
              "fieldCount": 7
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "listPermissionSets",
    "method": "GET",
    "path": "/api/v1/admin/field-security/permission-sets",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/D",
      "P02/D1"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "permissionSetId": "agent",
              "label": "Agent",
              "userCount": 412,
              "locked": false
            },
            {
              "permissionSetId": "admin",
              "label": "Admin",
              "userCount": 4,
              "locked": true
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "listPortalUsers",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/portal-users",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B8"
    ],
    "responses": {
      "200": {
        "default": {
          "items": []
        },
        "invited": {
          "items": [
            {
              "id": "b2f0f7d8-4c21-4b4e-9f7a-2a1d6f4c0e11",
              "displayName": "Invited Client User",
              "emailMasked": "p•••e@client.example",
              "access": "viewer",
              "status": "invited",
              "invitedAt": "2026-09-28T09:00:00Z"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "listProgrammeAgents",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/agents",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/B3"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "userId": "11111111-0000-4000-8000-0000000d0011",
              "displayName": "Ngozi Adeyemi",
              "initials": "NA",
              "teamName": "Team A",
              "skills": [
                "Collections L3",
                "Restructuring"
              ],
              "languages": [
                "en",
                "yo",
                "pcm"
              ],
              "presence": "on_call"
            }
          ],
          "page": {
            "nextCursor": null,
            "hasMore": false,
            "totalCount": 64
          }
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "listProgrammes",
    "method": "GET",
    "path": "/api/v1/admin/programmes",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/B",
      "P02/B1"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "id": "11111111-0000-4000-8000-0000000c0001",
              "name": "Eko Bank Collections",
              "clientName": "Eko Commercial Bank",
              "reference": "PRG-0031",
              "countryCode": "NG",
              "status": "active",
              "channels": [
                "whatsapp",
                "voice",
                "sms"
              ],
              "agentCount": 64,
              "slaAttainment7d": 96.2,
              "retentionSummary": "7 years"
            },
            {
              "id": "11111111-0000-4000-8000-0000000c0008",
              "name": "Teranga Air Helpdesk",
              "clientName": "Teranga Air",
              "reference": "PRG-0035",
              "countryCode": "SN",
              "status": "draft",
              "channels": [
                "email"
              ],
              "agentCount": 0,
              "slaAttainment7d": null,
              "retentionSummary": null
            }
          ],
          "statusCounts": {
            "active": 6,
            "paused": 1,
            "draft": 1,
            "archived": 0
          },
          "page": {
            "nextCursor": null,
            "hasMore": false,
            "totalCount": 8
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
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
    "operationId": "listProgrammeScripts",
    "method": "GET",
    "path": "/api/v1/admin/programmes/{programmeId}/scripts",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/B6"
    ],
    "responses": {
      "200": {
        "default": {
          "items": [
            {
              "id": "7b1f2f3a-0001-4a2b-8c3d-9e0f1a2b3c01",
              "name": "Early arrears: first contact",
              "channels": [
                "voice"
              ],
              "languages": [
                "en",
                "pcm",
                "yo"
              ],
              "version": 4,
              "status": "published",
              "providerName": null,
              "rejectionReason": null,
              "updatedAt": "2026-09-12T09:14:00Z"
            },
            {
              "id": "7b1f2f3a-0002-4a2b-8c3d-9e0f1a2b3c02",
              "name": "WhatsApp payment reminder",
              "channels": [
                "whatsapp"
              ],
              "languages": [
                "en"
              ],
              "version": 3,
              "status": "rejected_by_provider",
              "providerName": "WhatsApp Business Platform",
              "rejectionReason": "Template contains a prohibited promotional phrase.",
              "updatedAt": "2026-09-27T16:02:00Z"
            },
            {
              "id": "7b1f2f3a-0003-4a2b-8c3d-9e0f1a2b3c03",
              "name": "Promise-to-pay confirmation",
              "channels": [
                "sms"
              ],
              "languages": [
                "en",
                "ha"
              ],
              "version": 2,
              "status": "published",
              "providerName": null,
              "rejectionReason": null,
              "updatedAt": "2026-09-03T11:40:00Z"
            },
            {
              "id": "7b1f2f3a-0004-4a2b-8c3d-9e0f1a2b3c04",
              "name": "Identity check before discussing debt",
              "channels": [
                "voice",
                "whatsapp"
              ],
              "languages": [
                "en"
              ],
              "version": 5,
              "status": "published",
              "providerName": null,
              "rejectionReason": null,
              "updatedAt": "2026-08-29T08:25:00Z"
            },
            {
              "id": "7b1f2f3a-0005-4a2b-8c3d-9e0f1a2b3c05",
              "name": "Hardship and restructuring",
              "channels": [
                "voice"
              ],
              "languages": [
                "en"
              ],
              "version": 2,
              "status": "draft",
              "providerName": null,
              "rejectionReason": null,
              "updatedAt": "2026-09-25T13:05:00Z"
            },
            {
              "id": "7b1f2f3a-0006-4a2b-8c3d-9e0f1a2b3c06",
              "name": "Bereavement: customer deceased",
              "channels": [
                "voice"
              ],
              "languages": [
                "en"
              ],
              "version": 1,
              "status": "in_review",
              "providerName": null,
              "rejectionReason": null,
              "updatedAt": "2026-09-20T10:18:00Z"
            }
          ],
          "page": {
            "nextCursor": null,
            "hasMore": false,
            "totalCount": 6
          }
        },
        "empty": {
          "items": [],
          "page": {
            "nextCursor": null,
            "hasMore": false,
            "totalCount": 0
          }
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "listRoles",
    "method": "GET",
    "path": "/api/v1/admin/roles",
    "implemented": "true",
    "audited": false,
    "screens": [
      "P02/C",
      "P02/C1",
      "P02/C2"
    ],
    "responses": {
      "200": {
        "default": {
          "version": 11,
          "items": [
            {
              "id": "11111111-0000-4000-8000-0000000f0001",
              "name": "Managing Director",
              "parentRoleId": null,
              "userCount": 1,
              "descendantUserCount": 213
            },
            {
              "id": "11111111-0000-4000-8000-0000000f0002",
              "name": "Head of Operations",
              "parentRoleId": "11111111-0000-4000-8000-0000000f0001",
              "userCount": 1,
              "descendantUserCount": 152
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
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
    "operationId": "reorderDispositions",
    "method": "PUT",
    "path": "/api/v1/admin/programmes/{programmeId}/dispositions/order",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B5"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "restoreAdminAlert",
    "method": "DELETE",
    "path": "/api/v1/admin/home/alerts/{alertId}/dismissal",
    "implemented": "false",
    "audited": false,
    "screens": [
      "P02/A"
    ],
    "responses": {
      "204": {
        "default": null
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
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
    "operationId": "updateDisposition",
    "method": "PATCH",
    "path": "/api/v1/admin/programmes/{programmeId}/dispositions/{dispositionId}",
    "implemented": "false",
    "audited": true,
    "screens": [
      "P02/B5"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateFieldSecurityMatrix",
    "method": "PUT",
    "path": "/api/v1/admin/field-security/matrix",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/D",
      "P02/D1",
      "P02/D2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateProgramme",
    "method": "PATCH",
    "path": "/api/v1/admin/programmes/{programmeId}",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/B2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateProgrammeRetention",
    "method": "PUT",
    "path": "/api/v1/admin/programmes/{programmeId}/retention",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/B7",
      "P02/D2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateProgrammeSla",
    "method": "PUT",
    "path": "/api/v1/admin/programmes/{programmeId}/sla",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/B4",
      "P02/D2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateRole",
    "method": "PATCH",
    "path": "/api/v1/admin/roles/{roleId}",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/C",
      "P02/C2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
    "operationId": "updateRoleHierarchy",
    "method": "PUT",
    "path": "/api/v1/admin/roles/hierarchy",
    "implemented": "true",
    "audited": true,
    "screens": [
      "P02/C1",
      "P02/C2",
      "P02/D2"
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
              "path": "warnAtPercentOfTarget",
              "code": "too_big"
            }
          ]
        }
      },
      "401": {
        "default": {
          "statusCode": 401,
          "error": "Unauthorized",
          "code": "not_authenticated",
          "message": "Not authenticated"
        }
      },
      "403": {
        "default": {
          "statusCode": 403,
          "error": "Forbidden",
          "code": "not_permitted",
          "message": "You do not have permission to do that."
        }
      },
      "404": {
        "default": {
          "statusCode": 404,
          "error": "Not Found",
          "code": "not_found",
          "message": "Not found"
        }
      },
      "409": {
        "stale": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "stale_write",
          "message": "Someone else saved changes while you were editing. Reload and try again."
        },
        "cycle": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "role_hierarchy_cycle",
          "message": "A role cannot report to one of the roles beneath it.",
          "conflictingIds": [
            "11111111-0000-4000-8000-0000000f0013",
            "11111111-0000-4000-8000-0000000f0008"
          ]
        },
        "duplicate": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "duplicate_code",
          "message": "That code is already in use in this programme.",
          "details": [
            {
              "path": "code",
              "code": "duplicate"
            }
          ]
        },
        "legalHold": {
          "statusCode": 409,
          "error": "Conflict",
          "code": "legal_hold_active",
          "message": "Retention cannot be shortened while a legal hold is on."
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
export const ADMIN_CONTRACT: readonly MockOperation[] = ADMIN_OPERATIONS;

export type AdminOperationId = (typeof ADMIN_OPERATIONS)[number]['operationId'];

/** The body the contract publishes for one outcome. Throws if it is not there. */
export function contractExample(
  operationId: AdminOperationId,
  status: number,
  example = 'default',
): unknown {
  const operation = ADMIN_CONTRACT.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) {
    throw new Error(`${operationId} is not in ${ADMIN_CONTRACT_SOURCE}`);
  }
  const bodies = operation.responses[String(status)];
  if (bodies === undefined) {
    throw new Error(`${operationId} publishes no ${status} in ${ADMIN_CONTRACT_SOURCE}`);
  }
  if (!(example in bodies)) {
    throw new Error(
      `${operationId} ${status} has no example "${example}" in ${ADMIN_CONTRACT_SOURCE} ` +
        `(it has: ${Object.keys(bodies).join(', ')})`,
    );
  }
  return bodies[example];
}

/**
 * Matches a concrete request path against the contract's templates.
 *
 * Segment by segment, because `{programmeId}` matches ONE segment and nothing
 * else. A pattern that matched a slash would let `/programmes/x/sla` resolve to
 * `getProgramme`, and the mock would answer a different screen's question with
 * a plausible-looking body.
 */
export function findOperation(method: string, pathname: string): MockOperation | undefined {
  const actual = pathname.split('/');
  return ADMIN_CONTRACT.find((candidate) => {
    if (candidate.method !== method) return false;
    const template = candidate.path.split('/');
    if (template.length !== actual.length) return false;
    return template.every((segment, index) =>
      segment.startsWith('{') && segment.endsWith('}') ? true : segment === actual[index],
    );
  });
}
