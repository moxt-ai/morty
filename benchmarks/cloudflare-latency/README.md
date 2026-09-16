# Cloudflare latency benchmark

This benchmark uses temporary Workers with the same placement and storage
bindings as the deployed regional Workers. It does not modify the live Mobius
Platform or Mobius Chat Workers.

It reports Worker-observed wall-clock latency for:

- Mobius Chat staging APAC and WNAM Workers to their staging D1 databases with
  `SELECT 1` and R2 buckets with `list({ limit: 1 })`.
- Mobius Chat staging APAC and WNAM Workers to production Mobius Platform at
  `https://mobius.moxt.ai/mobius/api/health`.
- Production Mobius Platform APAC and WNAM Workers to both production regional
  D1 project shards with `SELECT 1` and their production R2 object buckets with
  `list({ limit: 1 })`.

Each target receives five sequential warm-up requests followed by 100 measured
requests. The runner deploys token-protected probe Workers, prints one JSON
report, and deletes all probes in a `finally` block. A terminated process can
leave a probe behind; its generated name starts with `mobius-latency-` and it
continues to reject requests without the random token.

Run while authenticated to the Paraflow Cloud Cloudflare account:

```sh
pnpm bench:cloudflare-latency
```

Run only the staging Chat Worker to production Platform measurements with:

```sh
pnpm bench:chat-to-prod-mobius
```

These are operational observations, not deterministic tests or SLOs. D1 wall
time includes the Worker-to-D1 round trip; `sqlDurationMilliseconds` reports
D1's SQL execution time separately. R2 measures a metadata list and does not
transfer object contents. The Chat-to-Platform probe uses the public Platform
health boundary and does not include project routing, authentication, Durable
Objects, or application queries.

Timestamped observations are stored in [`results/`](./results/). Serving colo
metadata in a result is a separate read-only D1 observation made immediately
after that run; Cloudflare can move a database afterward.
