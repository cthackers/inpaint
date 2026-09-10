//! Web requests, made in the app: downloads for the API server and the drop box, and calls to Immich.
//! Only http and https are followed, redirects included, and the system's certificates are trusted, so
//! an Immich behind a private certificate authority works.

use std::{
    io::{self, Write},
    sync::LazyLock,
    time::Duration,
};
use ureq::{
    tls::{RootCerts, TlsConfig},
    Agent,
};

/// Shared so connections are reused. Callers check status codes and report them.
pub static AGENT: LazyLock<Agent> = LazyLock::new(|| {
    Agent::config_builder()
        .max_redirects(5)
        .http_status_as_error(false)
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .into()
});

// Some picture hosts refuse requests that do not look like a browser.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) Inpaint";

/// Downloads `url` into `sink`, refusing more than `limit` bytes. Returns the lowercased content type.
pub fn download_to(url: &str, accept: &str, timeout: Duration, limit: u64, sink: &mut impl Write) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("Only http and https links can be downloaded, not {url}."));
    }
    let failed = |error: &dyn std::fmt::Display| format!("Download failed: {error}");
    let mut response = AGENT
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", accept)
        .config()
        .timeout_global(Some(timeout))
        .build()
        .call()
        .map_err(|error| failed(&error))?;
    if !response.status().is_success() {
        return Err(failed(&format!("the server answered {}", response.status())));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut reader = response.body_mut().with_config().limit(limit).reader();
    io::copy(&mut reader, sink).map_err(|error| failed(&error))?;
    Ok(content_type)
}

/// A local server answering with canned responses, for tests of code that makes requests.
#[cfg(test)]
pub(crate) mod test_server {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread::{self, JoinHandle},
    };

    /// Answers one connection per answer and returns each request's head and body as text.
    pub fn serve(answers: Vec<Vec<u8>>) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let (mut request, mut length) = (String::new(), 0);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    request.push_str(&line);
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                request.push_str(&String::from_utf8_lossy(&body));
                requests.push(request);
                stream.write_all(&answer).unwrap();
            }
            requests
        });
        (base, handle)
    }

    /// An answer that closes its connection, so every request arrives on a new one.
    pub fn answer(status: &str, headers: &[&str], body: &[u8]) -> Vec<u8> {
        let mut text = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for header in headers {
            text.push_str(header);
            text.push_str("\r\n");
        }
        text.push_str("\r\n");
        let mut bytes = text.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::{test_server::*, *};

    #[test]
    fn downloads_follow_redirects_and_send_browser_headers() {
        let (base, server) = serve(vec![
            answer("302 Found", &["Location: /picture.png"], b""),
            answer("200 OK", &["Content-Type: Image/PNG"], b"hello"),
        ]);
        let mut body = Vec::new();
        let content_type = download_to(&format!("{base}/start"), "image/*", Duration::from_secs(5), 100, &mut body).unwrap();
        assert_eq!((content_type.as_str(), body.as_slice()), ("image/png", &b"hello"[..]));
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /start ") && requests[1].starts_with("GET /picture.png "), "{requests:?}");
        let first = requests[0].to_ascii_lowercase();
        assert!(first.contains("user-agent: mozilla/5.0 (x11; linux x86_64) inpaint") && first.contains("accept: image/*"), "{first}");
    }

    #[test]
    fn downloads_report_refusals_and_limits() {
        let (base, server) = serve(vec![answer("404 Not Found", &[], b"gone"), answer("200 OK", &[], &[7; 50])]);
        let error = download_to(&format!("{base}/missing"), "*/*", Duration::from_secs(5), 100, &mut Vec::new()).unwrap_err();
        assert!(error.contains("404"), "{error}");
        let error = download_to(&format!("{base}/large"), "*/*", Duration::from_secs(5), 10, &mut Vec::new()).unwrap_err();
        assert!(error.starts_with("Download failed"), "{error}");
        server.join().unwrap();
        assert!(download_to("file:///etc/passwd", "*/*", Duration::from_secs(5), 10, &mut Vec::new()).unwrap_err().contains("Only http"));
    }
}
