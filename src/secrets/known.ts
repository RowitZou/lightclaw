// Well-known per-user secret names that specific tools consume directly
// (read straight from the secret store), as opposed to general `$NAME` Bash
// injection that requires an explicit enable step.
//
// The two Brain++ names below are NOT arbitrary: they are the exact env var
// names the cluster CLI (`rjob`, i.e. brainpp's RJobClient) reads to pick a
// credential. When set, the CLI authenticates as that access key; when empty,
// it falls back to the pod-provisioned files under `/.auth`. Verified against
// the installed brainpp package (`rjob/__main__.py` builds the client with
// `access_key=os.environ.get('BRAINPP_ACCESS_KEY_ID')` /
// `secret_key=os.environ.get('BRAINPP_SECRET_ACCESS_KEY')`, and
// `rjob/client.py` falls back to `/.auth/accesskey_{id,secret}` when empty).
// Keep these strings byte-identical to those env names or injection becomes a
// silent no-op.
export const BRAINPP_ACCESS_KEY_SECRET = 'BRAINPP_ACCESS_KEY_ID'
export const BRAINPP_SECRET_KEY_SECRET = 'BRAINPP_SECRET_ACCESS_KEY'

export function isBrainppCredentialSecret(name: string): boolean {
  return name === BRAINPP_ACCESS_KEY_SECRET || name === BRAINPP_SECRET_KEY_SECRET
}
