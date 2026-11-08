//! Explicit, authenticated playback of an indexed local file. No transcoding,
//! whole-file buffering, writes, or media reads during ordinary library browsing.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path as FsPath, PathBuf};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::AppState;

use super::{path_i64, ApiError};

const STREAM_CHUNK_BYTES: usize = 64 * 1024;

pub async fn serve(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let head = method == Method::HEAD;
    let mut response = match indexed_audio(&state, &raw_id, &headers, head).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if head {
        // In particular, HEAD errors must not expose a JSON response body.
        *response.body_mut() = Body::empty();
    }
    response
}

async fn indexed_audio(
    state: &AppState,
    raw_id: &str,
    headers: &HeaderMap,
    head: bool,
) -> Result<Response, ApiError> {
    let id = path_i64(raw_id, "track_id")?;
    if id <= 0 {
        return Err(ApiError::not_found("没有这条曲目"));
    }
    let path: Option<String> = sqlx::query_scalar("SELECT path FROM tracks WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(anyhow::Error::from)?;
    let path = path.ok_or_else(|| ApiError::not_found("没有这条曲目"))?;
    let root = state.config.music_dir.clone();
    let opened = tokio::task::spawn_blocking(move || open_audio(&root, &path))
        .await
        .map_err(|_| ApiError::bad_request("音频文件检查未完成，请稍后重试"))??;
    audio_response(opened, headers, head).await
}

struct OpenedAudio {
    file: File,
    length: u64,
    mime: &'static str,
}

fn forbidden() -> ApiError {
    ApiError::Status(
        StatusCode::FORBIDDEN,
        "曲目文件不在允许播放的音乐目录内".into(),
    )
}

fn file_error(error: io::Error) -> ApiError {
    match error.kind() {
        io::ErrorKind::NotFound => ApiError::not_found("音频文件或音乐目录已不存在"),
        io::ErrorKind::PermissionDenied => {
            ApiError::Status(StatusCode::FORBIDDEN, "没有权限读取这首曲目".into())
        }
        _ => ApiError::bad_request("音频文件无法安全读取，请确认音乐目录和文件状态"),
    }
}

fn lexical_path(value: &str) -> Result<PathBuf, ApiError> {
    let path = FsPath::new(value);
    if value.contains('\0') || !path.is_absolute() {
        return Err(ApiError::bad_request(
            "索引中的曲目路径不是有效的本机绝对路径",
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir | Component::ParentDir => {
                return Err(ApiError::bad_request("索引中的曲目路径不能包含点路径"))
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    if crate::models::path_key(&normalized) != value {
        return Err(ApiError::bad_request("索引中的曲目路径不是规范的本机路径"));
    }
    Ok(normalized)
}

fn open_audio(music_dir: &FsPath, indexed_path: &str) -> Result<OpenedAudio, ApiError> {
    let path = lexical_path(indexed_path)?;
    if !path.starts_with(music_dir) {
        return Err(forbidden());
    }
    let canonical_root = fs::canonicalize(music_dir).map_err(file_error)?;
    if !fs::metadata(&canonical_root).map_err(file_error)?.is_dir() {
        return Err(ApiError::bad_request("音乐目录不是普通目录"));
    }
    let canonical_file = fs::canonicalize(&path).map_err(file_error)?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(forbidden());
    }
    if !fs::metadata(&canonical_file).map_err(file_error)?.is_file() {
        return Err(ApiError::bad_request("只能播放普通音频文件"));
    }
    let mime = audio_mime(&path).ok_or_else(|| {
        ApiError::Status(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "此文件扩展名暂不支持直接试听".into(),
        )
    })?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Linux ABI: O_NONBLOCK avoids a replaced FIFO hanging the worker;
        // O_NOFOLLOW refuses a final symlink introduced after canonicalization.
        options.custom_flags(0o4000 | 0o400000);
    }
    let file = options.open(&canonical_file).map_err(file_error)?;
    let metadata = file.metadata().map_err(file_error)?;
    if !metadata.is_file() {
        return Err(ApiError::bad_request("只能播放普通音频文件"));
    }
    // Check the handle actually opened, not merely a path checked earlier. This
    // closes the parent-symlink swap window between canonicalize and open.
    let actual = opened_path(&file, &canonical_file).map_err(file_error)?;
    if !actual.starts_with(&canonical_root) {
        return Err(forbidden());
    }
    Ok(OpenedAudio {
        file,
        length: metadata.len(),
        mime,
    })
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File, _path: &FsPath) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(windows)]
fn opened_path(file: &File, _path: &FsPath) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut buffer = vec![0u16; 512];
    loop {
        // The handle remains owned and open throughout this call. Windows
        // writes at most buffer.len() UTF-16 units into its allocated storage.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if (length as usize) < buffer.len() {
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..length as usize],
            )));
        }
        if length > 32768 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "audio path too long",
            ));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn opened_path(file: &File, path: &FsPath) -> io::Result<PathBuf> {
    let actual = fs::canonicalize(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata()?;
        let current = fs::metadata(&actual)?;
        if (opened.dev(), opened.ino()) != (current.dev(), current.ino()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "audio path changed",
            ));
        }
    }
    Ok(actual)
}

fn audio_mime(path: &FsPath) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        "aif" | "aiff" => Some("audio/aiff"),
        "aac" => Some("audio/aac"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

fn requested_range(headers: &HeaderMap, length: u64) -> Result<Option<ByteRange>, ()> {
    // No validators are emitted for mutable local media. If-Range therefore
    // cannot be proven to match; the safe response is a complete representation.
    if headers.contains_key(header::IF_RANGE) {
        return Ok(None);
    }
    let mut values = headers.get_all(header::RANGE).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() || length == 0 {
        return Err(());
    }
    let value = value
        .to_str()
        .map_err(|_| ())?
        .trim_matches(|c: char| c.is_ascii_whitespace());
    let (start, end) = value
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    let number = |raw: &str| -> Result<u64, ()> {
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
        raw.parse::<u64>().map_err(|_| ())
    };
    let range = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return Err(());
        }
        ByteRange {
            start: length.saturating_sub(suffix),
            end: length - 1,
        }
    } else {
        let start = number(start)?;
        if start >= length {
            return Err(());
        }
        let end = if end.is_empty() {
            length - 1
        } else {
            number(end)?.min(length - 1)
        };
        if start > end {
            return Err(());
        }
        ByteRange { start, end }
    };
    Ok(Some(range))
}

async fn audio_response(
    opened: OpenedAudio,
    headers: &HeaderMap,
    head: bool,
) -> Result<Response, ApiError> {
    let range = if head {
        Ok(None)
    } else {
        requested_range(headers, opened.length)
    };
    let range = match range {
        Ok(range) => range,
        Err(()) => {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", opened.length).parse().unwrap(),
            );
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
            response
                .headers_mut()
                .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            return Ok(response);
        }
    };
    let length = range
        .map(|range| range.end - range.start + 1)
        .unwrap_or(opened.length);
    let body = if head || length == 0 {
        Body::empty()
    } else {
        let mut file = tokio::fs::File::from_std(opened.file);
        file.set_max_buf_size(STREAM_CHUNK_BYTES);
        if let Some(range) = range {
            file.seek(io::SeekFrom::Start(range.start))
                .await
                .map_err(file_error)?;
        }
        stream_body(file, length)
    };
    let mut response = Response::new(body);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(opened.mime));
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(range) = range {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end, opened.length)
                .parse()
                .unwrap(),
        );
    }
    Ok(response)
}

fn stream_body(file: tokio::fs::File, length: u64) -> Body {
    Body::from_stream(futures::stream::try_unfold(
        (file, length),
        |(mut file, remaining)| async move {
            if remaining == 0 {
                return Ok::<_, io::Error>(None);
            }
            let mut buffer = vec![0; remaining.min(STREAM_CHUNK_BYTES as u64) as usize];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "audio file changed during playback",
                ));
            }
            buffer.truncate(read);
            Ok(Some((Bytes::from(buffer), (file, remaining - read as u64))))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::io::Seek;

    struct Fixture {
        directory: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("metatidy-audio-{}", uuid::Uuid::new_v4()));
            let root = directory.join("music");
            fs::create_dir_all(&root).unwrap();
            Self { directory, root }
        }
        fn file(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.root.join(name);
            fs::write(&path, bytes).unwrap();
            crate::models::path_key(&path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            if let Ok(path) = fs::canonicalize(&self.directory) {
                if path.starts_with(&temp)
                    && path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("metatidy-audio-")
                {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }
    fn range(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, value.parse().unwrap());
        headers
    }
    fn status(error: ApiError) -> StatusCode {
        error.into_response().status()
    }
    fn open_error(root: &FsPath, path: &str) -> StatusCode {
        match open_audio(root, path) {
            Ok(_) => panic!("unexpected open"),
            Err(error) => status(error),
        }
    }

    #[test]
    fn single_ranges_handle_suffix_open_end_clamping_and_invalid_inputs() {
        for (value, start, end) in [
            ("bytes=0-0", 0, 0),
            ("bytes=2-4", 2, 4),
            ("bytes=7-", 7, 9),
            ("bytes=-3", 7, 9),
            ("bytes=-20", 0, 9),
            ("bytes=4-100", 4, 9),
            (" bytes=1-2 ", 1, 2),
            ("bytes=1-18446744073709551615", 1, 9),
        ] {
            assert_eq!(
                requested_range(&range(value), 10),
                Ok(Some(ByteRange { start, end })),
                "{value}"
            );
        }
        for invalid in [
            "bytes=",
            "bytes=-",
            "bytes=-0",
            "bytes=10-",
            "bytes=4-3",
            "bytes=0-1,4-5",
            "bytes= 1-2",
            "bytes=1 -2",
            "bytes=+1-2",
            "BYTES=1-2",
            "items=1-2",
            "bytes=1-18446744073709551616",
        ] {
            assert!(requested_range(&range(invalid), 10).is_err(), "{invalid}");
        }
        assert!(requested_range(&range("bytes=0-"), 0).is_err());
        assert_eq!(requested_range(&HeaderMap::new(), 0), Ok(None));
        let mut multiple = range("bytes=0-1");
        multiple.append(header::RANGE, HeaderValue::from_static("bytes=2-3"));
        assert!(requested_range(&multiple, 10).is_err());
        multiple.insert(
            header::IF_RANGE,
            HeaderValue::from_static("\"unknown-validator\""),
        );
        assert_eq!(requested_range(&multiple, 10), Ok(None));
    }

    #[test]
    fn audio_mime_is_exact_and_case_insensitive() {
        for (name, mime) in [
            ("a.MP3", "audio/mpeg"),
            ("a.flac", "audio/flac"),
            ("a.m4a", "audio/mp4"),
            ("a.opus", "audio/ogg"),
            ("a.oga", "audio/ogg"),
            ("a.ogg", "audio/ogg"),
            ("a.wav", "audio/wav"),
            ("a.aiff", "audio/aiff"),
            ("a.aif", "audio/aiff"),
            ("a.aac", "audio/aac"),
        ] {
            assert_eq!(audio_mime(FsPath::new(name)), Some(mime));
        }
        for name in ["no-extension", "a.mp3.exe", "a.html", "a.svg"] {
            assert_eq!(audio_mime(FsPath::new(name)), None);
        }
    }

    #[tokio::test]
    async fn real_file_bytes_ranges_and_head_use_open_file_size_without_body_reads() {
        let fixture = Fixture::new();
        let bytes: Vec<u8> = (0..200_123).map(|i| (i % 251) as u8).collect();
        let path = fixture.file(" 音乐 %_!.MP3", &bytes);
        let full = audio_response(
            open_audio(&fixture.root, &path).unwrap(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(
            full.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            axum::body::to_bytes(full.into_body(), 300_000)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        for (requested, start, end) in [
            ("bytes=5-70000", 5, 70001),
            ("bytes=-5", bytes.len() - 5, bytes.len()),
            ("bytes=200120-999999", 200120, bytes.len()),
        ] {
            let partial = audio_response(
                open_audio(&fixture.root, &path).unwrap(),
                &range(requested),
                false,
            )
            .await
            .unwrap();
            assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                partial.headers()[header::CONTENT_RANGE],
                format!("bytes {}-{}/{}", start, end - 1, bytes.len())
            );
            assert_eq!(
                partial.headers()[header::CONTENT_LENGTH],
                (end - start).to_string()
            );
            assert_eq!(
                axum::body::to_bytes(partial.into_body(), 300_000)
                    .await
                    .unwrap()
                    .as_ref(),
                &bytes[start..end]
            );
        }
        let opened = open_audio(&fixture.root, &path).unwrap();
        let mut probe = opened.file.try_clone().unwrap();
        let head = audio_response(opened, &range("bytes=999999-"), true)
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            bytes.len().to_string()
        );
        assert!(!head.headers().contains_key(header::CONTENT_RANGE));
        assert!(axum::body::to_bytes(head.into_body(), 1)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            probe.stream_position().unwrap(),
            0,
            "HEAD must not read audio bytes"
        );
    }

    #[tokio::test]
    async fn bounded_streaming_empty_files_and_unsatisfiable_ranges_do_not_overread() {
        let fixture = Fixture::new();
        let path = fixture.file("large.flac", &vec![42; STREAM_CHUNK_BYTES * 4]);
        let response = audio_response(
            open_audio(&fixture.root, &path).unwrap(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        let mut stream = response.into_body().into_data_stream();
        assert_eq!(
            stream.next().await.unwrap().unwrap().len(),
            STREAM_CHUNK_BYTES
        );
        drop(stream); // Cancelling the response drops its file and remaining stream.
        let empty = fixture.file("empty.ogg", &[]);
        let response = audio_response(
            open_audio(&fixture.root, &empty).unwrap(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        for (path, size) in [(&empty, 0), (&path, STREAM_CHUNK_BYTES * 4)] {
            let opened = open_audio(&fixture.root, path).unwrap();
            let mut probe = opened.file.try_clone().unwrap();
            let response = audio_response(opened, &range("bytes=999999-"), false)
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes */{size}")
            );
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
            assert!(axum::body::to_bytes(response.into_body(), 1)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(probe.stream_position().unwrap(), 0);
        }
    }

    #[test]
    fn indexed_paths_cannot_escape_root_or_open_non_regular_files() {
        let fixture = Fixture::new();
        let missing = crate::models::path_key(&fixture.root.join("missing.mp3"));
        assert_eq!(open_error(&fixture.root, &missing), StatusCode::NOT_FOUND);
        for bad in [
            "relative.mp3".to_owned(),
            format!("{}\0", missing),
            crate::models::path_key(&fixture.root.join("..").join("outside.mp3")),
        ] {
            assert_eq!(open_error(&fixture.root, &bad), StatusCode::BAD_REQUEST);
        }
        let outside = fixture.directory.join("music2");
        fs::create_dir(&outside).unwrap();
        let outside_file = outside.join("outside.mp3");
        fs::write(&outside_file, b"private").unwrap();
        assert_eq!(
            open_error(&fixture.root, &crate::models::path_key(&outside_file)),
            StatusCode::FORBIDDEN
        );
        let directory = fixture.root.join("directory.mp3");
        fs::create_dir(&directory).unwrap();
        assert_eq!(
            open_error(&fixture.root, &crate::models::path_key(&directory)),
            StatusCode::BAD_REQUEST
        );
        let unknown = fixture.file("unknown.txt", b"text");
        assert_eq!(
            open_error(&fixture.root, &unknown),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_symlinks_allow_in_root_files_and_reject_file_or_directory_escape() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let file = fixture.file("real\\ % song.flac", b"audio");
        let inside = fixture.root.join("inside.flac");
        symlink(&file, &inside).unwrap();
        assert_eq!(
            open_audio(&fixture.root, &crate::models::path_key(&inside))
                .unwrap()
                .length,
            5
        );
        let outside = fixture.directory.join("outside.flac");
        fs::write(&outside, b"private").unwrap();
        let escaped = fixture.root.join("escaped.flac");
        symlink(&outside, &escaped).unwrap();
        assert_eq!(
            open_error(&fixture.root, &crate::models::path_key(&escaped)),
            StatusCode::FORBIDDEN
        );
        let escaped_dir = fixture.root.join("escaped-dir");
        symlink(&fixture.directory, &escaped_dir).unwrap();
        assert_eq!(
            open_error(
                &fixture.root,
                &crate::models::path_key(&escaped_dir.join("outside.flac"))
            ),
            StatusCode::FORBIDDEN
        );
        let linked_root = fixture.directory.join("linked-root");
        symlink(&fixture.root, &linked_root).unwrap();
        assert_eq!(
            open_audio(
                &linked_root,
                &crate::models::path_key(&linked_root.join("inside.flac"))
            )
            .unwrap()
            .length,
            5
        );
    }
}
