#[allow(unused_imports)]
use crate::{
    config::Config,
    core::handle,
    feat, logging, logging_error,
    process::AsyncHandler,
    singleton,
    utils::{i18n, logging::Type, resolve, window_manager::WindowManager},
};
use anyhow::Result;
#[allow(unused_imports)]
use tauri::{
    AppHandle, Manager as _, Wry,
    image::Image,
    menu::{AboutMetadataBuilder, IsMenuItem, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

pub const TRAY_ID: &str = "workrun-tray";
pub const TRAY_MENU_ID: &str = "workrun-tray-menu";

#[derive(Default)]
pub struct Tray;

singleton!(Tray, TRAY);

impl Tray {
    #[allow(clippy::default_constructed_unit_structs)]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn init(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(
                debug,
                Type::Setup,
                "The application is exiting, skipping tray initialization."
            );
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();
        match self.create_tray_from_handle(app_handle).await {
            Ok(_) => {
                logging!(info, Type::Tray, "Tray initialized successfully");
            },
            Err(e) => {
                // Don't return error, let application continue running without tray
                logging!(
                    warn,
                    Type::Tray,
                    "Failed to initialize tray: {e}. Continuing without tray",
                );
            },
        }

        Ok(())
    }

    async fn create_tray_from_handle(&self, app_handle: &AppHandle) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Setup, "Application is exiting, skipping tray create");
            return Ok(());
        }

        logging!(info, Type::Tray, "System tray creating...");

        #[cfg(target_os = "linux")]
        let icon_bytes = include_bytes!("../../icons/icon.ico").to_vec();
        #[cfg(target_os = "windows")]
        let icon_bytes = include_bytes!("../../icons/icon.png").to_vec();
        #[cfg(target_os = "macos")]
        let icon_bytes = include_bytes!("../../icons/icon-tray.png").to_vec();

        let icon = tauri::image::Image::from_bytes(&icon_bytes)?;

        #[allow(unused_mut)]
        let mut builder = TrayIconBuilder::with_id(TRAY_ID).icon(icon).icon_as_template(false);
        #[cfg(target_os = "macos")]
        {
            builder = builder.icon_as_template(true);
        }

        let tray = builder.build(app_handle)?;
        tray.on_tray_icon_event(on_tray_icon_event);
        tray.on_menu_event(on_menu_event);

        Ok(())
    }

    pub async fn update_part(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(
                debug,
                Type::Tray,
                "Application is exiting, skipping partial tray update"
            );
            return Ok(());
        }

        self.update_menu().await?;

        Ok(())
    }

    pub async fn update_menu(&self) -> Result<()> {
        if handle::Handle::global().is_exiting() {
            logging!(debug, Type::Tray, "Application is exiting, skipping tray menu update");
            return Ok(());
        }

        let app_handle = handle::Handle::app_handle();
        self.update_menu_internal(app_handle).await
    }

    async fn update_menu_internal(&self, app_handle: &AppHandle) -> Result<()> {
        let Some(tray) = app_handle.tray_by_id(TRAY_ID) else {
            logging!(warn, Type::Tray, "Failed to update tray menu: tray not found");
            return Ok(());
        };

        let workrun = Config::workrun().await.latest_arc();
        let locale = i18n::Locale::from_str(workrun.locale.as_deref());

        logging_error!(
            Type::Tray,
            tray.set_menu(Some(create_tray_menu(app_handle, &locale).await?))
        );

        logging!(debug, Type::Tray, "Tray menu updated successfully");

        Ok(())
    }
}

async fn create_tray_menu(app_handle: &AppHandle, locale: &i18n::Locale) -> Result<tauri::menu::Menu<Wry>> {
    let app_info = app_handle.package_info();

    let dashboard = &MenuItem::with_id(
        app_handle,
        "dashboard",
        i18n::tr(locale, "menu.dashboard"),
        true,
        None::<&str>,
    )?;

    // open config dir
    let open_config_dir = &MenuItem::with_id(
        app_handle,
        "open_config_dir",
        i18n::tr(locale, "menu.open_config_dir"),
        true,
        None::<&str>,
    )?;
    // open logs dir
    let open_logs_dir = &MenuItem::with_id(
        app_handle,
        "open_logs_dir",
        i18n::tr(locale, "menu.open_logs_dir"),
        true,
        None::<&str>,
    )?;

    let open_dir = &Submenu::with_id_and_items(
        app_handle,
        "open_dir",
        i18n::tr(locale, "menu.open_dir"),
        true,
        &[open_config_dir, open_logs_dir],
    )?;

    let devtools = &MenuItem::with_id(
        app_handle,
        "open_dev_tools",
        i18n::tr(locale, "menu.open_dev_tools"),
        true,
        None::<&str>,
    )?;

    let icon_path = app_handle.path().resource_dir()?.join("icons/icon.png");
    let about = &PredefinedMenuItem::about(
        app_handle,
        Some(i18n::tr(locale, "menu.about")),
        Some(
            AboutMetadataBuilder::new()
                .version(Some(app_info.version.to_string()))
                .name(Some(&app_info.name))
                .license(Some("MIT"))
                .icon(Some(Image::from_path(icon_path)?))
                .build(),
        ),
    )?;

    let quit = &MenuItem::with_id(
        app_handle,
        "quit",
        i18n::tr(locale, "menu.quit"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    let separator = &PredefinedMenuItem::separator(app_handle)?;

    let mut menu_items: Vec<&dyn IsMenuItem<Wry>> = vec![dashboard, separator];

    menu_items.extend_from_slice(&[open_dir, devtools, about, separator, quit]);

    let menu = tauri::menu::MenuBuilder::with_id(app_handle, TRAY_MENU_ID)
        .items(&menu_items)
        .build()?;
    Ok(menu)
}

#[allow(unused_variables)]
fn on_tray_icon_event(_tray_icon: &TrayIcon, event: TrayIconEvent) {
    #[cfg(not(target_os = "macos"))]
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        ..
    } = event
    {
        AsyncHandler::spawn(|| async {
            let _ = WindowManager::show_main_window().await;
        });
    }
}

fn on_menu_event(_: &AppHandle, event: MenuEvent) {
    if event.id.as_ref().is_empty() {
        return;
    }

    AsyncHandler::spawn(|| async move {
        match event.id.as_ref() {
            "dashboard" => {
                logging!(info, Type::Tray, "Tray menu item clicked: Open window");
                WindowManager::show_main_window().await;
            },
            "open_config_dir" => {
                let _ = feat::open_config_dir().await;
            },
            "open_logs_dir" => {
                let _ = feat::open_logs_dir().await;
            },
            "open_dev_tools" => {
                feat::open_devtools();
            },
            "quit" => {
                feat::quit().await;
            },
            _ => {
                logging!(debug, Type::Tray, "Unhandled tray menu event: {:?}", event.id);
            },
        }
    });
}
