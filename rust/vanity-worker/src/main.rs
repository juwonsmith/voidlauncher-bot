use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use rusqlite::{params, Connection};
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
struct Mint {
    address: String,
    secret_key_base58: String,
}

#[derive(Debug, Clone)]
struct Config {
    database_path: String,
    prefix: String,
    suffix: String,
    pool_size: usize,
    workers: usize,
    stdout_mode: bool,
}

fn main() {
    dotenvy::dotenv().ok();

    let config = match read_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if config.prefix.is_empty() && config.suffix.is_empty() {
        eprintln!("PUMP_MINT_SUFFIX is empty. Set PUMP_MINT_SUFFIX=pump to fill a vanity pool.");
        std::process::exit(1);
    }

    if !config.stdout_mode {
        ensure_schema(&config.database_path).expect("failed to create vanity_mints table");
    }

    println!(
        "Vanity worker started: prefix={} suffix={} pool_size={} workers={} storage={}",
        config.prefix,
        config.suffix,
        config.pool_size,
        config.workers,
        if config.stdout_mode { "postgres bridge" } else { &config.database_path }
    );

    let attempts = Arc::new(AtomicU64::new(0));
    let (sender, receiver) = mpsc::channel::<Mint>();

    for _ in 0..config.workers {
        let sender = sender.clone();
        let prefix = config.prefix.clone();
        let suffix = config.suffix.clone();
        let attempts = Arc::clone(&attempts);

        thread::spawn(move || loop {
            let signing_key = SigningKey::generate(&mut OsRng);
            let verifying_key = signing_key.verifying_key();
            let address = bs58::encode(verifying_key.as_bytes()).into_string();
            attempts.fetch_add(1, Ordering::Relaxed);

            if address.starts_with(&prefix) && address.ends_with(&suffix) {
                let mut secret = [0u8; 64];
                secret[..32].copy_from_slice(&signing_key.to_bytes());
                secret[32..].copy_from_slice(verifying_key.as_bytes());

                let mint = Mint {
                    address,
                    secret_key_base58: bs58::encode(secret).into_string(),
                };

                if sender.send(mint).is_err() {
                    break;
                }
            }
        });
    }

    let mut last_attempts = 0;
    loop {
        if config.stdout_mode {
            match receiver.recv_timeout(Duration::from_secs(5)) {
                Ok(mint) => println!("VANITY_MINT\t{}\t{}", mint.address, mint.secret_key_base58),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let current_attempts = attempts.load(Ordering::Relaxed);
                    let delta = current_attempts.saturating_sub(last_attempts);
                    last_attempts = current_attempts;
                    println!("Searching... Attempts={} (+{})", current_attempts, delta);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            continue;
        }

        let available = count_available(&config.database_path, &config.suffix).unwrap_or(0);
        if available >= config.pool_size {
            let current_attempts = attempts.load(Ordering::Relaxed);
            let delta = current_attempts.saturating_sub(last_attempts);
            last_attempts = current_attempts;
            println!(
                "Pool full: {}/{} ready. Attempts={} (+{}). Sleeping...",
                available, config.pool_size, current_attempts, delta
            );
            thread::sleep(Duration::from_secs(15));
            continue;
        }

        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(mint) => {
                if let Err(error) = insert_mint(&config.database_path, &config.suffix, &mint) {
                    eprintln!("Failed to insert mint {}: {}", mint.address, error);
                } else {
                    let now_available = count_available(&config.database_path, &config.suffix).unwrap_or(0);
                    println!(
                        "Stored vanity mint {} ({}/{} ready)",
                        mint.address, now_available, config.pool_size
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let current_attempts = attempts.load(Ordering::Relaxed);
                let delta = current_attempts.saturating_sub(last_attempts);
                last_attempts = current_attempts;
                println!(
                    "Searching... {}/{} ready. Attempts={} (+{})",
                    available, config.pool_size, current_attempts, delta
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn read_config() -> Result<Config, String> {
    let database_path = env::var("DATABASE_PATH").unwrap_or_else(|_| "./data/bot.sqlite".to_string());
    let custom_order = env::var("VANITY_CUSTOM_ORDER")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let prefix = env::var("VANITY_MINT_PREFIX").unwrap_or_default();
    let suffix = if custom_order {
        // A custom CA order sets exactly the pattern it wants; never fall back to the pool suffix.
        env::var("VANITY_MINT_SUFFIX").unwrap_or_default()
    } else {
        env::var("VANITY_MINT_SUFFIX")
            .or_else(|_| env::var("PUMP_MINT_SUFFIX"))
            .unwrap_or_else(|_| "pump".to_string())
    };
    let pool_size = env::var("PUMP_MINT_POOL_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(3);
    let workers = env::var("PUMP_MINT_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4));
    let stdout_mode = env::var("VANITY_STDOUT_MODE")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    Ok(Config {
        database_path,
        prefix,
        suffix,
        pool_size,
        workers,
        stdout_mode,
    })
}

fn ensure_schema(database_path: &str) -> rusqlite::Result<()> {
    let connection = Connection::open(database_path)?;
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS vanity_mints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          suffix TEXT NOT NULL,
          address TEXT NOT NULL UNIQUE,
          secret_key_base58 TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'available',
          created_at TEXT NOT NULL,
          reserved_at TEXT,
          used_at TEXT,
          proposal_id INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_vanity_mints_status_suffix
          ON vanity_mints(status, suffix, id);
        "#,
    )
}

fn count_available(database_path: &str, suffix: &str) -> rusqlite::Result<usize> {
    let connection = Connection::open(database_path)?;
    connection.query_row(
        "SELECT COUNT(*) FROM vanity_mints WHERE status = 'available' AND suffix = ?",
        params![suffix],
        |row| row.get::<_, usize>(0),
    )
}

fn insert_mint(database_path: &str, suffix: &str, mint: &Mint) -> rusqlite::Result<usize> {
    let connection = Connection::open(database_path)?;
    connection.execute(
        r#"
        INSERT OR IGNORE INTO vanity_mints
          (suffix, address, secret_key_base58, status, created_at)
        VALUES (?, ?, ?, 'available', ?)
        "#,
        params![suffix, mint.address, mint.secret_key_base58, now_isoish()],
    )
}

fn now_isoish() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}
