export const REQUIRED_E2E_MANIFEST = Object.freeze([
  Object.freeze({
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title: "public signup exposes no privileged role choice and provisions only a student",
  }),
  Object.freeze({
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title: "mentor username login is forced through first-password change",
  }),
  Object.freeze({
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title:
      "team admin creates and disables a mentor whose existing session then loses read and send",
  }),
  Object.freeze({
    file: "tests/e2e/workbuddy-loop.spec.ts",
    title: "ingest reaches the mentor, reply reaches web and WorkBuddy until acknowledged",
  }),
]);
