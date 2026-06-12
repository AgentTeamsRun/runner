import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  global: "readonly",
  globalThis: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  fetch: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  Request: "readonly",
  RequestInit: "readonly",
  Response: "readonly",
  Headers: "readonly",
  FormData: "readonly",
  ReadableStream: "readonly",
  WritableStream: "readonly",
  TransformStream: "readonly",
  Blob: "readonly",
  File: "readonly",
  crypto: "readonly",
  performance: "readonly",
  btoa: "readonly",
  atob: "readonly",
  structuredClone: "readonly",
  NodeJS: "readonly",
  NodeRequire: "readonly",
  NodeModule: "readonly",
  NodeProcess: "readonly",
  NodeTimeout: "readonly",
  NodeImmediate: "readonly"
};

const nodeTestGlobals = {
  describe: "readonly",
  it: "readonly",
  test: "readonly",
  before: "readonly",
  after: "readonly",
  beforeEach: "readonly",
  afterEach: "readonly",
  mock: "readonly"
};

const ruleOverrides = {
  "no-redeclare": "off",
  "@typescript-eslint/no-redeclare": "off",
  "no-regex-spaces": "off",
  "no-useless-escape": "off",
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_"
    }
  ],
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-empty-function": "off",
  "@typescript-eslint/ban-ts-comment": "warn",
  "no-empty": "off"
};

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname
      },
      globals: { ...nodeGlobals, ...nodeTestGlobals }
    },
    rules: ruleOverrides
  },
  globalIgnores([
    "dist/**",
    "node_modules/**",
    "coverage/**"
  ])
]);
