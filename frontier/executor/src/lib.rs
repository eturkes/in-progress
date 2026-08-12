#![forbid(unsafe_code)]

use std::{
    error::Error,
    fmt::{self, Display, Formatter},
    fs::{self, OpenOptions},
    io,
    net::SocketAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::task::JoinError;
use tracing::error;
use uuid::Uuid;

pub const BODY_LIMIT_BYTES: usize = 16 * 1024;
pub const MAX_VALUE_BYTES: usize = 8 * 1024;
pub const DEFAULT_BIND: &str = "127.0.0.1:4319";

const APPLICATION_ID: i64 = 0x4950_4645; // "IPFE"
const SCHEMA_VERSION: i64 = 1;
const OPERATIONS_SCHEMA: &str = r#"CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_hash BLOB NOT NULL CHECK(length(request_hash) = 32),
  kind TEXT NOT NULL CHECK(kind = 'frontier-probe'),
  input_value TEXT NOT NULL,
  result_value TEXT NOT NULL,
  result_digest TEXT NOT NULL CHECK(length(result_digest) = 64),
  completed_at_ms INTEGER NOT NULL
) STRICT"#;

struct PreparedLedger {
    initialize: bool,
    path: PathBuf,
}

#[derive(Clone)]
pub struct Executor {
    state: AppState,
}

#[derive(Clone)]
struct AppState {
    ledger: Ledger,
}

#[derive(Clone)]
struct Ledger {
    connection: Arc<Mutex<Connection>>,
    crash_hook: CrashHook,
}

type CrashHook = Arc<dyn Fn(CrashPoint) + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CrashPoint {
    BeforeCommit,
    AfterCommit,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OperationRequest {
    operation_id: Uuid,
    kind: OperationKind,
    input: ProbeInput,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
enum OperationKind {
    #[serde(rename = "frontier-probe")]
    FrontierProbe,
}

impl OperationKind {
    const fn wire_name(self) -> &'static str {
        match self {
            Self::FrontierProbe => "frontier-probe",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeInput {
    value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResponse {
    operation_id: Uuid,
    value: String,
    digest: String,
    replayed: bool,
}

enum ApplyOutcome {
    Completed {
        value: String,
        digest: String,
        replayed: bool,
    },
    Conflict,
}

#[derive(Debug)]
pub enum ExecutorError {
    InvalidBind(SocketAddr),
    InvalidLedgerPath(String),
    Io(io::Error),
    Sqlite(rusqlite::Error),
    Clock,
    LedgerLock,
}

impl Display for ExecutorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBind(address) => {
                write!(formatter, "bind address must be loopback: {address}")
            }
            Self::InvalidLedgerPath(detail) => write!(formatter, "invalid ledger path: {detail}"),
            Self::Io(error) => write!(formatter, "ledger filesystem error: {error}"),
            Self::Sqlite(error) => write!(formatter, "ledger database error: {error}"),
            Self::Clock => formatter.write_str("system clock precedes Unix epoch"),
            Self::LedgerLock => formatter.write_str("ledger lock is poisoned"),
        }
    }
}

impl Error for ExecutorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ExecutorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for ExecutorError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl Executor {
    pub fn open(ledger_path: impl AsRef<Path>) -> Result<Self, ExecutorError> {
        Self::open_with_hook(ledger_path.as_ref(), Arc::new(|_| {}))
    }

    fn open_with_hook(path: &Path, crash_hook: CrashHook) -> Result<Self, ExecutorError> {
        let prepared = prepare_ledger_path(path)?;
        let mut connection = Connection::open(prepared.path)?;
        if prepared.initialize {
            initialize_schema(&mut connection)?;
        } else {
            validate_schema(&connection)?;
        }
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
        )?;
        Ok(Self {
            state: AppState {
                ledger: Ledger {
                    connection: Arc::new(Mutex::new(connection)),
                    crash_hook,
                },
            },
        })
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/healthz", get(|| async { StatusCode::NO_CONTENT }))
            .route("/v1/operations", post(apply_operation))
            .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
            .with_state(self.state.clone())
    }
}

fn initialize_schema(connection: &mut Connection) -> Result<(), ExecutorError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(OPERATIONS_SCHEMA)?;
    transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    validate_schema(connection)
}

fn validate_schema(connection: &Connection) -> Result<(), ExecutorError> {
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(ExecutorError::InvalidLedgerPath(
            "database is not an owned frontier executor ledger".to_owned(),
        ));
    }
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if user_version != SCHEMA_VERSION {
        return Err(ExecutorError::InvalidLedgerPath(format!(
            "unsupported schema version {user_version}"
        )));
    }
    let stored_schema = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operations'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if stored_schema.as_deref() != Some(OPERATIONS_SCHEMA) {
        return Err(ExecutorError::InvalidLedgerPath(
            "operations schema does not match version 1".to_owned(),
        ));
    }
    Ok(())
}

pub fn validate_bind(address: SocketAddr) -> Result<SocketAddr, ExecutorError> {
    if address.ip().is_loopback() {
        Ok(address)
    } else {
        Err(ExecutorError::InvalidBind(address))
    }
}

async fn apply_operation(
    State(state): State<AppState>,
    payload: Result<Json<OperationRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationResponse>), ApiError> {
    let Json(request) = payload.map_err(ApiError::Json)?;
    if request.input.value.len() > MAX_VALUE_BYTES {
        return Err(ApiError::InvalidRequest);
    }
    let operation_id = request.operation_id;
    let ledger = state.ledger;
    let outcome = tokio::task::spawn_blocking(move || ledger.apply(&request))
        .await
        .map_err(ApiError::Join)?
        .map_err(ApiError::Internal)?;
    match outcome {
        ApplyOutcome::Completed {
            value,
            digest,
            replayed,
        } => {
            let status = if replayed {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            };
            Ok((
                status,
                Json(OperationResponse {
                    operation_id,
                    value,
                    digest,
                    replayed,
                }),
            ))
        }
        ApplyOutcome::Conflict => Err(ApiError::Conflict),
    }
}

impl Ledger {
    fn apply(&self, request: &OperationRequest) -> Result<ApplyOutcome, ExecutorError> {
        let request_hash = canonical_request_hash(request);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ExecutorError::LedgerLock)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation_id = request.operation_id.to_string();
        let stored = transaction
            .query_row(
                "SELECT request_hash, result_value, result_digest FROM operations WHERE operation_id = ?1",
                [&operation_id],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_hash, value, digest)) = stored {
            return if stored_hash == request_hash {
                Ok(ApplyOutcome::Completed {
                    value,
                    digest,
                    replayed: true,
                })
            } else {
                Ok(ApplyOutcome::Conflict)
            };
        }

        let completed_at_ms = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| ExecutorError::Clock)?
                .as_millis(),
        )
        .map_err(|_| ExecutorError::Clock)?;
        let value = request.input.value.clone();
        let digest = result_digest(&value);
        transaction.execute(
            "INSERT INTO operations(operation_id, request_hash, kind, input_value, result_value, result_digest, completed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                operation_id,
                request_hash.as_slice(),
                request.kind.wire_name(),
                request.input.value,
                value,
                digest,
                completed_at_ms
            ],
        )?;
        (self.crash_hook)(CrashPoint::BeforeCommit);
        transaction.commit()?;
        (self.crash_hook)(CrashPoint::AfterCommit);
        Ok(ApplyOutcome::Completed {
            value,
            digest,
            replayed: false,
        })
    }
}

fn canonical_request_hash(request: &OperationRequest) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"frontier-operation/v1\0");
    hash.update(request.operation_id.as_bytes());
    hash.update(request.kind.wire_name().as_bytes());
    let value = request.input.value.as_bytes();
    hash.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hash.update(value);
    hash.finalize().into()
}

fn result_digest(value: &str) -> String {
    let digest: [u8; 32] = Sha256::digest(value.as_bytes()).into();
    hex_digest(&digest)
}

fn hex_digest(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn prepare_ledger_path(path: &Path) -> Result<PreparedLedger, ExecutorError> {
    let file_name = path.file_name().ok_or_else(|| {
        ExecutorError::InvalidLedgerPath("path must name a database file".to_owned())
    })?;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| {
            ExecutorError::InvalidLedgerPath(
                "path must include an explicit parent directory".to_owned(),
            )
        })?;

    if parent.exists() {
        assert_private_directory(parent)?;
    } else {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        assert_private_directory(parent)?;
    }
    let parent = fs::canonicalize(parent)?;
    let canonical_path = parent.join(file_name);
    let initialize = match fs::symlink_metadata(&canonical_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(ExecutorError::InvalidLedgerPath(
                    "database must be a regular non-symlink file".to_owned(),
                ));
            }
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(ExecutorError::InvalidLedgerPath(
                    "database permissions grant group/other access".to_owned(),
                ));
            }
            metadata.len() == 0
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&canonical_path)?;
            true
        }
        Err(error) => return Err(error.into()),
    };
    Ok(PreparedLedger {
        initialize,
        path: canonical_path,
    })
}

fn assert_private_directory(path: &Path) -> Result<(), ExecutorError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ExecutorError::InvalidLedgerPath(
            "database parent must be a non-symlink directory".to_owned(),
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(ExecutorError::InvalidLedgerPath(
            "database parent permissions grant group/other access".to_owned(),
        ));
    }
    Ok(())
}

enum ApiError {
    Json(JsonRejection),
    InvalidRequest,
    Conflict,
    Internal(ExecutorError),
    Join(JoinError),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Json(rejection) => {
                let status = rejection.status();
                (
                    status,
                    Json(ErrorBody {
                        error: "invalid_request",
                    }),
                )
                    .into_response()
            }
            Self::InvalidRequest => (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: "invalid_request",
                }),
            )
                .into_response(),
            Self::Conflict => (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "operation_id_conflict",
                }),
            )
                .into_response(),
            Self::Internal(error) => {
                error!(%error, "operation ledger failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorBody {
                        error: "internal_error",
                    }),
                )
                    .into_response()
            }
            Self::Join(error) => {
                error!(%error, "operation worker failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorBody {
                        error: "internal_error",
                    }),
                )
                    .into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests;
