fn main() -> Result<(), Box<dyn std::error::Error>> {
    let test_manifest = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var_os("CARGO_FEATURE_WINDOWS_TEST_MANIFEST").is_some();

    if test_manifest {
        // Unit-test harnesses do not receive Tauri's binary resource manifest.
        let out_dir = std::env::var_os("OUT_DIR").ok_or_else(|| std::io::Error::other("OUT_DIR is not set"))?;
        let manifest = std::path::PathBuf::from(out_dir).join("windows-test-manifest.xml");
        std::fs::write(
            &manifest,
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
  </dependentAssembly></dependency>
</assembly>"#,
        )?;

        // Keep Tauri's code generation, icons and version resources, while
        // letting the linker embed the only manifest in this test build.
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )?;
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        tauri_build::build();
    }
    Ok(())
}
