//! Small pieces the client needs that would otherwise pull in crates: errors, JSON helpers, paths,
//! URLs, time, randomness.

use serde_json::{Map, Value};
use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Everything that can stop a command. `main` turns each into one `parley:` line plus a hint.
#[derive(Debug)]
pub enum Error {
    /// A problem the user can fix.
    User { message: String, hint: Option<String> },
    /// The server answered with an error.
    Api {
        status: u16,
        code: String,
        message: String,
        hint: Option<String>,
    },
    /// The server could not be reached, or did not answer in time.
    Network(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn user(message: impl Into<String>) -> Error {
    Error::User {
        message: message.into(),
        hint: None,
    }
}

pub fn user_hint(message: impl Into<String>, hint: impl Into<String>) -> Error {
    Error::User {
        message: message.into(),
        hint: Some(hint.into()),
    }
}

impl Error {
    /// The message alone, as the Bun client's `err.message`.
    pub fn message(&self) -> String {
        match self {
            Error::User { message, .. } | Error::Api { message, .. } => message.clone(),
            Error::Network(message) => message.clone(),
        }
    }
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

// ---- JSON access ----------------------------------------------------------

pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn opt_s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub fn i(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub fn b(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// A JS-style rendering of a value inside a template string: strings bare, null as "null".
pub fn js(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "null".into())
}

pub fn obj() -> Map<String, Value> {
    Map::new()
}

// ---- environment ----------------------------------------------------------

pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `Number(process.env.X ?? fallback)`, as the Bun client reads its tuning knobs.
pub fn env_num(name: &str, fallback: f64) -> f64 {
    match std::env::var(name) {
        Ok(text) => js_number(&text).unwrap_or(f64::NAN),
        Err(_) => fallback,
    }
}

/// JavaScript's `Number(text)` for the inputs that matter here: trimmed decimal, or 0 for blank.
pub fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok()
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(env("HOME").unwrap_or_default())
}

pub fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn sleep_ms(ms: f64) {
    if ms.is_finite() && ms > 0.0 {
        std::thread::sleep(Duration::from_millis(ms as u64));
    }
}

// ---- paths ----------------------------------------------------------------

/// `path.resolve`: absolute, with `.` and `..` folded, symlinks left alone.
pub fn resolve(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() { path.to_path_buf() } else { cwd().join(path) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolves symlinks so the same directory always compares equal, however the caller spelled it.
pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| resolve(path))
}

pub fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// True when `cwd` is `dir` or inside it.
pub fn in_dir(cwd: &str, dir: &str) -> bool {
    if cwd == dir {
        return true;
    }
    let prefix = if dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") };
    cwd.starts_with(&prefix)
}

/// Why a file operation failed, in words.
pub fn fs_reason(err: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match err.kind() {
        NotFound => "no such file".into(),
        PermissionDenied => "permission denied".into(),
        IsADirectory => "it is a directory".into(),
        NotADirectory => "a parent is not a directory".into(),
        _ => match err.raw_os_error() {
            Some(21) => "it is a directory".into(),
            Some(20) => "a parent is not a directory".into(),
            _ => err.to_string(),
        },
    }
}

/// Reads a text file, turning failures into an error that names the file.
pub fn read_text(path: &Path, what: &str) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| user(format!("cannot {what} {}: {}", path_str(path), fs_reason(&e))))
}

/// Writes JSON readable only by this user, atomically (write a temporary file, then rename).
pub fn write_private(path: &Path, data: &Value) -> Result<()> {
    let fail = |e: std::io::Error| user(format!("cannot write {}: {}", path_str(path), fs_reason(&e)));
    if let Some(dir) = path.parent() {
        create_private_dir(dir).map_err(fail)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path_str(path), std::process::id()));
    let text = pretty(data) + "\n";
    {
        use std::io::Write;
        let mut file = open_private(&tmp).map_err(fail)?;
        file.write_all(text.as_bytes()).map_err(fail)?;
    }
    std::fs::rename(&tmp, path).map_err(fail)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

// ---- URLs -----------------------------------------------------------------

/// The parts of a URL the client uses. Accepts what `new URL()` accepts for http and https.
pub struct Url {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
    pub query: String,
    pub fragment: String,
}

impl Url {
    pub fn parse(raw: &str) -> Option<Url> {
        let raw = raw.trim();
        let (scheme, rest) = raw.split_once("://")?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let (rest, fragment) = match rest.split_once('#') {
            Some((head, frag)) => (head, frag.to_string()),
            None => (rest, String::new()),
        };
        let (rest, query) = match rest.split_once('?') {
            Some((head, query)) => (head, query.to_string()),
            None => (rest, String::new()),
        };
        let (authority, path) = match rest.find('/') {
            Some(at) => (&rest[..at], rest[at..].to_string()),
            None => (rest, "/".to_string()),
        };
        let authority = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority);
        if authority.is_empty() {
            return None;
        }
        let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
            let (inside, after) = stripped.split_once(']')?;
            let port = match after.strip_prefix(':') {
                Some(p) if !p.is_empty() => Some(p.parse::<u16>().ok()?),
                Some(_) | None if after.is_empty() || after == ":" => None,
                _ => return None,
            };
            (format!("[{}]", inside.to_ascii_lowercase()), port)
        } else {
            match authority.rsplit_once(':') {
                Some((host, port)) => (
                    host.to_ascii_lowercase(),
                    if port.is_empty() { None } else { Some(port.parse::<u16>().ok()?) },
                ),
                None => (authority.to_ascii_lowercase(), None),
            }
        };
        if host.is_empty() || host.contains(char::is_whitespace) {
            return None;
        }
        Some(Url {
            scheme,
            host,
            port,
            path,
            query,
            fragment,
        })
    }

    /// `url.origin`: scheme, host, and the port unless it is the scheme's default.
    pub fn origin(&self) -> String {
        let default = if self.scheme == "https" { 443 } else { 80 };
        match self.port {
            Some(p) if p != default => format!("{}://{}:{}", self.scheme, self.host, p),
            _ => format!("{}://{}", self.scheme, self.host),
        }
    }
}

pub fn url_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

// ---- time and randomness --------------------------------------------------

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// Random bytes from the operating system.
pub fn random_hex(bytes: usize) -> Result<String> {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| user(format!("cannot read random bytes: {e}")))?;
    Ok(buf.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    }))
}

/// Compares in time that does not depend on where the inputs differ.
pub fn same_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Ensures `text` ends with a full stop.
pub fn with_stop(text: &str) -> String {
    if text.ends_with('.') {
        text.to_string()
    } else {
        format!("{text}.")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn urls_parse_like_new_url() {
        let u = Url::parse("https://Example.com:443/t#ph_abc").unwrap();
        assert_eq!(u.origin(), "https://example.com");
        assert_eq!(u.fragment, "ph_abc");
        let u = Url::parse("http://127.0.0.1:8787/j").unwrap();
        assert_eq!(u.origin(), "http://127.0.0.1:8787");
        assert_eq!(u.fragment, "");
        assert_eq!(u.path, "/j");
        assert_eq!(Url::parse("http://[::1]:9/x").unwrap().origin(), "http://[::1]:9");
        assert!(Url::parse("not a url").is_none());
        assert!(Url::parse("http://").is_none());
    }

    #[test]
    fn resolve_folds_dots() {
        assert_eq!(resolve(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
    }

    #[test]
    fn iso_dates_look_right() {
        let now = iso_now();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
    }

    #[test]
    fn in_dir_matches_parents_only() {
        assert!(in_dir("/a/b", "/a"));
        assert!(in_dir("/a", "/a"));
        assert!(!in_dir("/ab", "/a"));
    }
}
