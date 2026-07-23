import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const signInInput = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(6).max(256),
});

export const signIn = createServerFn({ method: "POST" })
  .validator((input: unknown) => signInInput.parse(input))
  .handler(async ({ data }) => {
    const { signIn: signInOnServer } = await import("./signin.server");
    return signInOnServer(data);
  });
