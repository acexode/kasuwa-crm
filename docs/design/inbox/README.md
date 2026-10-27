# Design inbox

Drop each Claude Design export here in a subfolder named for its Part 4
prompt: `P01/`, `P02/` and so on. One subfolder per prompt.

Then run:

```bash
node tools/design-intake.mjs          # dry run — shows what would move
node tools/design-intake.mjs --apply  # files them under docs/design/<prompt>/
```

## Folder layout: flat (settled in T-0155)

Filed designs live at `docs/design/<prompt>/<export file>`, for example
`docs/design/P28/Kasuwa Data Management.html`. There are no version folders. A
re-export of the same filename replaces the old file (intake prints
`replaces …`), and git holds the history. Thirteen prompts already use this
layout; P01 keeps its legacy `docs/design/P01/v1.0/` and is not moved. The design
system is `docs/design/v1.1/`, which is not prompt-scoped.

Files whose sha256 already exists anywhere under `docs/design/` are skipped,
so re-exporting a whole project only files the parts that actually changed.

## The manifest

The manifest is the list of screens and the ids task files cite (`P01/1b`), so a
task points at one screen rather than "the locked-account one". Intake reads it
from, in this order:

1. **`index.txt`** (a bundled export). A bundle has no board with ` & ` in its
   name. Run `node tools/design-parity.mjs design Pnn`, which captures every frame
   and writes `.artifacts/parity/design/Pnn/index.txt` (`file | size | section |
   label`). Intake finds it there, or in the drop itself if you copy it next to the
   export. The id is the frame number (`P28/07`). A `FAILED …` line means the
   capture lost a frame, and intake warns that the manifest is short.
2. **The index board**, the file with ` & ` in its name, whose data script lists
   the screens (the older export form).

If neither exists, intake says so and tells you which command to run. It never
files a drop and implies the manifest is complete.

To try it without touching `docs/design/`, run it on the fixture:

```bash
node tools/design-intake.mjs --design-root=tools/fixtures/design-intake
```
