/**
 * Lint configuration — deliberately narrow.
 *
 * WHY THIS EXISTS, specifically: this project's changelog records
 * "v33 — hooks after an early return", a crash that shipped. `verify.sh` has
 * carried a hand-rolled regex check for it since, and that check cannot see
 * arrow-function components at all (`const X = () => {`), slices function
 * bodies by searching for the next `function` keyword so it reads past the end
 * of the last one in a file, and requires the early return to be brace-wrapped
 * and indented exactly two spaces. Tested against two deliberate violations it
 * caught one, for the wrong reason. `react-hooks/rules-of-hooks` does the job
 * properly, from the AST.
 *
 * The second rule matters more for this app than the first.
 * `react-hooks/exhaustive-deps` finds memos and effects that do not recompute
 * when their inputs change. In a trajectory-analysis tool that failure does
 * not present as a bug — it presents as a RESULT. A plot built from the
 * previous metric looks exactly like a plot, and nothing on screen says the
 * number you are reading is stale. That is the class of defect this codebase
 * can least afford, and it was entirely unguarded.
 *
 * WHAT IS DELIBERATELY OFF
 * Style rules, formatting, and anything that would fire in the hundreds. A
 * lint run nobody reads is worse than no lint run, because it also hides the
 * two warnings that matter. In particular:
 *
 *   no-explicit-any — there are ~229 uses, and most are Plotly and NGL
 *     interop where no usable types exist. Banning it would mean 229
 *     suppression comments, which is not type safety.
 *   no-unused-vars — tsconfig's noUnusedLocals does this, in one place,
 *     with the compiler's own scope analysis.
 *
 * Add rules here when they would have caught a bug that actually happened.
 *
 * NOTE ON THE .mjs EXTENSION: this file is ESM, but package.json has no
 * `"type": "module"` and must not get one — electron/main.js and preload.js
 * are CommonJS and use require(), so declaring the package as ESM would break
 * the main process. `.mjs` marks this one file as ESM without touching them.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output and vendored code are not ours to lint.
    ignores: ['dist/**', 'dist-electron/**', 'dist-backend/**',
              'build-backend/**', 'node_modules/**', 'backend/**',
              'page.html', 'main.cjs'],
  },

  // ─── Frontend ─────────────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ── The reason this file exists ──────────────────────────────────────
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Off, with reasons; see the header ────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',       // noUnusedLocals does it
      '@typescript-eslint/no-empty-object-type': 'off', // `{}` props are idiomatic here
      // Empty catch blocks are used intentionally and are commented at every
      // site ("already gone", "representation disposed under us"). The pattern
      // is deliberate, not forgotten.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ─── Pure test scripts: bundled by esbuild and run under node ─────────────
  {
    files: ['src/**/__tests__/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A test's job is to assert, and `console.log` is how these report.
      'no-console': 'off',
    },
  },

  // ─── Electron main/preload: CommonJS, node globals ────────────────────────
  {
    files: ['electron/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ─── This config file itself ──────────────────────────────────────────────
  {
    files: ['eslint.config.mjs', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
)
