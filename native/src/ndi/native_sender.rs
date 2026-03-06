use std::env;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use libloading::Library;

use crate::render::RenderFrame;
use crate::state::OutputConfig;

const NDI_FOURCC_BGRA: u32 = 0x4152_4742;
const NDI_FRAME_FORMAT_PROGRESSIVE: c_int = 1;

type SendInstance = *mut c_void;

#[repr(C)]
struct NDIlibSendCreateT {
    p_ndi_name: *const c_char,
    p_groups: *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
struct NDIlibVideoFrameV2T {
    xres: c_int,
    yres: c_int,
    four_cc: u32,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: f32,
    frame_format_type: c_int,
    timecode: i64,
    p_data: *mut u8,
    line_stride_in_bytes: c_int,
    p_metadata: *const c_char,
    timestamp: i64,
}

type InitializeFn = unsafe extern "C" fn() -> bool;
type DestroyFn = unsafe extern "C" fn();
type SendCreateFn = unsafe extern "C" fn(*const NDIlibSendCreateT) -> SendInstance;
type SendDestroyFn = unsafe extern "C" fn(SendInstance);
type SendVideoFn = unsafe extern "C" fn(SendInstance, *const NDIlibVideoFrameV2T);

struct NdiApi {
    _library: Library,
    destroy: DestroyFn,
    send_create: SendCreateFn,
    send_destroy: SendDestroyFn,
    send_video: SendVideoFn,
}

impl Drop for NdiApi {
    fn drop(&mut self) {
        unsafe {
            (self.destroy)();
        }
    }
}

static SHARED_API: OnceLock<Result<Arc<NdiApi>, String>> = OnceLock::new();

fn shared_api() -> Result<Arc<NdiApi>, String> {
    SHARED_API
        .get_or_init(|| load_api().map(Arc::new))
        .clone()
}

fn load_api() -> Result<NdiApi, String> {
    let mut errors = Vec::<String>::new();

    for candidate in candidate_library_paths() {
        if !should_attempt_path(&candidate) {
            continue;
        }

        let library = match unsafe { Library::new(&candidate) } {
            Ok(library) => library,
            Err(error) => {
                errors.push(format!(
                    "Failed to load {}: {}",
                    display_path(&candidate),
                    error
                ));
                continue;
            }
        };

        unsafe {
            let initialize: InitializeFn = match get_symbol(&library, &[b"NDIlib_initialize\0"]) {
                Ok(symbol) => symbol,
                Err(error) => {
                    errors.push(format!(
                        "{} missing initialize symbol: {}",
                        display_path(&candidate),
                        error
                    ));
                    continue;
                }
            };

            if !(initialize)() {
                errors.push(format!(
                    "{} initialize returned false",
                    display_path(&candidate)
                ));
                continue;
            }
        }

        let destroy = unsafe {
            match get_symbol::<DestroyFn>(&library, &[b"NDIlib_destroy\0"]) {
                Ok(symbol) => symbol,
                Err(error) => {
                    errors.push(format!(
                        "{} missing destroy symbol: {}",
                        display_path(&candidate),
                        error
                    ));
                    continue;
                }
            }
        };

        let send_create = unsafe {
            match get_symbol::<SendCreateFn>(
                &library,
                &[b"NDIlib_send_create_v2\0", b"NDIlib_send_create\0"],
            ) {
                Ok(symbol) => symbol,
                Err(error) => {
                    errors.push(format!(
                        "{} missing send_create symbol: {}",
                        display_path(&candidate),
                        error
                    ));
                    continue;
                }
            }
        };

        let send_destroy = unsafe {
            match get_symbol::<SendDestroyFn>(&library, &[b"NDIlib_send_destroy\0"]) {
                Ok(symbol) => symbol,
                Err(error) => {
                    errors.push(format!(
                        "{} missing send_destroy symbol: {}",
                        display_path(&candidate),
                        error
                    ));
                    continue;
                }
            }
        };

        let send_video = unsafe {
            match get_symbol::<SendVideoFn>(&library, &[b"NDIlib_send_send_video_v2\0"]) {
                Ok(symbol) => symbol,
                Err(error) => {
                    errors.push(format!(
                        "{} missing send_video symbol: {}",
                        display_path(&candidate),
                        error
                    ));
                    continue;
                }
            }
        };

        return Ok(NdiApi {
            _library: library,
            destroy,
            send_create,
            send_destroy,
            send_video,
        });
    }

    if errors.is_empty() {
        Err("NDI runtime library not found".to_string())
    } else {
        Err(errors.join("; "))
    }
}

unsafe fn get_symbol<T>(library: &Library, names: &[&[u8]]) -> Result<T, String>
where
    T: Copy,
{
    for name in names {
        if let Ok(symbol) = library.get::<T>(name) {
            return Ok(*symbol);
        }
    }

    Err(format!(
        "none of symbols matched: {}",
        names
            .iter()
            .map(|name| String::from_utf8_lossy(name).replace('\0', ""))
            .collect::<Vec<String>>()
            .join(", ")
    ))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn should_attempt_path(path: &Path) -> bool {
    if path.is_absolute() {
        return path.exists();
    }
    true
}

fn candidate_library_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Ok(folder) = env::var("NDILIB_REDIST_FOLDER") {
        let folder_path = PathBuf::from(folder);
        if cfg!(target_os = "windows") {
            candidates.push(folder_path.join("Processing.NDI.Lib.x64.dll"));
        } else if cfg!(target_os = "macos") {
            candidates.push(folder_path.join("libndi.dylib"));
        } else {
            candidates.push(folder_path.join("libndi.so.6"));
            candidates.push(folder_path.join("libndi.so.5"));
            candidates.push(folder_path.join("libndi.so"));
        }
    }

    if cfg!(target_os = "windows") {
        candidates.push(PathBuf::from("Processing.NDI.Lib.x64.dll"));
        candidates.push(PathBuf::from(
            "C:\\Program Files\\NDI\\NDI 6 Runtime\\Processing.NDI.Lib.x64.dll",
        ));
        candidates.push(PathBuf::from(
            "C:\\Program Files\\NDI\\NDI 5 Runtime\\Processing.NDI.Lib.x64.dll",
        ));
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("libndi.dylib"));
        candidates.push(PathBuf::from("/usr/local/lib/libndi.dylib"));
        candidates.push(PathBuf::from("/opt/homebrew/lib/libndi.dylib"));
    } else {
        candidates.push(PathBuf::from("libndi.so.6"));
        candidates.push(PathBuf::from("libndi.so.5"));
        candidates.push(PathBuf::from("libndi.so"));
        candidates.push(PathBuf::from("/usr/lib/libndi.so.6"));
        candidates.push(PathBuf::from("/usr/local/lib/libndi.so.6"));
    }

    candidates
}

pub struct NativeNdiSender {
    api: Arc<NdiApi>,
    instance: SendInstance,
    width: u32,
    height: u32,
    fps: u32,
}

// The underlying NDI send instance is created and consumed inside a single worker task.
// We only move ownership between async poll points and never alias it across threads.
unsafe impl Send for NativeNdiSender {}

impl NativeNdiSender {
    pub fn new(config: &OutputConfig) -> Result<Self, String> {
        let api = shared_api()?;
        let (width, height) = config.dimensions();
        let source_name = if config.source_name.trim().is_empty() {
            "LyricDisplay Output".to_string()
        } else {
            config.source_name.clone()
        };
        let source_name_c = CString::new(source_name)
            .map_err(|_| "source name contains invalid NUL byte".to_string())?;

        let create = NDIlibSendCreateT {
            p_ndi_name: source_name_c.as_ptr(),
            p_groups: std::ptr::null(),
            clock_video: false,
            clock_audio: false,
        };

        let instance = unsafe { (api.send_create)(&create) };
        if instance.is_null() {
            return Err("NDI send_create returned null".to_string());
        }

        Ok(Self {
            api,
            instance,
            width,
            height,
            fps: config.normalized_framerate(),
        })
    }

    pub fn send_frame(&mut self, frame: &RenderFrame) -> Result<(), String> {
        if frame.width != self.width || frame.height != self.height {
            return Err(format!(
                "frame size mismatch (expected {}x{}, got {}x{})",
                self.width, self.height, frame.width, frame.height
            ));
        }

        let mut bgra = frame.pixels.clone();
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        let video_frame = NDIlibVideoFrameV2T {
            xres: frame.width as c_int,
            yres: frame.height as c_int,
            four_cc: NDI_FOURCC_BGRA,
            frame_rate_n: self.fps as c_int,
            frame_rate_d: 1,
            picture_aspect_ratio: if frame.height > 0 {
                frame.width as f32 / frame.height as f32
            } else {
                1.0
            },
            frame_format_type: NDI_FRAME_FORMAT_PROGRESSIVE,
            timecode: 0,
            p_data: bgra.as_mut_ptr(),
            line_stride_in_bytes: frame.stride as c_int,
            p_metadata: std::ptr::null(),
            timestamp: 0,
        };

        unsafe {
            (self.api.send_video)(self.instance, &video_frame);
        }
        Ok(())
    }
}

impl Drop for NativeNdiSender {
    fn drop(&mut self) {
        if self.instance.is_null() {
            return;
        }
        unsafe {
            (self.api.send_destroy)(self.instance);
        }
        self.instance = std::ptr::null_mut();
    }
}
