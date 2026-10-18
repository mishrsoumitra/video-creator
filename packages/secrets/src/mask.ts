const BULLETS = '••••';

/**
 * Settings shows the last four characters only. Keys shorter than 12 characters show none,
 * so a short key is never mostly revealed.
 */
export const maskSecret = (value: string): string => {
  if (value.length === 0) return '';
  return value.length >= 12 ? `${BULLETS}${value.slice(-4)}` : BULLETS;
};
