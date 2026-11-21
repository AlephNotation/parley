//! A small blocking HTTP/1.1 client: one request per connection, TLS by rustls with the bundled web
//! PKI roots. Parley needs nothing more, and a general HTTP crate costs more than this whole client
//! (URL parsing with international domain tables, connection pools, redirects, cookies).

use crate::util::Url;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Why a request failed before an HTTP status came back.
pub struct Failure(pub String);

/// Something we can read from and write to: a plain socket or a TLS stream over one.
trait Stream: Read + Write {
    fn socket(&self) -> &TcpStream;
}

impl Stream for TcpStream {
    fn socket(&self) -> &TcpStream {
        self
    }
}

impl Stream for rustls::StreamOwned<rustls::ClientConnection, TcpStream> {
    fn socket(&self) -> &TcpStream {
        &self.sock
    }
}

/// The TLS settings: rustls' safe defaults (TLS 1.3 and 1.2), ring for crypto, the bundled web PKI roots.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, Failure> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| Failure(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

/// Sends one request and reads the whole response, all within `timeout`.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>, timeout: Duration) -> Result<Response, Failure> {
    let deadline = Instant::now() + timeout;
    let parsed = Url::parse(url).ok_or_else(|| Failure(format!("invalid URL: {url}")))?;
    let https = parsed.scheme == "https";
    let port = parsed.port.unwrap_or(if https { 443 } else { 80 });
    let host = parsed.host.trim_start_matches('[').trim_end_matches(']').to_string();
    let target = if parsed.query.is_empty() {
        parsed.path.clone()
    } else {
        format!("{}?{}", parsed.path, parsed.query)
    };

    let socket = connect(&host, port, deadline)?;
    let mut stream: Box<dyn Stream> = if https {
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|_| Failure(format!("invalid host name: {host}")))?;
        let conn = rustls::ClientConnection::new(tls_config()?, name).map_err(|e| Failure(e.to_string()))?;
        Box::new(rustls::StreamOwned::new(conn, socket))
    } else {
        Box::new(socket)
    };

    let host_header = match parsed.port {
        Some(p) if p != (if https { 443 } else { 80 }) => format!("{}:{p}", parsed.host),
        _ => parsed.host.clone(),
    };
    let mut head = format!("{method} {target} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: */*\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    } else if method != "GET" {
        head.push_str("Content-Length: 0\r\n");
    }
    head.push_str("\r\n");
    set_timeouts(stream.socket(), deadline)?;
    stream.write_all(head.as_bytes()).map_err(io_failure)?;
    if let Some(body) = body {
        stream.write_all(body.as_bytes()).map_err(io_failure)?;
    }
    stream.flush().map_err(io_failure)?;

    let mut reader = BufReader::new(Deadline { inner: stream, deadline });
    let mut line = String::new();
    reader.read_line(&mut line).map_err(io_failure)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| Failure("malformed HTTP response".into()))?;
    let mut length: Option<usize> = None;
    let mut chunked = false;
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(io_failure)? == 0 {
            break;
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                length = value.parse().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }
    let mut bytes = Vec::new();
    if chunked {
        loop {
            line.clear();
            reader.read_line(&mut line).map_err(io_failure)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| Failure("malformed chunked body".into()))?;
            if size == 0 {
                break;
            }
            let start = bytes.len();
            bytes.resize(start + size, 0);
            reader.read_exact(&mut bytes[start..]).map_err(io_failure)?;
            line.clear();
            reader.read_line(&mut line).map_err(io_failure)?;
        }
    } else if let Some(length) = length {
        bytes.resize(length, 0);
        reader.read_exact(&mut bytes).map_err(io_failure)?;
    } else {
        read_to_end_tolerant(&mut reader, &mut bytes)?;
    }
    Ok(Response {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Reads until the connection closes. A TLS peer that closes without close_notify still ends the body.
fn read_to_end_tolerant(reader: &mut impl Read, bytes: &mut Vec<u8>) -> Result<(), Failure> {
    match reader.read_to_end(bytes) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(()),
        Err(e) => Err(io_failure(e)),
    }
}

fn connect(host: &str, port: u16, deadline: Instant) -> Result<TcpStream, Failure> {
    let addresses = (host, port).to_socket_addrs().map_err(|e| Failure(e.to_string()))?;
    let mut last = Failure(format!("could not resolve {host}"));
    for address in addresses {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Failure("timed out".into()));
        }
        match TcpStream::connect_timeout(&address, left) {
            Ok(socket) => {
                let _ = socket.set_nodelay(true);
                return Ok(socket);
            }
            Err(e) => last = io_failure(e),
        }
    }
    Err(last)
}

fn set_timeouts(socket: &TcpStream, deadline: Instant) -> Result<(), Failure> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Failure("timed out".into()));
    }
    socket.set_read_timeout(Some(left)).map_err(io_failure)?;
    socket.set_write_timeout(Some(left)).map_err(io_failure)
}

/// Re-arms the socket timeout before every read, so the whole response, body included, has to
/// arrive by the deadline. A proxy that holds a connection open after the server died cannot stall us.
struct Deadline {
    inner: Box<dyn Stream>,
    deadline: Instant,
}

impl Read for Deadline {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"));
        }
        self.inner.socket().set_read_timeout(Some(left))?;
        self.inner.read(buf)
    }
}

fn io_failure(e: std::io::Error) -> Failure {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => Failure("timed out".into()),
        _ => Failure(e.to_string()),
    }
}
