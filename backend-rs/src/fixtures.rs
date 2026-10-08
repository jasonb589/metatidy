//! 合成最小可用的音频样本（**不需要任何编码器**）。
//!
//! 用途：让 CI 在没有真实音乐文件的环境里，也能完整验证扫描、标签读写、整理移动。
//! 做法与 Python 版一致：
//! - FLAC：只写 header + STREAMINFO（42 字节），没有音频帧；lofty 只需要元数据块就能读写标签
//! - MP3：写若干帧静音 MPEG-1 Layer III，让解析器能找到合法帧头

use std::fs;
use std::path::Path;

/// 只有 STREAMINFO 的 FLAC（44100Hz / 2ch / 16bit）。
pub fn make_flac(path: &Path) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(42);
    buf.extend_from_slice(b"fLaC");
    buf.push(0x80); // last metadata block, type 0 = STREAMINFO
    buf.extend_from_slice(&[0x00, 0x00, 0x22]); // 块长度 = 34
    buf.extend_from_slice(&4096u16.to_be_bytes()); // min blocksize
    buf.extend_from_slice(&4096u16.to_be_bytes()); // max blocksize
    buf.extend_from_slice(&[0, 0, 0]); // min framesize
    buf.extend_from_slice(&[0, 0, 0]); // max framesize
    // 20bit 采样率 | 3bit 声道-1 | 5bit 位深-1 | 36bit 总采样数
    let packed: u64 = (44100u64 << 44) | (1u64 << 41) | (15u64 << 36);
    buf.extend_from_slice(&packed.to_be_bytes());
    buf.extend_from_slice(&[0u8; 16]); // md5

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, buf)
}

/// 若干帧静音 MPEG-1 Layer III（128kbps / 44.1kHz，每帧 417 字节）。
pub fn make_mp3(path: &Path, frames: usize) -> std::io::Result<()> {
    let mut frame = vec![0u8; 417];
    frame[0] = 0xFF;
    frame[1] = 0xFB;
    frame[2] = 0x90;
    frame[3] = 0x00;

    let mut buf = Vec::with_capacity(417 * frames);
    for _ in 0..frames {
        buf.extend_from_slice(&frame);
    }

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flac_fixture_has_expected_header() {
        let dir = std::env::temp_dir().join("metatidy-fixture-test");
        let path = dir.join("a.flac");
        make_flac(&path).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"fLaC");
        assert_eq!(bytes.len(), 42);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn mp3_fixture_has_valid_frame_header() {
        let dir = std::env::temp_dir().join("metatidy-fixture-test");
        let path = dir.join("a.mp3");
        make_mp3(&path, 4).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 417 * 4);
        assert_eq!(bytes[0], 0xFF);
        fs::remove_file(&path).ok();
    }
}
