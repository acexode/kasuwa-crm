import {
  createChannelAdapter,
  type ChannelProvider,
  type DndRegister,
} from '@kasuwa/channel-adapter';

export type { DndRegister };

/**
 * The API's one way to send a message: the compliance wrapper from
 * `@kasuwa/channel-adapter`, never a provider directly (T-0030 seam S1).
 *
 * Inject it with `@Inject(CHANNEL)`. It is provided by AppModule, which is
 * global, so a feature module declares no provider of its own for it.
 */
export const CHANNEL = Symbol('CHANNEL');
/** Raw DND register for consent audit (T-0189), shared with {@link CHANNEL}. */
export const DND_REGISTER = Symbol('DND_REGISTER');

/**
 * There is no DND register integration yet (the NCC feed is not built), so the
 * API's register fails closed: any lookup throws, and the adapter turns that
 * into a refusal rather than a send. Transactional traffic and email never
 * consult it (D-L49), so today's only caller - the portal invitation - is
 * unaffected, and a promotional SMS cannot slip out before the register exists.
 */
export const unconfiguredDndRegister: DndRegister = {
  isRegistered: async () => {
    throw new Error('no DND register is configured');
  },
};

/** Wraps `provider` in the adapter. Logs nothing: the adapter's own log fields are codes and ids. */
export function createApiChannel(
  provider: ChannelProvider,
  dnd: DndRegister = unconfiguredDndRegister,
): ChannelProvider {
  return createChannelAdapter({ provider, dnd });
}
