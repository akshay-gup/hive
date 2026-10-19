/**
 * Does this error say the connection to the workspace dropped, as it does when the workspace restarts
 * for an update or a reboot, rather than the agent failing? Only the first kind is worth trying again
 * by itself: the same message will go through once the workspace is back.
 */
export function looksLikeLostConnection(message: string): boolean {
  return /failed to fetch|load failed|networkerror|network error|network request|terminated|socket|econn|connection (?:was )?(?:closed|lost|reset|refused)|bad gateway|service unavailable|gateway time-?out|incomplete|\b50[234]\b/i.test(
    message,
  );
}
