//! 合成**合法**的音频样本（不需要任何编码器）。
//!
//! 为什么不是「只写个头文件」：lofty 在写回标签时会解析音频流，
//! 一个没有音频帧的 FLAC 会让它 panic。所以这里手工拼出**一个完整的 FLAC 帧**，
//! 包含正确的 CRC-8（帧头）与 CRC-16（整帧）。
//!
//! 帧内容：单声道 / 44100Hz / 16bit / 4096 个采样 / CONSTANT 子帧（全 0，即静音）。

use std::fs;
use std::path::Path;

/// FLAC 帧头 CRC-8：多项式 0x07，初值 0。
fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0;
    for &byte in data {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// FLAC 整帧 CRC-16：多项式 0x8005，初值 0。
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &byte in data {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x8005
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// 一个 4096 采样的静音帧（单声道 16bit）。
fn silent_frame(blocksize: u16) -> Vec<u8> {
    let mut frame: Vec<u8> = Vec::with_capacity(16);
    // 同步码 14 位 + 保留位 0 + 固定块大小标志 0
    frame.push(0xFF);
    frame.push(0xF8);
    // 块大小码 1100（16 位块大小放在帧头末尾） | 采样率码 1001（44100Hz）
    frame.push(0xC9);
    // 声道分配 0000（单声道） | 采样位深 100（16bit） | 保留位 0
    frame.push(0x08);
    // 帧序号 0（UTF-8 编码）
    frame.push(0x00);
    // 块大小 - 1（16 位）
    let bs = blocksize - 1;
    frame.push((bs >> 8) as u8);
    frame.push((bs & 0xFF) as u8);
    // 帧头 CRC-8
    let header_crc = crc8(&frame);
    frame.push(header_crc);
    // 子帧：CONSTANT 类型、无浪费位、采样值 0
    frame.push(0x00);
    frame.push(0x00);
    frame.push(0x00);
    // 整帧 CRC-16
    let frame_crc = crc16(&frame);
    frame.push((frame_crc >> 8) as u8);
    frame.push((frame_crc & 0xFF) as u8);
    frame
}

/// 生成一个可被任意标签库读写的 FLAC：真实帧 + 与之匹配的 STREAMINFO。
pub fn make_flac(path: &Path) -> std::io::Result<()> {
    const BLOCKSIZE: u16 = 4096;
    const SAMPLE_RATE: u32 = 44100;
    const CHANNELS: u32 = 1;
    const BITS_PER_SAMPLE: u32 = 16;

    let frame = silent_frame(BLOCKSIZE);

    let mut streaminfo: Vec<u8> = Vec::with_capacity(34);
    streaminfo.extend_from_slice(&BLOCKSIZE.to_be_bytes());
    streaminfo.extend_from_slice(&BLOCKSIZE.to_be_bytes());
    // 最小/最大帧长：0 = 未知（规范允许）
    streaminfo.extend_from_slice(&[0, 0, 0]);
    streaminfo.extend_from_slice(&[0, 0, 0]);
    // 20bit 采样率 | 3bit(声道-1) | 5bit(位深-1) | 36bit 总采样数
    let packed: u64 = ((SAMPLE_RATE as u64) << 44)
        | (((CHANNELS - 1) as u64) << 41)
        | (((BITS_PER_SAMPLE - 1) as u64) << 36)
        | (BLOCKSIZE as u64);
    streaminfo.extend_from_slice(&packed.to_be_bytes());
    streaminfo.extend_from_slice(&[0u8; 16]); // MD5：全 0 表示未计算
    debug_assert_eq!(streaminfo.len(), 34);

    let mut out: Vec<u8> = Vec::with_capacity(4 + 4 + 34 + frame.len());
    out.extend_from_slice(b"fLaC");
    out.push(0x80); // 最后一个元数据块 + 类型 0（STREAMINFO）
    out.extend_from_slice(&[0x00, 0x00, 0x22]); // 块长度 34
    out.extend_from_slice(&streaminfo);
    out.extend_from_slice(&frame);

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, out)
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
    use lofty::file::AudioFile;
    use lofty::probe::Probe;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("metatidy-fixtures");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn flac_fixture_is_parseable_by_lofty() {
        let path = temp_path("valid.flac");
        make_flac(&path).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"fLaC");

        let tagged = Probe::open(&path)
            .expect("lofty 应能打开")
            .read()
            .expect("lofty 应能解析合成的 FLAC");
        assert!(tagged.properties().duration().as_secs_f64() >= 0.0);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn crc_matches_reference_values() {
        // CRC-8/0x07 对 "123456789" 的参考值
        assert_eq!(crc8(b"123456789"), 0xF4);
        // CRC-16/0x8005 对 "123456789" 的参考值
        assert_eq!(crc16(b"123456789"), 0xFEE8);
    }

    #[test]
    fn mp3_fixture_has_valid_frame_header() {
        let path = temp_path("a.mp3");
        make_mp3(&path, 4).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 417 * 4);
        assert_eq!(bytes[0], 0xFF);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn mp3_fixture_is_parseable_by_lofty() {
        let path = temp_path("valid.mp3");
        make_mp3(&path, 8).unwrap();
        let tagged = Probe::open(&path).expect("lofty 应能打开 MP3").read();
        assert!(tagged.is_ok(), "lofty 应能解析合成的 MP3：{:?}", tagged.err());
        fs::remove_file(&path).ok();
    }
}


/// 取一个「真实编码器产出的」样本：从 `env_key` 指向的路径复制一份到临时目录。
///
/// 为什么需要真实样本：手拼的容器（尤其是 FLAC）虽然能被解析，
/// 但写标签时不一定扛得住 lofty 的写入路径——真实编码器产出的文件才是可信基准。
/// CI 里由 ffmpeg 现场生成（见 .github/workflows/ci.yml），本地没有就跳过相关测试。
///
/// 每次都复制成唯一文件名，避免并行测试互相踩。
pub fn real_fixture(env_key: &str, dst_name: &str) -> Option<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let source = std::env::var(env_key)
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.exists())?;

    let dir = std::env::temp_dir().join("metatidy-real-fixtures");
    fs::create_dir_all(&dir).ok()?;

    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dst = dir.join(format!("{}-{seq}-{dst_name}", std::process::id()));
    let _ = fs::remove_file(&dst);
    fs::copy(&source, &dst).ok()?;
    Some(dst)
}
