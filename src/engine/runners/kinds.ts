// The one map from parsed runner names to the kinds of check they cover (test, lint, build, typecheck), and the criterion words for each kind.
// A runner covers typecheck when its output reports the compiler's type errors (tsc, cargo build/check, clippy, next build); done uses this only for a reason, never a verdict. Every runner name a parser emits must be listed here (the dart parser also emits "flutter test").

export type CheckKind = "test" | "lint" | "build" | "typecheck";

export const RUNNER_KINDS: Readonly<Record<string, readonly CheckKind[]>> = {
  jest: ["test"],
  vitest: ["test"],
  mocha: ["test"],
  "node:test": ["test"],
  "bun test": ["test"],
  pytest: ["test"],
  unittest: ["test"],
  phpunit: ["test"],
  rspec: ["test"],
  "go test": ["test"],
  "cargo test": ["test"],
  "cargo nextest": ["test"],
  "dotnet test": ["test"],
  "mix test": ["test"],
  ctest: ["test"],
  prove: ["test"],
  behave: ["test"],
  tox: ["test"],
  "dart test": ["test"],
  "flutter test": ["test"],
  "julia test": ["test"],
  kaocha: ["test"],
  "swift test": ["test"],
  maven: ["build", "test", "typecheck"],
  eslint: ["lint"],
  oxlint: ["lint"],
  biome: ["lint"],
  ruff: ["lint"],
  clippy: ["lint", "typecheck"],
  "golangci-lint": ["lint", "typecheck"],
  rubocop: ["lint"],
  pint: ["lint"],
  phpstan: ["lint"],
  rector: [],
  tsc: ["typecheck", "build"],
  "next build": ["build", "typecheck"],
  "nix build": ["build"],
  vite: ["build"],
  "cargo build": ["build", "typecheck"],
  ninja: ["build"],
  msbuild: ["build", "typecheck"],
  "docker build": ["build"],
  make: ["build"],
  "swift build": ["build", "typecheck"],
};

export const LINTERS = ["oxlint", "eslint", "biome", "ruff", "phpstan", "pint", "stylelint", "golangci-lint", "clippy", "rubocop", "phpcs", "flake8", "pylint", "shellcheck", "markdownlint"] as const;

const CRITERION_KINDS: readonly [Exclude<CheckKind, "test">, RegExp][] = [
  ["lint", new RegExp(String.raw`\b(?:lint\w*|${LINTERS.join("|")})\b`, "i")],
  ["typecheck", /\b(?:type[- ]?check\w*|types? check\w*|type errors?|tsc|mypy|pyright)\b/i],
  ["build", /\b(?:build\w*|built|compil\w*|bundl\w*)\b/i],
];

export function uncoveredKinds(criterion: string, runners: readonly string[]): Exclude<CheckKind, "test">[] {
  const covered = new Set(runners.flatMap((r) => RUNNER_KINDS[r] ?? []));
  return CRITERION_KINDS.filter(([kind, re]) => re.test(criterion) && !covered.has(kind)).map(([kind]) => kind);
}
