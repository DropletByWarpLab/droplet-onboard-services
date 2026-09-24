# typescript-tool

A tool extension in TypeScript. `src/index.ts` exports `run(input)`; the
test in `test/` exercises the compiled output.

```
npm run build   # tsc → dist/
npm test        # node --test test/
```

No dependencies: the sandbox has no network.
