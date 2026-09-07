/** Version check against the npm registry. The only network call outside snapshot.ts. */

const REGISTRY = 'https://registry.npmjs.org';

/**
 * Numeric compare of the semver core. Prerelease tags are stripped, which is
 * enough to answer "is the published version newer than mine".
 * ponytail: no prerelease ordering; add a semver dep only if we ship betas.
 */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The version published under the `latest` dist-tag. */
export async function latestVersion(name: string, timeoutMs = 5000): Promise<string> {
  const response = await fetch(`${REGISTRY}/${name}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${name}.`);
  const body = (await response.json()) as { version?: string };
  if (!body.version) throw new Error(`npm registry returned no version for ${name}.`);
  return body.version;
}
