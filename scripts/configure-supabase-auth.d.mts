export interface DesiredSupabaseAuthConfig {
  projectRef: string;
  siteUrl: string;
  additionalRedirectUrls: string[];
  enableSignup: boolean;
  email: {
    enableSignup: boolean;
    enableConfirmations: boolean;
  };
}

export interface ManagementAuthConfig {
  site_url?: unknown;
  uri_allow_list?: unknown;
  disable_signup?: unknown;
  external_email_enabled?: unknown;
  mailer_autoconfirm?: unknown;
  [key: string]: unknown;
}

export type ManagementAuthPatch = {
  site_url?: string;
  uri_allow_list?: string;
  disable_signup?: boolean;
  external_email_enabled?: boolean;
  mailer_autoconfirm?: boolean;
};

export function loadTrackedAuthConfiguration(root: string): Promise<DesiredSupabaseAuthConfig>;

export function createManagementAuthPatch(
  desired: DesiredSupabaseAuthConfig,
  remote: ManagementAuthConfig,
): ManagementAuthPatch;

export function parseAuthConfigArguments(arguments_: string[]): {
  apply: boolean;
  projectRef?: string;
};

export function resolveSupabaseAccessToken(options: {
  environmentToken: string | undefined;
  platform: NodeJS.Platform;
  execFileImpl?: (
    executable: string,
    arguments_: string[],
    options: {
      encoding: "utf8";
      maxBuffer: number;
      windowsHide: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<string>;

export function syncSupabaseAuthConfig(options: {
  root: string;
  accessToken: string | undefined;
  apply: boolean;
  confirmedProjectRef?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  applied: boolean;
  verified: boolean;
  projectRef: string;
  patch: ManagementAuthPatch;
}>;
