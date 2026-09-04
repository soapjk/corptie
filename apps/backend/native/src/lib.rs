#[macro_use]
extern crate napi_derive;

use napi::{Error, Result, Status};
use std::ffi::{c_char, CStr, CString};

#[napi]
pub fn levenshtein_distance(a: String, b: String) -> u32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n == 0 { return m as u32; }
    if m == 0 { return n as u32; }
    let mut prev: Vec<u32> = (0..=m as u32).collect();
    let mut curr: Vec<u32> = vec![0; m + 1];
    for i in 1..=n {
        curr[0] = i as u32;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

#[repr(C)]
struct NativeSafeTreeResult {
    root_device: u64,
    root_inode: u64,
    target_device: u64,
    target_inode: u64,
    files: u64,
    bytes: u64,
    error_code: [c_char; 64],
    error_message: [c_char; 256],
}

impl Default for NativeSafeTreeResult {
    fn default() -> Self {
        Self {
            root_device: 0, root_inode: 0, target_device: 0, target_inode: 0,
            files: 0, bytes: 0, error_code: [0; 64], error_message: [0; 256],
        }
    }
}

unsafe extern "C" {
    fn corptie_inspect_tree(root: *const c_char, relative: *const c_char, out: *mut NativeSafeTreeResult) -> i32;
    fn corptie_remove_tree(
        root: *const c_char,
        source_relative: *const c_char,
        trash_relative: *const c_char,
        expected_root_device: u64,
        expected_root_inode: u64,
        expected_target_device: u64,
        expected_target_inode: u64,
        out: *mut NativeSafeTreeResult,
    ) -> i32;
    fn corptie_delete_tree(
        root: *const c_char,
        relative: *const c_char,
        expected_root_device: u64,
        expected_root_inode: u64,
        expected_target_device: u64,
        expected_target_inode: u64,
        out: *mut NativeSafeTreeResult,
    ) -> i32;
    fn corptie_source_journal_start(root: *const c_char, handle: *mut u64, out: *mut NativeSourceJournalResult) -> i32;
    fn corptie_source_journal_reset(handle: u64, paths: *const *const c_char, count: usize, out: *mut NativeSourceJournalResult) -> i32;
    fn corptie_source_journal_barrier(handle: u64, out: *mut NativeSourceJournalResult) -> i32;
    fn corptie_source_journal_stop(handle: u64) -> i32;
}

#[repr(C)]
struct NativeSourceJournalResult {
    epoch: u64,
    event_id: u64,
    trusted: i32,
    error_code: [c_char; 64],
}

impl Default for NativeSourceJournalResult {
    fn default() -> Self { Self { epoch: 0, event_id: 0, trusted: 0, error_code: [0; 64] } }
}

#[napi(object)]
pub struct SourceJournalStart {
    pub handle: String,
    pub epoch: String,
    pub trusted: bool,
}

#[napi(object)]
pub struct SourceJournalBarrier {
    pub epoch: String,
    pub event_id: String,
    pub trusted: bool,
    pub error_code: Option<String>,
}

#[napi]
pub fn source_journal_start(root_path: String) -> Result<SourceJournalStart> {
    let root = c_string(root_path)?;
    let mut handle = 0_u64;
    let mut result = NativeSourceJournalResult::default();
    let status = unsafe { corptie_source_journal_start(root.as_ptr(), &mut handle, &mut result) };
    if status != 0 { return Err(source_journal_error(&result)); }
    Ok(SourceJournalStart { handle: handle.to_string(), epoch: result.epoch.to_string(), trusted: result.trusted != 0 })
}

#[napi]
pub fn source_journal_barrier(handle: String) -> Result<SourceJournalBarrier> {
    let handle = parse_identity(&handle, "source journal handle")?;
    let mut result = NativeSourceJournalResult::default();
    let status = unsafe { corptie_source_journal_barrier(handle, &mut result) };
    if status != 0 { return Err(source_journal_error(&result)); }
    let code = unsafe { CStr::from_ptr(result.error_code.as_ptr()) }.to_string_lossy().into_owned();
    Ok(SourceJournalBarrier {
        epoch: result.epoch.to_string(), event_id: result.event_id.to_string(), trusted: result.trusted != 0,
        error_code: if code.is_empty() { None } else { Some(code) },
    })
}

#[napi]
pub fn source_journal_reset(handle: String, paths: Vec<String>) -> Result<SourceJournalBarrier> {
    let handle = parse_identity(&handle, "source journal handle")?;
    let values: Result<Vec<CString>> = paths.into_iter().map(c_string).collect();
    let values = values?;
    let pointers: Vec<*const c_char> = values.iter().map(|value| value.as_ptr()).collect();
    let mut result = NativeSourceJournalResult::default();
    let status = unsafe { corptie_source_journal_reset(handle, pointers.as_ptr(), pointers.len(), &mut result) };
    if status != 0 { return Err(source_journal_error(&result)); }
    let code = unsafe { CStr::from_ptr(result.error_code.as_ptr()) }.to_string_lossy().into_owned();
    Ok(SourceJournalBarrier {
        epoch: result.epoch.to_string(), event_id: result.event_id.to_string(), trusted: result.trusted != 0,
        error_code: if code.is_empty() { None } else { Some(code) },
    })
}

#[napi]
pub fn source_journal_stop(handle: String) -> Result<()> {
    let handle = parse_identity(&handle, "source journal handle")?;
    if unsafe { corptie_source_journal_stop(handle) } != 0 {
        return Err(Error::new(Status::InvalidArg, "SOURCE_JOURNAL_HANDLE_INVALID: Unknown source journal handle.".to_string()));
    }
    Ok(())
}

fn source_journal_error(result: &NativeSourceJournalResult) -> Error {
    let code = unsafe { CStr::from_ptr(result.error_code.as_ptr()) }.to_string_lossy();
    Error::new(Status::GenericFailure, format!("{code}: Source journal operation failed."))
}

#[napi(object)]
pub struct SafeTreeInspection {
    pub root_device_id: String,
    pub root_inode: String,
    pub target_device_id: String,
    pub target_inode: String,
    pub files: i64,
    pub bytes: i64,
    pub proof_mechanism: String,
}

#[napi]
pub fn inspect_tree_openat(root_path: String, relative_path: String) -> Result<SafeTreeInspection> {
    let root = c_string(root_path)?;
    let relative = c_string(relative_path)?;
    let mut result = NativeSafeTreeResult::default();
    let status = unsafe { corptie_inspect_tree(root.as_ptr(), relative.as_ptr(), &mut result) };
    convert_result(status, result, "openat(O_DIRECTORY|O_NOFOLLOW)+fstatat(AT_SYMLINK_NOFOLLOW)")
}

#[napi]
pub fn safe_remove_tree_openat(
    root_path: String,
    source_relative_path: String,
    trash_relative_path: String,
    expected_root_device_id: String,
    expected_root_inode: String,
    expected_target_device_id: String,
    expected_target_inode: String,
) -> Result<SafeTreeInspection> {
    let root = c_string(root_path)?;
    let source = c_string(source_relative_path)?;
    let trash = c_string(trash_relative_path)?;
    let root_device = parse_identity(&expected_root_device_id, "root device")?;
    let root_inode = parse_identity(&expected_root_inode, "root inode")?;
    let target_device = parse_identity(&expected_target_device_id, "target device")?;
    let target_inode = parse_identity(&expected_target_inode, "target inode")?;
    let mut result = NativeSafeTreeResult::default();
    let status = unsafe {
        corptie_remove_tree(root.as_ptr(), source.as_ptr(), trash.as_ptr(), root_device, root_inode, target_device, target_inode, &mut result)
    };
    convert_result(status, result, "renameatx_np(RENAME_EXCL)+openat(O_NOFOLLOW)+unlinkat")
}

#[napi]
pub fn safe_delete_tree_openat(
    root_path: String,
    relative_path: String,
    expected_root_device_id: String,
    expected_root_inode: String,
    expected_target_device_id: String,
    expected_target_inode: String,
) -> Result<SafeTreeInspection> {
    let root = c_string(root_path)?;
    let relative = c_string(relative_path)?;
    let root_device = parse_identity(&expected_root_device_id, "root device")?;
    let root_inode = parse_identity(&expected_root_inode, "root inode")?;
    let target_device = parse_identity(&expected_target_device_id, "target device")?;
    let target_inode = parse_identity(&expected_target_inode, "target inode")?;
    let mut result = NativeSafeTreeResult::default();
    let status = unsafe {
        corptie_delete_tree(root.as_ptr(), relative.as_ptr(), root_device, root_inode, target_device, target_inode, &mut result)
    };
    convert_result(status, result, "openat(O_NOFOLLOW)+fstatat(AT_SYMLINK_NOFOLLOW)+unlinkat")
}

fn c_string(value: String) -> Result<CString> {
    CString::new(value).map_err(|_| Error::new(Status::InvalidArg, "RUN_PATH_INVALID: Path contains NUL.".to_string()))
}

fn parse_identity(value: &str, label: &str) -> Result<u64> {
    value.parse::<u64>().map_err(|_| Error::new(Status::InvalidArg, format!("RUN_IDENTITY_INVALID: {label} is invalid.")))
}

fn convert_result(status: i32, result: NativeSafeTreeResult, mechanism: &str) -> Result<SafeTreeInspection> {
    if status != 0 {
        let code = unsafe { CStr::from_ptr(result.error_code.as_ptr()) }.to_string_lossy();
        let message = unsafe { CStr::from_ptr(result.error_message.as_ptr()) }.to_string_lossy();
        return Err(Error::new(Status::GenericFailure, format!("{code}: {message}")));
    }
    Ok(SafeTreeInspection {
        root_device_id: result.root_device.to_string(),
        root_inode: result.root_inode.to_string(),
        target_device_id: result.target_device.to_string(),
        target_inode: result.target_inode.to_string(),
        files: i64::try_from(result.files).map_err(|_| Error::new(Status::GenericFailure, "RUN_TREE_OVERFLOW: file count".to_string()))?,
        bytes: i64::try_from(result.bytes).map_err(|_| Error::new(Status::GenericFailure, "RUN_TREE_OVERFLOW: byte count".to_string()))?,
        proof_mechanism: mechanism.to_string(),
    })
}
