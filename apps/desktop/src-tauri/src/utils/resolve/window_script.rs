pub fn build_window_initial_script(workrun_settings: &str, resolved_theme: &str) -> String {
    let script = r##"
      if (sessionStorage.getItem('__WORKRUN_INITIAL__') === null) {
          sessionStorage.setItem('__WORKRUN_INITIAL__', 'no');
      }
    "##;

    format!(
        r##"
        window.__WORKRUN_PLATFORM__ = "tauri";
        if (document.documentElement) {{
            document.documentElement.dataset.platform = "tauri";
        }} else {{
            document.addEventListener('DOMContentLoaded', () => {{
                document.documentElement.dataset.platform = "tauri";
            }}, {{ once: true }});
        }}
        window.__WORKRUN_INITIAL_SETTINGS__ = {workrun_settings};
        window.__WORKRUN_INITIAL_THEME__ = "{resolved_theme}";
        {script}
        "##,
        workrun_settings = workrun_settings,
        resolved_theme = resolved_theme,
        script = script
    )
}
