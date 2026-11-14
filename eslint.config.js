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
  {
    files: ["packages/frontend/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property[key.name=/^(flex|minWidth|maxWidth|minHeight|maxHeight|width|height|padding(Top|Bottom|Left|Right|Inline|Block)?|margin(Top|Bottom|Left|Right)?|opacity|fontSize|fontWeight|fontStyle|textAlign|display|position|background|color|border|borderRadius|gap|alignItems|justifyContent|flexDirection|flexWrap)$/]",
          message:
            "Use a Mantine style prop (flex, miw, p, bg, ...) or Flex, Group or Stack; keep `style` for values with no prop.",
        },
      ],
    },
  },
  {
    files: ["packages/frontend/**/*.{ts,tsx}"],
    rules: {
      "padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "*",
          next: [
            "if",
            "for",
            "while",
            "do",
            "switch",
            "try",
            "function",
            "class",
            "return",
            "throw",
          ],
        },
        {
          blankLine: "always",
          prev: [
            "if",
            "for",
            "while",
            "do",
            "switch",
            "try",
            "function",
            "class",
          ],
          next: "*",
        },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
        { blankLine: "any", prev: ["case", "default"], next: "*" },
      ],
    },
  },
  prettier,
);
