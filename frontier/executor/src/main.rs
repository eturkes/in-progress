#![forbid(unsafe_code)]

use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;
use frontier_executor::{DEFAULT_BIND, Executor, validate_bind};
use tokio::net::TcpListener;
use tracing::info;

#[derive(Debug, Parser)]
#[command(
    name = "frontier-executor",
    version,
    about = "Idempotent loopback effect executor"
)]
struct Args {
    #[arg(long, env = "FRONTIER_EXECUTOR_LEDGER", value_name = "PATH")]
    ledger: PathBuf,

    #[arg(long, env = "FRONTIER_EXECUTOR_BIND", default_value = DEFAULT_BIND)]
    bind: SocketAddr,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_target(false).init();
    let args = Args::parse();
    let bind = validate_bind(args.bind)?;
    let executor = Executor::open(args.ledger)?;
    let listener = TcpListener::bind(bind).await?;
    info!(address = %listener.local_addr()?, "frontier executor listening");
    axum::serve(listener, executor.router())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}
