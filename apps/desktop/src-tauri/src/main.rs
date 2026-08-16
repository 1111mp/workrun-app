// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // reqwest 0.13 uses rustls without selecting a default provider when both
    // aws-lc-rs and ring are enabled in the dependency graph.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    #[cfg(feature = "tokio-trace")]
    console_subscriber::init();

    workrun_lib::run()
}
