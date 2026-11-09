//! Finite, literal filename extraction. This module never touches the filesystem.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const LIMIT: usize = 500;
pub const FIELDS: &[&str] = &["track", "disc", "artist", "title", "album"];
const MAX_TEMPLATE_BYTES: usize = 512;
const MAX_FILENAME_BYTES: usize = 4096;
const MAX_STEPS: usize = 65_536;

#[derive(Clone, Debug)]
enum Part {
    Literal(String),
    Field(String),
}

#[derive(Clone, Debug)]
pub struct Template {
    parts: Vec<Part>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Extraction {
    pub status: String,
    pub parsed_fields: BTreeMap<String, String>,
    pub reason: Option<String>,
}

impl Template {
    pub fn compile(source: &str) -> Result<Self, &'static str> {
        if source.is_empty() || source.len() > MAX_TEMPLATE_BYTES || source.contains('\0') {
            return Err("模板不能为空，且最多 512 字节，不能包含 NUL");
        }
        let mut parts = Vec::new();
        let mut rest = source;
        let mut fields = HashSet::new();
        while !rest.is_empty() {
            let brace = rest.find(['{', '}']);
            match brace {
                None => {
                    parts.push(Part::Literal(rest.to_owned()));
                    break;
                }
                Some(pos) if rest.as_bytes()[pos] == b'}' => {
                    return Err("模板花括号没有配对");
                }
                Some(pos) => {
                    if pos > 0 {
                        parts.push(Part::Literal(rest[..pos].to_owned()));
                    } else if matches!(parts.last(), Some(Part::Field(_))) {
                        return Err("相邻字段之间需要明确的字面分隔符");
                    }
                    rest = &rest[pos + 1..];
                    let end = rest.find('}').ok_or("模板花括号没有配对")?;
                    let name = &rest[..end];
                    if !FIELDS.contains(&name) {
                        return Err("仅支持 {track}、{disc}、{artist}、{title}、{album}");
                    }
                    if !fields.insert(name.to_owned()) {
                        return Err("每种字段在模板中只能出现一次");
                    }
                    parts.push(Part::Field(name.to_owned()));
                    rest = &rest[end + 1..];
                }
            }
        }
        if fields.is_empty() {
            return Err("模板至少需要一个字段");
        }
        Ok(Self { parts })
    }

    pub fn extract(&self, stem: &str) -> Extraction {
        let empty = |status: &str, reason: &str| Extraction {
            status: status.into(),
            parsed_fields: BTreeMap::new(),
            reason: Some(reason.into()),
        };
        if stem.len() > MAX_FILENAME_BYTES || stem.contains('\0') {
            return empty("invalid", "文件名过长或含有 NUL");
        }
        let mut search = Search {
            template: self,
            input: stem,
            steps: 0,
            exhausted: false,
            structural_match: false,
            answers: Vec::new(),
        };
        search.walk(0, 0, &mut BTreeMap::new(), true);
        if search.exhausted || search.answers.len() > 1 {
            empty("ambiguous", "分隔符在内容中重复，无法唯一确定；请调整模板")
        } else if let Some(fields) = search.answers.pop() {
            Extraction {
                status: "matched".into(),
                parsed_fields: fields,
                reason: None,
            }
        } else if search.structural_match {
            empty(
                "invalid",
                "字段不能为空；轨号和碟号必须是范围内的 ASCII 非负整数",
            )
        } else {
            empty("unmatched", "文件名与模板不匹配（空格和分隔符必须一致）")
        }
    }
}

struct Search<'a> {
    template: &'a Template,
    input: &'a str,
    steps: usize,
    exhausted: bool,
    structural_match: bool,
    answers: Vec<BTreeMap<String, String>>,
}

impl Search<'_> {
    fn walk(
        &mut self,
        part: usize,
        start: usize,
        fields: &mut BTreeMap<String, String>,
        valid: bool,
    ) {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            self.exhausted = true;
            return;
        }
        if self.answers.len() > 1 || self.exhausted {
            return;
        }
        if part == self.template.parts.len() {
            if start == self.input.len() {
                self.structural_match = true;
                if valid && !self.answers.contains(fields) {
                    self.answers.push(fields.clone());
                }
            }
            return;
        }
        match &self.template.parts[part] {
            Part::Literal(literal) => {
                if self.input[start..].starts_with(literal) {
                    self.walk(part + 1, start + literal.len(), fields, valid);
                }
            }
            Part::Field(name) => {
                // Adjacent fields are prohibited; enumerate every exact occurrence
                // of the next literal, including overlapping Unicode-safe matches.
                let ends: Vec<usize> = match self.template.parts.get(part + 1) {
                    Some(Part::Literal(literal)) => {
                        let mut ends = Vec::new();
                        for end in self.input[start..]
                            .char_indices()
                            .map(|(offset, _)| start + offset)
                            .chain(std::iter::once(self.input.len()))
                        {
                            // Count separator search work too, not just recursive
                            // branches; adversarial repetition stays bounded.
                            self.steps += 1;
                            if self.steps > MAX_STEPS {
                                self.exhausted = true;
                                return;
                            }
                            if self.input[end..].starts_with(literal) {
                                ends.push(end);
                            }
                        }
                        ends
                    }
                    _ => vec![self.input.len()],
                };
                let name = name.clone();
                for end in ends {
                    let value = self.input[start..end].trim();
                    let field_valid = !value.is_empty()
                        && (!matches!(name.as_str(), "track" | "disc")
                            || (value.bytes().all(|b| b.is_ascii_digit())
                                && value.parse::<u32>().is_ok()));
                    fields.insert(name.clone(), value.to_owned());
                    self.walk(part + 1, end, fields, valid && field_valid);
                    fields.remove(&name);
                    if self.answers.len() > 1 || self.exhausted {
                        break;
                    }
                }
            }
        }
    }
}

pub fn filename_and_stem(path: &str) -> (String, String) {
    let path = Path::new(path);
    (
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    )
}

pub fn digest(value: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(value).expect("JSON values serialize");
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(template: &str, value: &str) -> Extraction {
        Template::compile(template).unwrap().extract(value)
    }

    #[test]
    fn finite_presets_preserve_unicode_and_numeric_originals() {
        let a = parse("{track} - {artist} - {title}", "01 - 周杰伦 - 稻香🎵");
        assert_eq!(a.status, "matched");
        assert_eq!(a.parsed_fields["track"], "01");
        assert_eq!(a.parsed_fields["title"], "稻香🎵");
        assert_eq!(
            parse(
                "{disc}_{track}::{album}::{title}",
                "0_4294967295::专辑::e\u{301}"
            )
            .status,
            "matched"
        );
        assert_eq!(
            parse("{title}", "  A - B (Live)  ").parsed_fields["title"],
            "A - B (Live)"
        );
    }

    #[test]
    fn rejects_ambiguous_splits_but_uses_numeric_constraints() {
        assert_eq!(parse("{artist} - {title}", "A - B - C").status, "ambiguous");
        let unique = parse("{track} - {title}", "01 - A - B");
        assert_eq!(unique.status, "matched");
        assert_eq!(unique.parsed_fields["title"], "A - B");
        assert_eq!(
            parse("{track} - {title}", "4294967296 - song").status,
            "invalid"
        );
        assert_eq!(parse("{track} - {title}", "０１ - song").status, "invalid");
        assert_eq!(parse("{artist} - {title}", " - song").status, "invalid");
        assert_eq!(parse("[{title}]", "[song] extra").status, "unmatched");
    }

    #[test]
    fn rejects_malformed_or_unbounded_templates_and_inputs() {
        for source in [
            "",
            "literal",
            "{artist}{title}",
            "{title}-{title}",
            "{year}",
            "{title",
            "title}",
            "{{title}",
            "{title}\0",
        ] {
            assert!(Template::compile(source).is_err(), "{source}");
        }
        assert!(Template::compile(&format!("{}{{title}}", "a".repeat(513))).is_err());
        assert_eq!(parse("{title}", &"a".repeat(4097)).status, "invalid");
        assert_eq!(parse("{title}", "a\0b").status, "invalid");
        assert_eq!(
            parse(
                "{track}-{disc}-{artist}-{album}-{title}",
                &format!("{}x", "0-".repeat(1200))
            )
            .status,
            "ambiguous"
        );
    }

    #[test]
    fn basename_only_removes_last_extension_and_preserves_inner_dots() {
        assert_eq!(
            filename_and_stem("/music/ignore/01 - A.v2.flac"),
            ("01 - A.v2.flac".into(), "01 - A.v2".into())
        );
        assert_eq!(parse("{artist} - {title}", "A-B").status, "unmatched");
        assert_eq!(parse("{title}", "第二首").parsed_fields.len(), 1);
    }
}
