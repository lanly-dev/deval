# Change Log
All notable changes to the `deval` extension are documented here.\
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.
## [PLAN]
- Integrate future mainstream benchmarking suite
- Add pass@k
- More checks and cases

## [0.0.1] - 2026-10-09
- Initial release
- Three commands:
  - `evaluateAgentRun`: focus on agent harness - 8 checks
  - `benchmarkChatModel`: focus on llm - 11 cases
  - `showScoreboard`: history runs for comparing
- 10 files, 137.93 KB, 1.140.0
```
deval-0.0.1.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.md [1.06 KB]
   ├─ changelog.md [0.95 KB]
   ├─ package.json [5.64 KB]
   ├─ readme.md [2.09 KB]
   ├─ dist/
   │  └─ extension.js [26.99 KB]
   ├─ media/
   │  └─ deval.png [117.07 KB]
   └─ resources/
      └─ builtin-suites/
         ├─ model-benchmark.test.ts [10.04 KB]
         └─ spec.json [3.13 KB]
```
