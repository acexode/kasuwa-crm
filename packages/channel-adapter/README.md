# @kasuwa/channel-adapter

The single boundary between Kasuwa and a messaging provider (SMS, WhatsApp).
`CLAUDE.md` section 2 rule 8: no module outside this package may name or call
a messaging vendor.

## The provider decision is open

**Which real provider sits behind this interface has not been decided** (T-0017:
it is spend and a contract, so it is the product owner's call, raised through
`team/DECISIONS.md`). Until it is, the only implementation is
`FakeChannelProvider`, which sends nothing. Do not add a vendor SDK, URL or name
here before that decision lands — the T-0017 acceptance suite fails if you do.

## Using it

Callers never use a provider directly. They use the compliance wrapper:

```ts
const channel = createChannelAdapter({ provider, dnd, logger });
await channel.send({ scope, channel: 'sms', to: '+234...', body, purpose: 'transactional' });
```

`createChannelAdapter`, in front of every provider:

- validates the request with Zod — `to` must be E.164 and `purpose` is required
  with no default;
- refuses `promotional` sends to DND-registered numbers (`DndRefusedError`), and
  fails closed if the DND lookup fails; transactional sends skip the check;
- replaces anything the provider throws with a fresh typed `ChannelError`
  (`code`, `retryable`) that carries no message, `cause` or request from the
  provider — vendor errors routinely embed the number and the body;
- logs by code, channel, purpose and scope ids, never the destination or body.

A provider failure it cannot classify is treated as **not retryable** on send
(see the idempotency note below) and retryable on a status read.

## Known gap: idempotency

There is no idempotency key on `send` yet. A caller that retries a
`ProviderUnavailableError` after a timeout the provider actually accepted will
send the message twice — for an OTP, two different codes. Add a caller-supplied
key, passed through to the provider, before the sign-up OTP flow depends on
retries.
