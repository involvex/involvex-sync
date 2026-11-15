/** Minimal peer shape needed for seed-on-read migration. */
export type MigratablePeer = { deviceId: string };

/**
 * Fold a legacy single-peer entry into the peers list (seed-on-read).
 * Returns whether the list grew so the caller can persist + drop the legacy slot.
 */
export function foldLegacyPeer<T extends MigratablePeer>(
  peers: T[],
  legacy: T | null | undefined,
): { peers: T[]; migrated: boolean } {
  if (!legacy?.deviceId) {
    return { peers, migrated: false };
  }
  if (peers.some((p) => p.deviceId === legacy.deviceId)) {
    return { peers, migrated: false };
  }
  return { peers: [...peers, legacy], migrated: true };
}
