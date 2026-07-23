import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getStaffAccessDecision, safePostAuthPath } from "@/lib/auth/navigation";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const safeNext = safePostAuthPath(location.href);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }

    const { data: staff, error: staffError } = await supabase
      .from("staff_accounts")
      .select("is_active, must_change_password")
      .eq("user_id", data.user.id)
      .maybeSingle();

    if (staffError) {
      await supabase.auth.signOut();
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }

    const decision = getStaffAccessDecision(
      staff
        ? {
            isActive: staff.is_active,
            mustChangePassword: staff.must_change_password,
          }
        : null,
    );

    if (decision === "sign_out") {
      await supabase.auth.signOut();
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }

    if (decision === "change_password") {
      throw redirect({
        to: "/change-password",
        search: { next: safeNext },
      });
    }

    return { user: data.user };
  },
  component: () => <Outlet />,
});
