import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/oauth/consent")({
  ssr: false,
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/.lovable/oauth/consent${location.searchStr}` });
  },
});
