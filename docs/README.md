# Documentation

Five documents, written to be read in roughly this order.

| | |
|---|---|
| **[architecture.md](./architecture.md)** | How the thing is built, and why each load-bearing decision went the way it did. Start here. |
| **[performance.md](./performance.md)** | Every measurement in one place, with the methodology that produced it and what each number does *not* mean. |
| **[learnings.md](./learnings.md)** | What turned out to be wrong, and what I would do differently. The most useful document here. |
| **[limitations.md](./limitations.md)** | What does not work, what was deliberately not built, and what to consider before taking any of this further. |
| **[testing.md](./testing.md)** | The three testing layers, what each is for, and why they are separate. |

## How this relates to NOTES.md

[`NOTES.md`](../NOTES.md) is the **chronological log** — one section per build
phase, written as the work happened, including several decisions that were later
reversed. It is the provenance of everything here: if a number in
`performance.md` looks surprising, `NOTES.md` has the run it came from and the
reasoning at the time.

These documents are the **synthesis**. They describe the system as it now
stands, not as it was arrived at. Where the two disagree, these are correct and
`NOTES.md` is history.
