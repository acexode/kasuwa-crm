# Development object store identities

`s3-identities.json` is mounted into the compose `seaweedfs` service as its S3
identity config (`-s3.config`, T-0092, ADR-0017). It ends D-L21's anonymous
mode: every S3 request to the dev store must be signed, so `pnpm dev` exercises
SigV4 signing, presigned part URLs and their expiry the way a real cell does.

- **Development only, and committed on purpose.** The one credential is an
  invented value that `.env.example` repeats as `S3_ACCESS_KEY_ID` and
  `S3_SECRET_ACCESS_KEY`. It protects nothing and must never be used anywhere
  real. Real cells use workload identity or keys from their secrets manager
  (D-L128 Q1), never this file.
- **No identity is named `anonymous`**: SeaweedFS treats that name as
  unauthenticated access. The T-0092 acceptance suite checks both rules, and
  starts SeaweedFS with this very file to prove an unsigned read is refused.
- The identity has no `Admin` action. The bucket is created by `pnpm dev`
  through `weed shell` inside the container, which needs no S3 credential.
- **CORS.** SeaweedFS 3.80 has no per-bucket CORS (PutBucketCors is 501). The
  only origin control is the gateway flag `-s3.allowedOrigins` in
  `docker-compose.yml`, which lists the web app's origins and no wildcard (R11).
  "PUT and GET only, expose ETag" cannot be expressed on SeaweedFS; real cells
  set a bucket CORS rule (T-0005).
