/*
 * The active profile as this window knows it (profiles design 4.3). The
 * backend serves the active profile, so almost nothing in the UI depends on
 * it; only the views saved in localStorage do (open tabs and folders), and
 * they are kept per profile, so switching back finds the tabs where they were
 * left. It is set when the app starts and when a switch is announced.
 */

export const DEFAULT_PROFILE = "default";

let current = DEFAULT_PROFILE;

export const currentProfile = (): string => current;

export function setCurrentProfile(id: string): void {
  current = id;
}

/**
 * What a saved-view key ends with. The Default profile's keys are the ones
 * that existed before profiles, so nobody loses their open tabs.
 */
export const profileSuffix = (): string =>
  current === DEFAULT_PROFILE ? "" : `.p.${current}`;
