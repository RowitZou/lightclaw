export const BRAINPP_ACCESS_KEY_SECRET = 'BRAINPP_ACCESS_KEY'
export const BRAINPP_SECRET_KEY_SECRET = 'BRAINPP_SECRET_KEY'

export function isBrainppCredentialSecret(name: string): boolean {
  return name === BRAINPP_ACCESS_KEY_SECRET || name === BRAINPP_SECRET_KEY_SECRET
}
