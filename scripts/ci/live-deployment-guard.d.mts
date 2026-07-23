export function verifyLiveDeploymentBeforeWrite<T>(input: {
  appOrigin: string;
  expectedSupabaseUrl: string;
  fetchImpl?: typeof fetch;
  write: () => T | Promise<T>;
}): Promise<T>;

export function isRemoteE2EOrigin(value: string | undefined): boolean;

export function runRequiredE2EAfterDeploymentGuard<T>(input: {
  environment: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  write: () => T | Promise<T>;
}): Promise<T>;
