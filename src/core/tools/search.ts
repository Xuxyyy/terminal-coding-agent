export const SEARCH_EXCLUSIONS = [
  '.git', '.acc', '.claude', '.ssh', '.aws', '.azure', '.gnupg', '.docker',
  '.codex', '.kube', '.env*', '.npmrc', '.netrc', '.git-credentials',
  'id_rsa', 'id_ed25519', 'credentials.json', '*.pem', '*.key', '*.p12', '*.pfx',
];

export function searchExclusionArgs(): string[] {
  return SEARCH_EXCLUSIONS.flatMap((name) => ['--glob', `!${name}`]);
}
