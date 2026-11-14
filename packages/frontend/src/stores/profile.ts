export const DEFAULT_PROFILE = "default";

let current = DEFAULT_PROFILE;

export const currentProfile = (): string => current;

export function setCurrentProfile(id: string): void {
  current = id;
}

export const profileSuffix = (): string =>
  current === DEFAULT_PROFILE ? "" : `.p.${current}`;
