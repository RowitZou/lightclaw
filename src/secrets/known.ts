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

// Well-known per-user SETTING (not a credential): the Brain++ namespace/charged-
// group pair(s) the user is allowed to submit cluster jobs under, written as
// `<namespace>:<group>` tokens, comma-separated when the user has access to more
// than one (e.g. "ailab-foo:foo-gpu,ailab-bar:bar-gpu"). A charged group is scoped
// to a namespace (the cluster queue is `<namespace>-<group>`), so the two always
// travel as one token — there is no separate-list ordering to get wrong. The first
// pair is the default a submit uses when none is named explicitly.
//
// Unlike the AK/SK names above, this is NOT read by rjob from the environment —
// the cluster-job tool reads it from the secret store and turns it into the
// `--namespace` + `--charged-group` submit flags. It exists so a BYO user's jobs
// bill against a namespace/group they actually have quota in: an AK/SK only carries
// quota in its own namespace/group(s), so without an explicit pair rjob falls back
// to the deployment namespace's default group (the operator's), which a different
// user's credentials have no access to. Submit therefore fails closed when this is
// unset rather than silently using that default.
export const BRAINPP_CHARGED_GROUP_SETTING = 'BRAINPP_CHARGED_GROUP'

export function isBrainppCredentialSecret(name: string): boolean {
  return name === BRAINPP_ACCESS_KEY_SECRET || name === BRAINPP_SECRET_KEY_SECRET
}
