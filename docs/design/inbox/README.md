# Design inbox

Drop each Claude Design export here in a subfolder named for its Part 4
prompt: `P01/`, `P02/` and so on. One subfolder per prompt.

Then run:

```bash
node tools/design-intake.mjs          # dry run — shows what would move
node tools/design-intake.mjs --apply  # files them under docs/design/<prompt>/<version>/
```

Files whose sha256 already exists anywhere under `docs/design/` are skipped,
so re-exporting a whole project only versions the parts that actually changed.

The index board — the file with ` & ` in its name — is the manifest. Its screen
ids are what task files cite (`P01/1b`), so a task points at one screen rather
than "the locked-account one".
