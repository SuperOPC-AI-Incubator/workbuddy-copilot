export function verifyLiveDeploymentBeforeWrite<T>(input: {
  appOrigin: string;
  expectedSupabaseUrl: string;
  fetchImpl?: typeof fetch;
  write: () => T | Promise<T>;
}): Promise<T>;
