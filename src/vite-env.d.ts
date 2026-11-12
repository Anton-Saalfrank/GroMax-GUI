/// <reference types="vite/client" />
//
// Gives `import.meta.env` its real type. Without it the only way to read a
// Vite env flag was `(import.meta as any).env?.X`, and that cast defeats the
// build-time substitution: Vite replaces the literal `import.meta.env.DEV`,
// so a dev-only block written with the cast survives into production instead
// of folding to `if (false)` and being dropped.
