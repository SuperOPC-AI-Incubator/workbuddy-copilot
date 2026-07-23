import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { loginIdentifierToEmail, mentorUsernameToEmail } from "@/lib/auth/identifiers";

export type AppRole = Database["public"]["Enums"]["app_role"];

export type AuthenticatedPasswordSession = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
};

export type TrustedStaffAccount = {
  username: string;
  isActive: boolean;
  mustChangePassword: boolean;
};

export type StudentAccount = {
  displayName: string;
};

export interface SignInGateway {
  authenticateWithPassword(input: {
    email: string;
    password: string;
  }): Promise<AuthenticatedPasswordSession>;
  getRoles(userId: string): Promise<AppRole[]>;
  getStaffAccount(userId: string): Promise<TrustedStaffAccount | null>;
  getStudentAccount(userId: string): Promise<StudentAccount | null>;
}

export type SignInGatewayErrorKind =
  | "invalid_credentials"
  | "account_unavailable"
  | "rate_limited"
  | "service_unavailable";

export class SignInGatewayError extends Error {
  readonly kind: SignInGatewayErrorKind;

  constructor(kind: SignInGatewayErrorKind) {
    super(kind);
    this.name = "SignInGatewayError";
    this.kind = kind;
  }
}

export type SignInInput = {
  identifier: string;
  password: string;
};

export type SignInResult = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  public: {
    userId: string;
    accountType: "staff" | "student";
    displayName: string;
    roles: AppRole[];
    mustChangePassword: boolean;
  };
};

const INVALID_IDENTIFIER_ERROR = "账号格式不正确";
const INVALID_CREDENTIALS_ERROR = "账号或密码错误";
const ACCOUNT_UNAVAILABLE_ERROR = "账号不可用，请联系管理员";
const RATE_LIMITED_ERROR = "尝试次数过多，请稍后重试";
const SERVICE_UNAVAILABLE_ERROR = "认证服务暂时不可用";

function isEmailIdentifier(identifier: string): boolean {
  return identifier.normalize("NFKC").trim().includes("@");
}

function publicResult(
  session: AuthenticatedPasswordSession,
  account: SignInResult["public"],
): SignInResult {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    ...(session.expiresAt === undefined ? {} : { expires_at: session.expiresAt }),
    public: account,
  };
}

function publicAuthenticationError(error: unknown): Error {
  if (!(error instanceof SignInGatewayError)) {
    return new Error(SERVICE_UNAVAILABLE_ERROR);
  }

  switch (error.kind) {
    case "invalid_credentials":
      return new Error(INVALID_CREDENTIALS_ERROR);
    case "account_unavailable":
      return new Error(ACCOUNT_UNAVAILABLE_ERROR);
    case "rate_limited":
      return new Error(RATE_LIMITED_ERROR);
    case "service_unavailable":
      return new Error(SERVICE_UNAVAILABLE_ERROR);
  }
}

export function createSignInService(
  gateway: SignInGateway,
): (input: SignInInput) => Promise<SignInResult> {
  return async ({ identifier, password }) => {
    const emailIdentifier = isEmailIdentifier(identifier);
    let authEmail: string;

    try {
      authEmail = loginIdentifierToEmail(identifier);
    } catch {
      throw new Error(INVALID_IDENTIFIER_ERROR);
    }

    let session: AuthenticatedPasswordSession;
    try {
      session = await gateway.authenticateWithPassword({
        email: authEmail,
        password,
      });
    } catch (error) {
      throw publicAuthenticationError(error);
    }

    let roles: AppRole[];
    let staffAccount: TrustedStaffAccount | null;
    let studentAccount: StudentAccount | null;
    try {
      [roles, staffAccount, studentAccount] = await Promise.all([
        gateway.getRoles(session.userId),
        gateway.getStaffAccount(session.userId),
        gateway.getStudentAccount(session.userId),
      ]);
    } catch {
      throw new Error(SERVICE_UNAVAILABLE_ERROR);
    }

    const hasStaffRole = roles.some((role) => role === "mentor" || role === "team_admin");
    const hasStudentRole = roles.includes("student");

    if (staffAccount) {
      let matchesSubmittedUsername = true;
      if (!emailIdentifier) {
        try {
          matchesSubmittedUsername = mentorUsernameToEmail(staffAccount.username) === authEmail;
        } catch {
          matchesSubmittedUsername = false;
        }
      }

      if (
        !staffAccount.isActive ||
        !matchesSubmittedUsername ||
        !hasStaffRole ||
        hasStudentRole ||
        studentAccount
      ) {
        throw new Error(ACCOUNT_UNAVAILABLE_ERROR);
      }

      return publicResult(session, {
        userId: session.userId,
        accountType: "staff",
        displayName: staffAccount.username,
        roles,
        mustChangePassword: staffAccount.mustChangePassword,
      });
    }

    if (!emailIdentifier) {
      throw new Error(ACCOUNT_UNAVAILABLE_ERROR);
    }

    if (!studentAccount || !hasStudentRole || hasStaffRole) {
      throw new Error(ACCOUNT_UNAVAILABLE_ERROR);
    }

    return publicResult(session, {
      userId: session.userId,
      accountType: "student",
      displayName: studentAccount.displayName,
      roles,
      mustChangePassword: false,
    });
  };
}

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

export function classifySupabaseAuthError(error: unknown): SignInGatewayError {
  const authError =
    typeof error === "object" && error !== null
      ? (error as { code?: string; status?: number })
      : {};

  if (
    authError.status === 429 ||
    authError.code === "over_request_rate_limit" ||
    authError.code === "over_email_send_rate_limit"
  ) {
    return new SignInGatewayError("rate_limited");
  }

  if (authError.code === "invalid_credentials") {
    return new SignInGatewayError("invalid_credentials");
  }

  if (authError.code === "email_not_confirmed" || authError.code === "user_banned") {
    return new SignInGatewayError("account_unavailable");
  }

  return new SignInGatewayError("service_unavailable");
}

export function createProductionSignInGateway(): SignInGateway {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !publishableKey) {
    throw new Error(SERVICE_UNAVAILABLE_ERROR);
  }

  const passwordAuthClient = createClient<Database>(supabaseUrl, publishableKey, {
    global: {
      fetch: createSupabaseFetch(publishableKey),
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return {
    async authenticateWithPassword({ email, password }) {
      let response: Awaited<ReturnType<typeof passwordAuthClient.auth.signInWithPassword>>;

      try {
        response = await passwordAuthClient.auth.signInWithPassword({
          email,
          password,
        });
      } catch (error) {
        throw classifySupabaseAuthError(error);
      }

      if (response.error) {
        throw classifySupabaseAuthError(response.error);
      }

      if (!response.data.user || !response.data.session) {
        throw new SignInGatewayError("service_unavailable");
      }

      return {
        userId: response.data.user.id,
        accessToken: response.data.session.access_token,
        refreshToken: response.data.session.refresh_token,
        ...(response.data.session.expires_at === undefined
          ? {}
          : { expiresAt: response.data.session.expires_at }),
      };
    },

    async getRoles(userId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);

      if (error) throw error;
      return data.map(({ role }) => role);
    },

    async getStaffAccount(userId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("staff_accounts")
        .select("username, is_active, must_change_password")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      return {
        username: data.username,
        isActive: data.is_active,
        mustChangePassword: data.must_change_password,
      };
    },

    async getStudentAccount(userId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("students")
        .select("display_name")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      return data ? { displayName: data.display_name } : null;
    },
  };
}

export async function signIn(input: SignInInput): Promise<SignInResult> {
  console.info("[Auth] Password sign-in started");

  let gateway: SignInGateway;

  try {
    gateway = createProductionSignInGateway();
  } catch {
    console.warn("[Auth] Password sign-in rejected", { reason: "service_unavailable" });
    throw new Error(SERVICE_UNAVAILABLE_ERROR);
  }

  try {
    const result = await createSignInService(gateway)(input);
    console.info("[Auth] Password sign-in completed", {
      accountType: result.public.accountType,
    });
    return result;
  } catch (error) {
    console.warn("[Auth] Password sign-in rejected", { reason: "request_rejected" });
    throw error;
  }
}
