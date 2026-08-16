# Contributing

Every capability claim in this repository carries an experiment number (see `EXPERIMENTS.md`). Contributions must follow the same rule.

## Rules

- **No claims without an experiment.** New capabilities need a benchmark/probe + control group before they enter `src/`.
- **Control groups are mandatory** — the source of a verdict must be proven (e.g. strategy A vs B vs C on the same workload).
- Tests must pass: `npm test` (unit + clock-disorder fuzz + implementation×model diff).
- No machine-specific paths in committed code.

## Development

```sh
npm run build   # tsc → lib/
npm test        # unit 37 + fuzz 200 seeds + diff 644 assertions
```

Environment: Node ≥ 22.6 (`node:sqlite`; tested on 25.8).
