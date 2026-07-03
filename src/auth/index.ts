import { AuthError, type AuthCredentials, type AuthProvider } from './types.js'

export type { AuthCredentials, AuthProvider, AuthErrorCode } from './types.js'
export { AuthError } from './types.js'
export {
  deleteTokenFile,
  readTokenFile,
  writeTokenFile,
} from './storage.js'

const registry = new Map<string, AuthProvider>()

/** Register an auth provider. Idempotent — re-registering the same name
 *  overwrites the previous instance (intended only for module hot-reload
 *  in tests). */
export function registerAuthProvider(provider: AuthProvider): void {
  registry.set(provider.name, provider)
}

/** Look up a registered auth provider. Throws AuthError if absent. */
export function getAuthProvider(name: string): AuthProvider {
  const provider = registry.get(name)
  if (!provider) {
    throw new AuthError({
      code: 'unknown_provider',
      provider: name,
      message: `Auth provider "${name}" is not registered.`,
    })
  }
  return provider
}

/** Convenience: resolve credentials for a provider by name.
 *  Equivalent to `getAuthProvider(name).getCredentials(opts)`. */
export async function getCredentials(
  name: string,
  opts?: { forceRefresh?: boolean },
): Promise<AuthCredentials> {
  return getAuthProvider(name).getCredentials(opts)
}

/** Names of all registered providers — for `/admin endpoint`. */
export function listAuthProviderNames(): string[] {
  return [...registry.keys()].sort()
}

/** Test-only: clear the registry between test cases. */
export function _resetAuthProviderRegistryForTests(): void {
  registry.clear()
}
