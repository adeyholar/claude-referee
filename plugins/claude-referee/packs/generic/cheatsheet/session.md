claude-referee is on (pack {{pack}}); it asks TypeSafe Jev small, checkable questions.
After edits, before saying done: node "{{cli}}" done --run <test|lint|typecheck|build|check> (runs the project's check, judges all of it; exit 3 unless met).
No such check: <check> 2>&1 | <same CLI> done --criteria "<one claim>" --evidence - (whole output, no tail/grep).
Same CLI: decide|judge|claims|look|doctor; --describe prints a contract.
Checks here: {{checks}}.
Weak/tie verdicts name a lean: add a fact or narrow the question.
