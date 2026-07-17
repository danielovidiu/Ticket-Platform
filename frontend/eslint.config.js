// ESLint 9 flat-config for standalone `yarn eslint` runs (CI / editor).
// CRA's internal webpack-eslint uses craco.config.js eslint.configure — this file
// is only for command-line `eslint` invocations, which previously failed with
// "ESLint couldn't find an eslint.config.(js|mjs|cjs) file".

const js = require("@eslint/js");
const reactHooks = require("eslint-plugin-react-hooks");
const reactPlugin = require("eslint-plugin-react");
const jsxA11y = require("eslint-plugin-jsx-a11y");
const importPlugin = require("eslint-plugin-import");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "build/**",
      "node_modules/**",
      "plugins/**",
      "public/**",
      "coverage/**",
      "src/components/ui/**", // shadcn-generated components — leave as-is
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        process: "readonly",
      },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      import: importPlugin,
    },
    rules: {
      // React
      "react/jsx-uses-react": "off",
      "react/jsx-uses-vars": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-key": "warn",
      "react/no-unescaped-entities": "off",
      // React hooks
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // JS
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-console": "off",
    },
  },
];
