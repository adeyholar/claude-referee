// Registry of CLI commands, in the order the help text lists them.

import type { Command } from "../types.ts";
import { audit } from "./audit.ts";
import { decide } from "./decide.ts";
import { doctor } from "./doctor.ts";
import { done } from "./done.ts";
import { evalCommand } from "./eval.ts";
import { extract } from "./extract.ts";
import { judge } from "./judge.ts";
import { lintPack } from "./lint-pack.ts";
import { receipts } from "./receipts.ts";
import { ui } from "./ui.ts";
import { claims, verify } from "./verify.ts";

export const commands: readonly Command[] = [done, decide, judge, extract, claims, verify, audit, receipts, doctor, evalCommand, lintPack, ui];
