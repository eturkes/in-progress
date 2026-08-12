# frontier executor

Loopback-only, idempotent native-effect boundary. `POST /v1/operations` accepts exactly:

```json
{
  "operationId": "00000000-0000-0000-0000-000000000000",
  "kind": "frontier-probe",
  "input": { "value": "probe" }
}
```

The 16 KiB serialized-body cap, 8 KiB UTF-8 value cap, and `deny_unknown_fields` apply before execution. A versioned SHA-256 canonical request hash binds each UUID to its semantic body. One SQLite `IMMEDIATE` transaction inserts the probe effect plus immutable `{operationId,value,digest}` receipt in one row; `digest = SHA-256(UTF-8(value))`. `replayed` is response metadata, not stored receipt content. Same UUID + same request returns that row with `replayed:true`; same UUID + different request returns `409`.

The database is fail-closed: an application ID, exact schema version, and exact schema definition must match before WAL or request handling is enabled. An unrelated or malformed SQLite file is rejected without being claimed.

```sh
cargo run --locked -- \
  --ledger /private/mode-0700-parent/frontier.sqlite3 \
  --bind 127.0.0.1:4319
```

`--ledger` or `FRONTIER_EXECUTOR_LEDGER` is required. Existing ledger parent and file must deny group/other access; new direct parents/files are `0700`/`0600`. Bind addresses must be IP loopback. Crash injection exists only inside the test module: subprocess tests abort before/after commit, reopen the same database, then prove rollback/replay and one effect row.

Gate:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```
