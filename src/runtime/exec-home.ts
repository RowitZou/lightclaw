/**
 * The environment for a sandbox agent exec, with HOME pointed at a writable,
 * persistent location.
 *
 * The worker/container image's default HOME (e.g. `/root`) is owned by root and
 * unwritable by the daemon uid that agent execs drop to (setpriv / `docker exec
 * --user`). Without this, every HOME-default tool — `pip install --user`,
 * `conda create -n`, `~/.cache` (HF model downloads / pip wheels), `~/.gitconfig`,
 * `~/.ssh` — hits permission-denied. Pointing HOME at `<workspaceContainerPath>/.home`
 * (mkdir'd daemon-side by `RuntimePool.acquire`, so it's daemon-uid-owned and
 * writable) makes them Just Work AND persist across worker/container restarts,
 * since it lives on the persistent workspace mount.
 *
 * Privileged bootstrap execs keep the image HOME (they run as root, which can
 * write it). A caller that explicitly sets HOME via `ExecInput.env` wins.
 */
export function agentExecEnv(
  workspaceContainerPath: string,
  privileged: boolean,
  inputEnv?: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (privileged) return inputEnv as Record<string, string> | undefined
  return { HOME: `${workspaceContainerPath}/.home`, ...inputEnv }
}
