import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["packages/frontend/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: [
      "packages/frontend/src/{components,hooks,stores,lib,queries}/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)routes/",
              message: "Shared code must not import from routes/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/frontend/src/routes/*/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(\\.\\./)+(?!components/|hooks/|stores/|lib/|queries/|api)[a-z]+/(components|lib)/",
              message:
                "A route does not import another route's components/ or lib/.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
