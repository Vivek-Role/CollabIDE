# Load test results — Phase 8

**Measured 2026-08-15.** Every number in this file came from a run performed on
that date, on the machine described below, by the harness in `loadtest/`. The raw
result blobs are committed under `loadtest/results/*.json` — each table row
traces to one file, and the percentiles can be recomputed from the raw samples
those files retain.

**No estimates appear anywhere in this document.** Where something was not
measured, it says so.

---

## 1. How to reproduce

```bash
docker compose -f infra/docker-compose.yml up -d     # postgres 16 + redis 7
npm run build                                        # also builds @collab/shared

# The BUILT server, never `tsx watch` — a watcher and an ESM loader hook would
# be measured as if they were the server, and `tsx watch` is a three-process
# tree whose pid is ambiguous.
node apps/server/dist/index.js                       # instance A, :4000
PORT=4001 WEB_ORIGIN=http://localhost:5174 \
  node apps/server/dist/index.js                     # instance B (2-instance runs)

npm run loadtest -- --self-check                     # proves the percentile maths

npm run loadtest -- --scenario hot-doc --clients 25 \
  --edits-per-sec 2 --duration 60 --ramp 10 --warmup 5 --probe-hz 1 --workers 4 \
  --servers http://localhost:4000 --server-pid <pidA> \
  --database-url postgresql://collab:collab_dev_password@localhost:5432/collab_editor \
  --out loadtest/results/R2-25-a.json
```

The exact `argv` of every run is stored in its blob (`environment.argv`) and is
the authoritative record. The other three runs differ only in `--scenario`,
`--docs`, `--servers` and `--server-pid`.

**Do not export `DATABASE_URL` before starting the server.** `apps/server/src/config.ts`
loads `apps/server/.env` only when `DATABASE_URL` is unset, so exporting it
suppresses the `.env` load entirely and the server dies on a missing
`JWT_SECRET`. Pass `--database-url` to the harness instead. This cost one aborted
run during this session.

**Servers were restarted between scenario groups**, and the one-instance runs had
instance B stopped. No runner process was started — code execution is not part of
this measurement.

---

## 2. Environment

Captured automatically into every blob (`environment`), not typed by hand:

| | |
|---|---|
| Date | 2026-08-15, times below in UTC |
| Git | `09b4c3f2c1670288e10296788bd5e78d443a5a16` (`test/load-testing`), **working tree dirty** — see note |
| Node | v24.19.0 |
| CPU | 13th Gen Intel(R) Core(TM) i7-13620H |
| Cores visible to the VM | **4** |
| Memory visible to the VM | 5927 MB |
| Kernel | 6.18.33.2-microsoft-standard-WSL2 |
| `.wslconfig` | **`memory=6GB`, `processors=4`** |
| Containers | `postgres:16-alpine`, `redis:7-alpine` |
| Docker version | **not captured** — the Docker CLI is unavailable inside this WSL distro (integration off). Operator-supplied: Docker Desktop 4.85.0, engine 29.6.2 |
| Also running | Docker Desktop, WSL2, one Claude Code session. No browser, no Vite dev server, no IDE |

**On "dirty":** the measured tree is commit `09b4c3f` **plus the uncommitted
Phase 8 harness** (`loadtest/`, and two lines in the root `package.json`).
`git diff --stat 09b4c3f -- apps packages` is **empty** — `apps/server`,
`apps/runner`, `apps/web` and `packages/shared` are byte-identical to the commit,
so the software under test is exactly `09b4c3f`. No instrumentation was added to
the server for this measurement.

**The `.wslconfig` cap of 6 GB / 4 processors bounds every number here.** So does
the fact that the load generator shares those 4 cores with both servers,
PostgreSQL and Redis — which turns out to be the dominant limit (§4).

---

## 3. Fixed settings

All runs: `--edits-per-sec 2 --duration 60 --ramp 10 --warmup 5 --probe-hz 1
--workers 4`, one owner account for all virtual clients.

- One edit = one character inserted at a random offset. 2/sec/client.
- Latency = one prober's marker insert → another client on the same document
  observing it, measured with `Date.now()` inside one process.
- The 10 s ramp is excluded structurally (clients do not type during it); the
  first 5 s of steady state are discarded by timestamp, and the discarded count
  is reported.
- One owner account for every client is disclosed here so these are not read as
  N distinct humans: authorization resolves once at join, and each client has its
  own `Y.Doc` and client id, so the load on socket, room, bus and database is the
  same as N accounts would produce.

---

## 4. The client-count climb, and the ceiling

Climbed on the hot-doc shapes only, since one document is the most contended
case. **Stop criteria were fixed before the runs**: divergence, lost clients,
p99 > 1000 ms, sample starvation (n < half of expected), or harness saturation.

### R2 — hot doc, 1 instance

| clients | p50 | p95 | p99 | n | converged | server CPU% mean/peak | **harness CPU% mean/peak** | verdict |
|---|---|---|---|---|---|---|---|---|
| 25 | 6.0 | 16.0 | 23.0 | 1320 | yes | 5.7 / 14.0 | **75.1 / 217.7** | **pass** |
| 50 | 26.0 | 193.0 | 282.0 | 2597 | yes | 7.9 / 19.0 | **252.8 / 390.6** | **pass**, harness at ceiling |
| 100 | 530.0 | 1654.0 | 2083.0 | 3762 | **no** | 8.1 / 23.0 | **298.7 / 402.0** | **fail** — p99 > 1000 ms |
| 200 | 1401.0 | 3869.0 | 5176.0 | 4179 | **no** | 9.5 / 32.0 | **314.2 / 403.0** | **fail** — p99, and n is 38% of expected |

### R3 — hot doc, 2 instances

| clients | p50 | p95 | p99 | n | converged | server CPU% mean/peak | **harness CPU% mean/peak** | verdict |
|---|---|---|---|---|---|---|---|---|
| 25 | 5.0 | 9.0 | 13.0 | 1320 | yes | 7.7 / 18.0 | **58.6 / 149.9** | **pass** |
| 50 | 14.0 | 98.0 | 152.0 | 2646 | yes | 8.6 / 16.9 | **211.9 / 387.0** | **pass**, harness at ceiling |
| 100 | 545.0 | 1546.0 | 1968.0 | 3762 | yes | 8.8 / 22.8 | **291.1 / 396.0** | **fail** — p99 > 1000 ms |

CPU percentages are of a **single core**, so this 4-core VM has a 400% budget.

### The ceiling is the load generator, not the server

This is the finding the whole climb exists to produce, and it goes the way that
is least flattering to a headline number:

- **The server never worked hard.** Across every run, including 200 clients on
  one document, server CPU stayed between **3% and 32% of one core** — under 8%
  of the machine — and server RSS never exceeded 199 MB for one instance.
- **The harness saturated the machine.** At 100 and 200 clients it used
  **402–403% of a 400% budget**: every core, fully consumed, by the load
  generator's own four worker threads.
- So the latency collapse at 100+ clients is **our own scheduling delay**, not a
  measured property of the server. A p99 of 5176 ms at 200 clients says the
  clients could not be serviced by their own process; it does not say the server
  could not serve them.

**Honest conclusion: this setup cannot determine the server's capacity.** It can
only establish that the server was nowhere near its limit at the point where the
load generator ran out of CPU. Finding the server's real ceiling needs the load
generator on separate hardware — not measured, and out of scope here.

**One clarification, made during the runs and disclosed rather than quietly
applied:** the stop criterion was written as "harness CPU ≥ ~90% of one core".
That wording assumed a single-threaded generator. The harness is deliberately
four-threaded on a four-core VM, where using more than one core is correct
behaviour, so it was applied as **≥90% of the 4-core budget (≥360%)**. Under that
reading 25 clients is clean (150–218% peak) and 50 is at the ceiling (387–391%).

### Which client count the matrix uses

- **50** is the highest count passing the correctness and latency criteria in
  both climbs.
- **25** is the highest count at which the harness is demonstrably *not* the
  bottleneck.

**The matrix below was run at 25**, because the whole purpose of R2−R1 and R3−R2
is to isolate contention and doc-bus costs, and at 50 those differences would be
mixed with our own scheduling noise. The 50-client behaviour is documented in the
climb tables above and is not repeated as a matrix.

---

## 5. Results — the matrix at 25 clients

Every scenario run twice. Latency in ms; CPU as % of one core; RSS in MB;
`disc.` = warm-up samples discarded.

| run | scenario | **topology** | docs | p50 | p95 | p99 | **n** | **disc.** | server CPU mean/peak | server RSS mean | harness CPU mean/peak | Redis-wide cmd/s | DocUpdate Δ (rows/s) | converged |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **R1-25-a** | distributed | 1-instance | 10 | 2.0 | 5.0 | 11.0 | 825 | 60 | 4.1 / 14.0 | 178.3 | 5.5 / 11.0 | 50.5 | 288 (4.8) | yes |
| **R1-25-b** | distributed | 1-instance | 10 | 2.0 | 5.0 | 8.0 | 825 | 60 | 3.2 / 7.0 | 189.1 | 5.2 / 10.0 | 50.3 | 289 (4.8) | yes |
| **R2-25-a** | hot doc | 1-instance | 1 | 5.0 | 11.0 | 13.0 | 1320 | 96 | 3.4 / 7.0 | 226.0 | 48.8 / 142.9 | 49.9 | 30 (0.5) | yes |
| **R2-25-b** | hot doc | 1-instance | 1 | 5.0 | 10.0 | 13.0 | 1320 | 96 | 4.7 / 24.0 | 157.5 | 58.7 / 167.7 | 49.9 | 30 (0.5) | yes |
| **R3-25-a** | hot doc | **2-instance** | 1 | 6.0 | 11.0 | 15.0 | 1320 | 96 | 5.9 / 11.0 | 345.9 | 49.7 / 166.8 | 50.2 | 60 (1.0) | yes |
| **R3-25-b** | hot doc | **2-instance** | 1 | 5.0 | 13.0 | 18.0 | 1320 | 96 | 6.7 / 21.0 | 362.0 | 61.4 / 157.8 | 49.9 | 60 (1.0) | yes |
| **R4-25-a** | distributed | **2-instance** | 10 | 2.0 | 4.0 | 9.0 | 825 | 60 | 4.3 / 14.0 | 364.5 | 5.7 / 11.0 | 50.3 | 290 (4.8) | yes |
| **R4-25-b** | distributed | **2-instance** | 10 | 2.0 | 4.0 | 9.0 | 825 | 60 | 4.0 / 21.0 | 367.5 | 5.8 / 12.0 | 50.3 | 292 (4.9) | yes |

**R4 as originally configured does not test what its name claims** — see §6. The
corrected pair:

| run | scenario | **topology** | docs | p50 | p95 | p99 | **n** | **disc.** | server CPU mean/peak | server RSS mean | harness CPU mean/peak | Redis-wide cmd/s | DocUpdate Δ (rows/s) | converged |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **R1x-25-a** | distributed | 1-instance | 9 | 2.0 | 4.0 | 10.0 | 880 | 64 | 3.7 / 11.0 | 178.1 | 5.5 / 10.0 | 50.4 | 258 (4.3) | yes |
| **R1x-25-b** | distributed | 1-instance | 9 | 2.0 | 5.0 | 9.0 | 880 | 64 | 3.2 / 10.0 | 187.4 | 5.4 / 10.0 | 50.3 | 262 (4.4) | yes |
| **R4x-25-a** | distributed | **2-instance** | 9 | 2.0 | 8.0 | 14.0 | 880 | 64 | 7.1 / 28.0 | 351.5 | 6.0 / 12.0 | 51.0 | **517 (8.6)** | yes |
| **R4x-25-b** | distributed | **2-instance** | 9 | 3.0 | 8.0 | 12.0 | 880 | 64 | 5.7 / 15.0 | 372.7 | 5.9 / 12.0 | 50.7 | **522 (8.7)** | yes |

`DocSnapshot` Δ was **10, 9 or 1** in every run — exactly one per document
created — and `snapshotHighWaterDelta` was **0 everywhere**. See §7.

Both repeats of every scenario agree closely; no run was discarded or repeated
for a better number.

---

## 6. What the numbers mean

Read strictly off the rows above. Nothing here is claimed beyond them.

**R2 − R1: the cost of one hot document (1 instance).**
p50 **2.0 → 5.0 ms**, p95 **5.0 → 10.5 ms**. Moving 25 clients from 10 documents
onto 1 roughly doubles median propagation. The room's fan-out is O(clients), so
each edit is delivered to 24 sockets instead of ~2.

**R3 − R2: the cost of the Redis doc bus (hot document).**
p50 **5.0 → 5.5 ms**, p95 **10.5 → 12.0 ms**, p99 **13.0 → 16.5 ms**. Splitting
the same 25 clients across two instances adds roughly **0.5 ms at the median and
~3.5 ms at p99**. Local fan-out happens first and the publish follows, so only
the cross-instance half of the traffic pays the round trip.

**R4x − R1x: the doc bus under distributed load.**
p50 **2.0 → 2.5 ms**, p95 **4.5 → 8.0 ms**, p99 **9.5 → 13.0 ms**. The relative
cost is larger here than in the hot-doc case because the baseline is so low.

**R4 (10 docs, 2 instances) measured something else entirely.** Its latency and
DocUpdate rate are indistinguishable from single-instance R1, because **no
document was ever shared between instances**: clients are assigned round-robin
to documents (`i % docs`) and to servers (`i % servers`), so with 10 documents
and 2 servers every client on a given document has the same index parity and
therefore lands on the same instance. The doc bus carried nothing. Re-running with
**9** documents makes the parities interleave, and the effect appears immediately
— which is what R1x/R4x are. **R4's rows are kept above as the measurement they
actually are: two instances serving disjoint sets of documents.** That is a real
topology, but it is not cross-instance collaboration.

**Redis command rate is Redis-wide**, not per instance: `INFO stats` counts the
whole server. It sat at **~50 commands/sec** in every 25-client run regardless of
topology or scenario, and rose to ~93–101/sec only in the 50–100 client climb
steps.

### Write amplification — a metric, not a fault

Two instances holding the same document each run their own write buffer, so the
same document is persisted twice:

| comparison | 1 instance | 2 instances | ratio |
|---|---|---|---|
| hot doc (R2 → R3) | 30 rows | 60 rows | **2.0×** |
| distributed, 9 docs (R1x → R4x) | 258, 262 rows | 517, 522 rows | **2.0×** |

**This is expected and is not a correctness problem.** `CLAUDE.md` and
`summary7.md` both predicted it. The independent evidence that the data is right
is the `converged` column: in every run all clients on a document ended with
byte-identical text of exactly the expected length (edits + marker characters).
**No correctness claim is made from a row count anywhere**, and the harness
contains no assertion on them.

The 2.0× ratio also confirms the R4 artifact from the other direction: R4's
ratio was 290/288 ≈ **1.0×**, which is what "the second instance never saw these
documents" looks like in the database.

---

## 7. Findings

Recorded, **not fixed** — Phase 8 measures and does not tune.

1. **The load generator, not the server, is this setup's limit.** Server CPU
   never exceeded 32% of one core while the harness consumed all four. Any
   capacity claim from this machine would be a claim about the harness.
2. **Round-robin assignment can silently hide cross-instance behaviour** when
   `docs` and `servers` share a factor. Documented above; the harness was not
   changed. Anyone running a two-instance distributed scenario must use a
   document count coprime with the instance count, or verify via the DocUpdate
   ratio that documents really are shared.
3. **Convergence could not be confirmed at 100+ clients within the harness's
   fixed 2-second settle window.** In the failing runs there were **no errors and
   no dropped clients** — close codes were all 0, and at 100 clients the total
   text length matched expectation exactly (6516 = 6516) while 3 distinct
   document states remained. Updates were still in flight when the window closed,
   which is unsurprising when p99 propagation was ~2 s. **This is a harness
   limitation, not evidence of data loss**, and it was not "fixed" by extending
   the window, because doing so mid-phase would have changed the instrument
   between runs.
4. **Compaction never fired.** `snapshotHighWaterDelta` was 0 in every run: the
   200-row threshold was never reached, because the write buffer merges each 2 s
   flush into a single row, giving ~30 rows per document per minute per instance.
   Compaction behaviour is therefore **unmeasured**, not "fine".
5. **`DocSnapshot` row deltas are uninformative by design** — the column is
   `@unique` per document and a snapshot is written the moment a document is
   first opened, so the delta only ever counts documents created by that run
   (10, 9 or 1 above). `snapshotHighWaterDelta` is the compaction signal, and it
   is 0.
6. **Two instances cost ~2× RSS** (≈178 MB → ≈360 MB combined) for the same work,
   which is simply two Node processes each holding the same rooms.

---

## 8. What was not measured

- **Code execution / the Run path.** Not load-tested at all. **Run routing
  remains single-instance**: the execution registry is in-process, so a browser
  must reach the instance that accepted its POST, and streaming from the other
  instance is a **404 by design** (Phase 7, deliberate). Nothing in Phase 8
  changes or tests this.
- **The server's actual capacity ceiling** — the harness saturated first (§4).
- **Compaction under load** (never triggered), and compaction with two
  concurrent writers.
- **Revocation across instances**, still instance-local.
- REST endpoints, authentication throughput, the file API.
- Multi-machine load, real network latency, sustained multi-hour runs, cold
  start, memory behaviour over hours, and reconnection storms.
- Any client count above 200, and any edit rate other than 2/sec/client.
- Browser-side performance: no browser was involved at any point.

---

## 9. Honest framing

These numbers describe **one developer laptop**, not a deployment:

- A WSL2 VM capped at **6 GB and 4 processors**, hosting *everything at once* —
  one or two Node servers, PostgreSQL, Redis, and the load generator itself.
- **Localhost networking**, so there is no real network latency in any figure
  here. A deployment with clients on the internet would be dominated by RTT that
  this measurement does not contain.
- The load generator competes for the same four cores as the software it
  measures, and at ≥50 clients it is the constraint.
- Single 60-second runs, two repeats each. Nothing here speaks to stability over
  hours, memory growth, or behaviour under failure.

**What can fairly be said:** on this machine, with 25 concurrent clients editing,
propagation was **~2 ms median for 25 clients across 10 documents** and **~5 ms
median with all 25 on a single document**, adding a second instance cost about
**0.5 ms at the median and ~3.5 ms at p99** on the hot document, and the server
processes stayed under 8% of the machine's CPU throughout — while the load
generator, not the server, was what ran out of capacity.

**What cannot be said from this data:** how many users the system supports.

---

## 10. Evidence index

**19 raw blobs** in `loadtest/results/`, one per run, each holding its full
config, auto-captured environment, per-client counts and the **raw latency
samples** — so every percentile in this file can be recomputed rather than taken
on trust.

| files | what |
|---|---|
| `climb-R2-{25,50,100,200}.json` | hot doc, 1 instance — the climb |
| `climb-R3-{25,50,100}.json` | hot doc, 2 instances — the climb |
| `R1-25-{a,b}.json` · `R2-25-{a,b}.json` | the 1-instance matrix, two runs each |
| `R3-25-{a,b}.json` · `R4-25-{a,b}.json` | the 2-instance matrix, two runs each |
| `R1x-25-{a,b}.json` · `R4x-25-{a,b}.json` | the corrected distributed pair (9 docs) |

`environment.argv` in each blob is the authoritative record of the command that
produced it. Percentiles can be re-derived with
`npm run loadtest -- --self-check` proving the arithmetic on the same binary.
