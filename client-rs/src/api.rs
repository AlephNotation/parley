//! Talking to a Parley server: one blocking call per request, JSON in and out.

use crate::util::{obj, s, Error, Result};
use crate::VERSION;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

pub enum Body {
    None,
    Json(Value),
    Text(String),
}

/// One request. A non-2xx answer becomes `Error::Api` with the server's code, message and hint.
pub fn call(server: &str, token: Option<&str>, method: &str, path: &str, body: Body, timeout: Duration) -> Result<Value> {
    let (status, text) = raw(server, token, method, path, body, timeout)?;
    let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(obj()));
    if !(200..300).contains(&status) {
        return Err(api_error(status, &data));
    }
    Ok(data)
}

/// GET with the client's usual 30 second limit.
pub fn get(server: &str, token: &str, path: &str) -> Result<Value> {
    call(server, Some(token), "GET", path, Body::None, Duration::from_secs(30))
}

pub fn post_json(server: &str, token: Option<&str>, path: &str, json: Value) -> Result<Value> {
    call(server, token, "POST", path, Body::Json(json), Duration::from_secs(30))
}

pub fn api_error(status: u16, data: &Value) -> Error {
    let err = data.get("error").cloned().unwrap_or(Value::Null);
    let code = err.get("code").and_then(Value::as_str).unwrap_or("http_error").to_string();
    let message = err
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"));
    let hint = err.get("hint").and_then(Value::as_str).map(str::to_string);
    Error::Api {
        status,
        code,
        message,
        hint,
    }
}

/// The status and body text of one request, whatever the status.
pub fn raw(server: &str, token: Option<&str>, method: &str, path: &str, body: Body, timeout: Duration) -> Result<(u16, String)> {
    // The timeout covers the whole request, connecting and reading the body included, so a
    // connection a proxy holds open after the server behind it died cannot stall a caller for good.
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut request = agent
        .request(method, &format!("{server}{path}"))
        .set("user-agent", &format!("parley-client/{VERSION}"));
    if let Some(token) = token {
        request = request.set("authorization", &format!("Bearer {token}"));
    }
    let result = match body {
        Body::None => request.call(),
        Body::Json(json) => request.set("content-type", "application/json").send_string(&json.to_string()),
        Body::Text(text) => request.set("content-type", "text/plain").send_string(&text),
    };
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(err)) => return Err(Error::Network(transport_message(&err))),
    };
    let status = response.status();
    let mut text = String::new();
    response
        .into_reader()
        .take(64 * 1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|e| Error::Network(e.to_string()))?;
    Ok((status, text))
}

fn transport_message(err: &ureq::Transport) -> String {
    match err.message() {
        Some(message) => message.to_string(),
        None => err.to_string(),
    }
}

/// The note the server attaches to a post, which says who it wakes and when.
pub fn post_outcome(res: &Value) -> (String, String) {
    let message = res.get("message").cloned().unwrap_or(Value::Null);
    let first = if s(&message, "status") == "sent" {
        format!("Posted as #{}.", crate::util::js(message.get("seq")))
    } else {
        "Not posted yet: held for review.".to_string()
    };
    (first, crate::util::js(res.get("note")))
}
