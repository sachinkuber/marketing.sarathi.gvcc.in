# Load test (spec 17, test 41)

`tools/load/run.mjs` drives test 41, "load and impact on n8n". It needs Node 24 and nothing else from npm. For
the container figures it also needs the Docker CLI. It prints figures, statuses and error names only. It never
prints a credential or a test user's address.

```sh
LOAD_USERS_FILE=/root/load-users.json \
N8N_API_URL=https://n8n.example N8N_API_KEY=... \
node tools/load/run.mjs --origin https://marketing.sarathi.gvcc.in --connect http://127.0.0.1:4100 \
  --minutes 30 --jobs 300 --users 10 --probe-every 10 --project mkt \
  --results docs/acceptance/<date>-test-41.md
```

The exit code is 0 when no criterion failed, 1 when one did, and 2 when the run could not be made.

## Before the run

- **The worker uses the stand-in model, with a 2 s answer.** In the worker's env file, set `NODE_ENV=test`,
  `MODEL_BACKEND=standin` and `STANDIN_DELAY_MS=2000`, then recreate the worker. The worker refuses the
  stand-in unless `NODE_ENV=test`. It reads `STANDIN_DELAY_MS` only with the stand-in: whole milliseconds,
  from 0 to 60000, default 0. Afterwards, put the worker back on `anthropic` and recreate it.
- **Two test users, one per brand.** Only the platform owner can start a summary run (the `see_other_brands`
  permission, plan M5 decision 5). Every platform owner must have a second factor (SEC-1). So each test user
  is a platform owner with an authenticator secret. On a new installation, `bootstrap.ts` with a test address
  creates one, and it is enrolled at its first sign-in. Remove the test users after the test.
  Credentials come from a file that only its owner can read:

  ```json
  {
    "users": [
      { "email": "...", "password": "...", "totpSecret": "BASE32...", "brand": "aztek-global" },
      { "email": "...", "password": "...", "totpSecret": "BASE32...", "brand": "test-brand" }
    ]
  }
  ```

  The file is named by `LOAD_USERS_FILE`. It must be mode 0600 and belong to the user running the tool.
  Instead of the file, the tool also reads `LOAD_USER_1_EMAIL`, `_PASSWORD`, `_TOTP` and `_BRAND`, and the
  same for `LOAD_USER_2_`. Credentials are never taken from the command line. `brand` is a slug or an id.

- **n8n (optional).** Set `N8N_API_URL` (the n8n origin) and `N8N_API_KEY`, and `N8N_CANARY_WORKFLOW_ID`
  if you have it. Without the id, the tool looks up `Marketing — canary` by name. The tool only lists
  workflows and executions. Without n8n settings, the two n8n criteria are reported "not measured".
- **Quiet hour, no `ops`.** The one-shot `ops`, `backup` and `offsite` services must not run during the test.
  They are also left out of the container figures.

## What it does

| Part              | How                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in           | Email and password, then the authenticator code (`/api/auth/two-factor/verify-totp`). The code is computed with `packages/test-support`'s `totp`. A session that ends mid-run is signed in again.                                                                            |
| Jobs              | `--jobs` summary runs (`POST /api/v1/brands/:id/agents/summary/runs`), sent evenly over the window, alternating the two brands. The first is sent at the start of the window.                                                                                                |
| Probes            | One summary run every `--probe-every` seconds, alternating brands. The first is sent half a gap after the start.                                                                                                                                                             |
| Dashboard users   | `--users` users. Each sends one GET a second on a fixed beat, cycling through the brand's home, status and runs, the brand list and the session.                                                                                                                             |
| Container figures | Every 5 s, `docker stats --no-stream` on this project's running containers, chosen by the `com.docker.compose.project` label (no other project is sampled). Restart counts, states and the out-of-memory flag are read before and after, and `docker events` for the window. |
| Server figures    | `/proc/stat` (processor) and `/proc/vmstat` (`pswpin`, `pswpout`) at the start and the end of the window. These files show the whole host, even from inside a container.                                                                                                     |
| After the window  | It waits up to `--grace` seconds for the last runs to end, using the brands' run lists. Then it reads each run's detail and the dead-letter list of each brand. Each run-detail read writes an owner-read audit entry. That is expected.                                     |
| n8n               | It waits 65 s, so that the last canary run is recorded. Then it lists the executions back to an hour before the window.                                                                                                                                                      |

## How each criterion is judged

| Criterion (spec 17)                                       | Measured as                                                                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload: 2 brands, 300 jobs, 10 users, a probe each 10 s | The arguments and the jobs actually sent. The stand-in's 2 s answer is checked as the median model-call time in the run details (1.9 s to 3 s).                                                                      |
| Duration 30 minutes                                       | The window length.                                                                                                                                                                                                   |
| Product limits: 2 cores, 4 GB                             | The peak, across samples, of the summed `docker stats` processor figure (100 % = one core) and memory figure. The limit is 4 GiB, the sum of the compose limits.                                                     |
| No restart or stop for lack of memory                     | No container replaced, no change in restart count, every container still running, no out-of-memory flag, and no `oom`, `die`, `kill`, `stop` or `restart` event in the window.                                       |
| Server: average processor below 80 %, no swapping         | The busy share of `/proc/stat` over the window, and zero pages swapped in or out. The load generator's own processor use is included when it runs on the same host.                                                  |
| Core API: p95 < 500 ms, p99 < 1.5 s                       | Every request the tool sent in the window (dashboard GETs and run starts), timed by the client, nearest-rank percentiles. Any failed request (not 200 or 201, a timeout of 10 s, or a network error) fails the row.  |
| Queue, interactive: 95 % of probes claimed within 1 s     | For each probe's summary job, the time from the job's creation (same transaction as the queue send) to its first attempt (the claim). Both times come from the server's clock.                                       |
| Queue, production: claimed within 5 s of a free slot      | The tool cannot see the slots. So a job's wait is counted from the later of two moments: its creation, or the last end of another job of the same brand before its claim. The plain wait from creation is shown too. |
| All jobs finish inside the test                           | The run succeeded, and its end time is no later than the end of the window. The count by the end of the grace period is shown too.                                                                                   |
| No job in the dead-letter list                            | `GET /api/v1/brands/:id/jobs/dead` is empty for both brands.                                                                                                                                                         |
| n8n canary no more than 20 % slower                       | The mean duration of successful canary runs in the window, against their mean over the hour before. The longest run is shown too.                                                                                    |
| No n8n execution fails                                    | No execution of any workflow, started in the window, has the state `error`, `crashed` or `failed`.                                                                                                                   |

## Deviations from the letter of spec 17

- **Job class.** Spec 17 says "production jobs". The only way to start the trivial agent over HTTP is a
  summary run, and a summary run is an interactive-class job (its check job is interactive too). The 300 jobs
  and the probes therefore share the interactive class. The tool keeps them apart by run.
- **Slot wait.** The "free slot" moment is an estimate, described above.

## Results

The tool always prints a Markdown table, one row per criterion, with PASS, FAIL or "not measured". With
`--results`, it also writes the table to that file, for `docs/acceptance/`. A run with a smaller workload or
a shorter window than spec 17 is marked "not test 41" in the file.
