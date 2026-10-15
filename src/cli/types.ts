// Shapes shared by the CLI runner and its commands; Io keeps commands testable without a real process.
// asksJev: whether this run would ask Jev (for the error receipt); without it, a command that lists no_api_key does.

import type { ParseArgsOptionsConfig } from "node:util";
import type { Env } from "../engine/config.ts";
import type { Result } from "../engine/output.ts";

export interface Io {
  readonly env: Env;
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readStdin(): Promise<string>;
  write(text: string): void;
  warn(text: string): void;
  now(): number;
}

export interface Describe {
  readonly summary: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
  readonly effects: string;
  readonly cost: string;
}

export type Values = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

export interface GlobalFlags {
  readonly pretty: boolean;
  readonly dryRun: boolean;
  readonly fresh: boolean;
  readonly verbose: boolean;
  readonly dataDir: string | undefined;
  readonly pack: string | undefined;
  readonly failOn: readonly string[];
}

export interface Context {
  readonly io: Io;
  readonly flags: GlobalFlags;
  readonly values: Values;
  readonly positionals: readonly string[];
}

export interface Command {
  readonly name: string;
  readonly defaultFailOn?: (context: Context) => readonly string[];
  readonly describe: Describe;
  readonly options: ParseArgsOptionsConfig;
  asksJev?(context: Context): boolean;
  run(context: Context): Promise<Result>;
}
