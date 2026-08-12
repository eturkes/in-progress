use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use axum::{Router, body::Body, http::Request};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use super::*;

fn private_temp() -> TempDir {
    let directory = tempfile::tempdir().expect("create private test directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure test directory");
    directory
}

fn ledger_path(directory: &TempDir) -> PathBuf {
    directory.path().join("ledger.sqlite3")
}

fn request_json(operation_id: Uuid, value: &str) -> String {
    json!({
        "operationId": operation_id,
        "kind": "frontier-probe",
        "input": { "value": value }
    })
    .to_string()
}

async fn call(app: Router, body: impl Into<Body>) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::post("/v1/operations")
                .header("content-type", "application/json")
                .body(body.into())
                .expect("request"),
        )
        .await
        .expect("router response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    let body = serde_json::from_slice(&bytes).expect("JSON response");
    (status, body)
}

fn effect_count(path: &Path) -> i64 {
    Connection::open(path)
        .expect("open ledger for assertion")
        .query_row("SELECT count(*) FROM operations", [], |row| row.get(0))
        .expect("count effects")
}

#[test]
fn result_digest_is_sha256_of_utf8_bytes() {
    assert_eq!(
        result_digest("界\n"),
        "174b4c1869b668204e1fe9b948c3946954b2e7d2f32585faab5d8e9188f5334c"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_duplicates_commit_one_effect_and_replay_one_result() {
    let directory = private_temp();
    let path = ledger_path(&directory);
    let first_app = Executor::open(&path).expect("open first executor").router();
    let second_app = Executor::open(&path)
        .expect("open second executor")
        .router();
    let id = Uuid::new_v4();
    let body = request_json(id, "concurrent");
    let mut tasks = Vec::new();
    for index in 0..24 {
        let app = if index % 2 == 0 {
            first_app.clone()
        } else {
            second_app.clone()
        };
        let body = body.clone();
        tasks.push(tokio::spawn(async move { call(app, body).await }));
    }

    let mut created = 0;
    let mut replayed = 0;
    for task in tasks {
        let (status, response) = task.await.expect("request task");
        match status {
            StatusCode::CREATED => created += 1,
            StatusCode::OK => replayed += 1,
            other => panic!("unexpected duplicate status: {other}"),
        }
        assert_eq!(response["operationId"], id.to_string());
        assert_eq!(response["value"], "concurrent");
        assert_eq!(response["digest"].as_str().expect("digest").len(), 64);
    }
    assert_eq!(created, 1);
    assert_eq!(replayed, 23);
    assert_eq!(effect_count(&path), 1);
}

#[tokio::test]
async fn identical_request_replays_and_id_body_mismatch_conflicts() {
    let directory = private_temp();
    let path = ledger_path(&directory);
    let app = Executor::open(&path).expect("open executor").router();
    let id = Uuid::new_v4();

    let (first_status, first) = call(app.clone(), request_json(id, "first")).await;
    let semantically_identical = format!(
        "{{\"input\":{{\"value\":\"first\"}},\"kind\":\"frontier-probe\",\"operationId\":\"{id}\"}}"
    );
    let (replay_status, replay) = call(app.clone(), semantically_identical).await;
    let (conflict_status, conflict) = call(app, request_json(id, "different")).await;

    assert_eq!(first_status, StatusCode::CREATED);
    assert_eq!(first["replayed"], false);
    assert_eq!(
        first["digest"],
        "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"
    );
    assert_eq!(replay_status, StatusCode::OK);
    assert_eq!(replay["replayed"], true);
    assert_eq!(first["value"], replay["value"]);
    assert_eq!(first["digest"], replay["digest"]);
    assert_eq!(conflict_status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"], "operation_id_conflict");
    assert_eq!(effect_count(&path), 1);
}

#[tokio::test]
async fn strict_json_and_body_limit_fail_closed() {
    let directory = private_temp();
    let path = ledger_path(&directory);
    let app = Executor::open(&path).expect("open executor").router();
    let id = Uuid::new_v4();
    let cases = [
        "{".to_owned(),
        json!({
            "operationId": id,
            "kind": "frontier-probe",
            "input": { "value": "x" },
            "extra": true
        })
        .to_string(),
        json!({
            "operationId": id,
            "kind": "frontier-probe",
            "input": { "value": "x", "extra": true }
        })
        .to_string(),
        json!({
            "operationId": "not-a-uuid",
            "kind": "frontier-probe",
            "input": { "value": "x" }
        })
        .to_string(),
        json!({
            "operationId": id,
            "kind": "arbitrary-command",
            "input": { "value": "x" }
        })
        .to_string(),
    ];
    for body in cases {
        let (status, response) = call(app.clone(), body).await;
        assert!(status.is_client_error(), "status={status}, body={response}");
        assert_ne!(status, StatusCode::CONFLICT);
    }

    let semantically_oversized = request_json(id, &"x".repeat(MAX_VALUE_BYTES + 1));
    assert!(semantically_oversized.len() < BODY_LIMIT_BYTES);
    let (status, response) = call(app.clone(), semantically_oversized).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body={response}");
    assert_eq!(response["error"], "invalid_request");

    let oversized = request_json(id, &"x".repeat(BODY_LIMIT_BYTES));
    assert!(oversized.len() > BODY_LIMIT_BYTES);
    let (status, response) = call(app, oversized).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "body={response}");
    assert_eq!(effect_count(&path), 0);
}

#[test]
fn ledger_and_bind_reject_ambient_authority() {
    let directory = private_temp();
    let created_parent = directory.path().join("created-private");
    let created_ledger = created_parent.join("ledger.sqlite3");
    Executor::open(&created_ledger).expect("create mode-safe ledger");
    assert_eq!(
        fs::metadata(&created_parent)
            .expect("created parent metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&created_ledger)
            .expect("created ledger metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let insecure = directory.path().join("insecure");
    fs::create_dir(&insecure).expect("create insecure directory");
    fs::set_permissions(&insecure, fs::Permissions::from_mode(0o755)).expect("set insecure mode");
    let error = Executor::open(insecure.join("ledger.sqlite3"))
        .err()
        .expect("insecure parent rejected");
    assert!(error.to_string().contains("parent permissions"));

    let target = directory.path().join("target");
    fs::create_dir(&target).expect("create target");
    let link = directory.path().join("link");
    symlink(&target, &link).expect("create parent symlink");
    let error = Executor::open(link.join("ledger.sqlite3"))
        .err()
        .expect("symlink parent rejected");
    assert!(error.to_string().contains("non-symlink directory"));

    let public: SocketAddr = "0.0.0.0:4319".parse().expect("public socket");
    assert!(matches!(
        validate_bind(public),
        Err(ExecutorError::InvalidBind(_))
    ));
    let loopback: SocketAddr = "127.0.0.1:4319".parse().expect("loopback socket");
    assert_eq!(
        validate_bind(loopback).expect("loopback accepted"),
        loopback
    );
}

#[test]
fn ledger_rejects_unowned_or_malformed_sqlite_without_claiming_it() {
    let directory = private_temp();
    let unrelated = directory.path().join("unrelated.sqlite3");
    let connection = Connection::open(&unrelated).expect("create unrelated database");
    connection
        .execute_batch("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('kept');")
        .expect("populate unrelated database");
    drop(connection);
    fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o600))
        .expect("secure unrelated database");

    let error = Executor::open(&unrelated)
        .err()
        .expect("unowned database rejected");
    assert!(error.to_string().contains("not an owned frontier"));
    let connection = Connection::open(&unrelated).expect("reopen unrelated database");
    assert_eq!(
        connection
            .query_row("SELECT value FROM unrelated", [], |row| row
                .get::<_, String>(0))
            .expect("unrelated content retained"),
        "kept"
    );
    assert_eq!(
        connection
            .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
            .expect("application ID"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'operations'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("operations table absence"),
        0
    );

    let counterfeit = directory.path().join("counterfeit.sqlite3");
    let connection = Connection::open(&counterfeit).expect("create counterfeit database");
    connection
        .execute_batch(&format!(
            "CREATE TABLE operations(operation_id TEXT); PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {SCHEMA_VERSION};"
        ))
        .expect("mark counterfeit database");
    drop(connection);
    fs::set_permissions(&counterfeit, fs::Permissions::from_mode(0o600))
        .expect("secure counterfeit database");
    let error = Executor::open(&counterfeit)
        .err()
        .expect("malformed owned database rejected");
    assert!(error.to_string().contains("schema does not match"));
}

#[test]
fn crash_before_commit_rolls_back_then_restart_creates_once() {
    crash_recovery_case(CrashPoint::BeforeCommit, StatusCode::CREATED, false);
}

#[test]
fn crash_after_commit_restarts_as_replay_without_second_effect() {
    crash_recovery_case(CrashPoint::AfterCommit, StatusCode::OK, true);
}

fn crash_recovery_case(point: CrashPoint, expected_status: StatusCode, expected_replay: bool) {
    let directory = private_temp();
    let path = ledger_path(&directory);
    let id = Uuid::new_v4();
    let body = request_json(id, "crash-recovery");
    let (mut child, address) = spawn_crash_helper(&path, point, directory.path());
    send_request_ignoring_crash(address, &body);
    wait_for_crash(&mut child, point, directory.path());

    let runtime = tokio::runtime::Runtime::new().expect("restart runtime");
    let (status, response) = runtime.block_on(async {
        let app = Executor::open(&path)
            .expect("reopen crashed ledger")
            .router();
        call(app, body).await
    });
    assert_eq!(status, expected_status);
    assert_eq!(response["replayed"], expected_replay);
    assert_eq!(response["value"], "crash-recovery");
    assert_eq!(response["digest"].as_str().expect("digest").len(), 64);
    assert_eq!(effect_count(&path), 1);
}

#[allow(clippy::zombie_processes)] // Ownership returns to crash_recovery_case, which always reaps.
fn spawn_crash_helper(path: &Path, point: CrashPoint, scratch: &Path) -> (Child, SocketAddr) {
    let ready = scratch.join(format!("ready-{point:?}"));
    let mut child = Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--ignored",
            "--exact",
            "tests::crash_server_helper",
            "--nocapture",
        ])
        .env("FRONTIER_EXECUTOR_TEST_LEDGER", path)
        .env("FRONTIER_EXECUTOR_TEST_READY", &ready)
        .env("FRONTIER_EXECUTOR_TEST_CRASH", format!("{point:?}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn crash helper");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(value) = fs::read_to_string(&ready) {
            return (child, value.trim().parse().expect("helper address"));
        }
        if let Some(status) = child.try_wait().expect("poll helper") {
            panic!("crash helper exited before ready: {status}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    panic!("crash helper did not become ready");
}

fn send_request_ignoring_crash(address: SocketAddr, body: &str) {
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(3)).expect("connect crash helper");
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("read timeout");
    write!(
        stream,
        "POST /v1/operations HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("send crashing request");
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
}

fn wait_for_crash(child: &mut Child, point: CrashPoint, scratch: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll crashed helper") {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                status.signal(),
                Some(6),
                "crash helper did not receive SIGABRT"
            );
            assert_eq!(
                fs::read_to_string(scratch.join(format!("crashed-{point:?}")))
                    .expect("crash marker"),
                "armed"
            );
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    panic!("crash helper remained alive");
}

#[test]
#[ignore = "subprocess-only crash helper"]
fn crash_server_helper() {
    let path = PathBuf::from(
        std::env::var_os("FRONTIER_EXECUTOR_TEST_LEDGER").expect("helper ledger path"),
    );
    let ready =
        PathBuf::from(std::env::var_os("FRONTIER_EXECUTOR_TEST_READY").expect("helper ready path"));
    let point = match std::env::var("FRONTIER_EXECUTOR_TEST_CRASH").as_deref() {
        Ok("BeforeCommit") => CrashPoint::BeforeCommit,
        Ok("AfterCommit") => CrashPoint::AfterCommit,
        other => panic!("invalid helper crash point: {other:?}"),
    };
    let crash_marker = ready.with_file_name(format!("crashed-{point:?}"));
    let hook: CrashHook = Arc::new(move |observed| {
        if observed == point {
            fs::write(&crash_marker, "armed").expect("publish crash marker");
            std::process::abort();
        }
    });
    let runtime = tokio::runtime::Runtime::new().expect("helper runtime");
    runtime.block_on(async {
        let executor = Executor::open_with_hook(&path, hook).expect("helper executor");
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("helper listener");
        fs::write(
            &ready,
            listener.local_addr().expect("helper address").to_string(),
        )
        .expect("publish helper address");
        axum::serve(listener, executor.router())
            .await
            .expect("helper server");
    });
}
