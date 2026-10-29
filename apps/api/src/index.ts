/**
 * Public entry point of the API application.
 *
 * Exists so that tests import the app through its package name rather than by
 * reaching across the workspace with a relative path. The Nx boundary rule
 * rejects relative cross-project imports, and it is right to: a relative path
 * into another project is a dependency the project graph cannot see.
 *
 * src/main.ts is the runtime entry point and deliberately stays out of this
 * barrel, so importing the app never starts a server.
 */
export { AppModule, type AppModuleOptions } from './app.module';
export { AUTH_MODE, type ResolvedAuthMode } from './tenancy/kasuwa-auth.guard';
export { AUTH_POLICY, DEFAULT_AUTH_POLICY, type AuthPolicy } from './auth/auth.policy';
export {
  FORBIDDEN_SCOPE_HEADERS,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
  type AuthContext,
} from './tenancy/auth-context';
export { setMbsProviderForTests } from './commerce/einvoice.service';
export { setMobileMoneyProviderForTests } from './commerce/mobile-payment.service';
