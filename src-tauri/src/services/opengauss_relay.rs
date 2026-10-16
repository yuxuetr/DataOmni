//! openGauss / GaussDB 的 sha256 认证（TODOs G3）。
//!
//! 只存 sha256 口令的用户（`password_encryption_type = 2`，openGauss 的默认值），服务端发的是
//! openGauss 自己的认证请求：码 10，和 PostgreSQL 的 SASL 同一个码，内容却不是机制列表。sqlx 当成
//! SASL 去解，报 `unsupported SASL authentication mechanisms:`（列表是空的），libpq 也不认。
//!
//! 不改 sqlx：在本机开一个只给这条连接用的转发口，sqlx 连它。转发口自己去连服务端，把登录这一段
//! 做完，再把服务端的「认证成功」交给 sqlx，此后原样双向转发——sqlx 看到的是一个不要口令的服务端。
//! 只在普通连接报了上面那句之后才走这条路（`sqlx_pool::open`），PostgreSQL 与别的兼容库不受影响。
//!
//! 协议版本写成 3.51：openGauss 只在客户端声明 3.51 时才在认证请求里带上迭代次数，3.0 时它照自己存的
//! 次数算（`auth_iteration_count`，可配），客户端只能猜。只有这里改版本号，sqlx 发什么都不变。
//!
//! 算法是 openGauss 的 RFC 5802 变体（官方 JDBC 的 `RFC5802Algorithm`）：
//! `K = PBKDF2-HMAC-SHA1(口令, 盐, 迭代次数, 32)`，`ClientKey = HMAC-SHA256(K, "Client Key")`，
//! `StoredKey = SHA256(ClientKey)`，回答 `hex(HMAC-SHA256(StoredKey, token) XOR ClientKey)`。

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 普通连接撞上 sha256 认证时 sqlx 的原话（机制列表是空的）
pub fn is_sha256_rejection(error: &str) -> bool {
  error.contains("unsupported SASL authentication mechanisms")
}

/// 认证请求里的码。和 PostgreSQL 的 SASL 同一个数
const AUTH_REQUEST_SHA256: u32 = 10;
/// 口令在服务端的存法：明文（`password_encryption_type` 早年的 3）与 sha256 两种按同一个算法回答
const STORED_PLAIN: u32 = 0;
const STORED_SHA256: u32 = 2;
/// 3.51：openGauss 据此在认证请求里带上迭代次数
const PROTOCOL_3_51: u32 = (3 << 16) | 51;
const SSL_REQUEST: u32 = 80_877_103;
const GSS_ENC_REQUEST: u32 = 80_877_104;
const CANCEL_REQUEST: u32 = 80_877_102;
/// 启动包的长度上限。正常的只有几百字节；防一个坏长度让这里分配几个 GB
const MAX_STARTUP_LENGTH: usize = 10_000;

/// 转发口连谁、用什么口令登录
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Upstream {
  pub host: String,
  pub port: u16,
  pub password: String,
  pub tls: Tls,
}

/// 转发口到服务端这一段的 TLS，照连接串里的 `sslmode` 等几项，语义与 sqlx 相同：
/// `prefer` 服务端不肯就不加密，`prefer` 与 `require` 不校验证书，`verify-ca` 不核主机名
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Tls {
  pub mode: TlsMode,
  pub root_certificate: Option<String>,
  pub client_certificate: Option<String>,
  pub client_key: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TlsMode {
  Disable,
  Prefer,
  Require,
  VerifyCa,
  VerifyFull,
}

/// 由认证请求的正文（码之后的部分）算出回答。只认明文与 sha256 两种存法
pub fn sha256_response(password: &str, request: &[u8]) -> Result<Vec<u8>, String> {
  let field = |range: std::ops::Range<usize>| {
    request.get(range).ok_or_else(|| {
      format!("openGauss sha256 authentication request is only {} bytes", request.len())
    })
  };
  let stored = u32::from_be_bytes(be4(field(0..4)?));
  if stored != STORED_SHA256 && stored != STORED_PLAIN {
    return Err(format!(
      "openGauss password storage method {stored} is not supported (only sha256)"
    ));
  }
  let salt = hex_decode(field(4..68)?)?;
  let token = hex_decode(field(68..76)?)?;
  let iterations = u32::from_be_bytes(be4(field(76..80)?));

  let mut key = [0u8; 32];
  pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), &salt, iterations, &mut key);
  let client_key = hmac_sha256(&key, b"Client Key")?;
  let stored_key = Sha256::digest(&client_key);
  let signature = hmac_sha256(&stored_key, &token)?;
  let proof: String = signature
    .iter()
    .zip(&client_key)
    .map(|(left, right)| format!("{:02x}", left ^ right))
    .collect();
  Ok(proof.into_bytes())
}

fn be4(bytes: &[u8]) -> [u8; 4] {
  let mut out = [0u8; 4];
  out.copy_from_slice(&bytes[..4]);
  out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
  let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|error| error.to_string())?;
  mac.update(data);
  Ok(mac.finalize().into_bytes().to_vec())
}

fn hex_decode(text: &[u8]) -> Result<Vec<u8>, String> {
  let digit = |byte: u8| match byte {
    b'0'..=b'9' => Ok(byte - b'0'),
    b'a'..=b'f' => Ok(byte - b'a' + 10),
    b'A'..=b'F' => Ok(byte - b'A' + 10),
    _ => Err(format!("openGauss authentication request has a non-hex byte {byte:#04x}")),
  };
  text
    .chunks(2)
    .map(|pair| Ok(digit(pair[0])? << 4 | digit(*pair.get(1).unwrap_or(&b'0'))?))
    .collect()
}

/// 这个服务端的转发口，没有就开一个。同一个服务端与口令只开一个，连接池里每条连接都连它：
/// 转发口跟着应用走，不跟着池子走，数目以「连过几个这样的服务端」为上限。经 SSH 隧道时本机端口每次
/// 重连都不同，旧的那个留着空等——一个监听套接字，没有连接就不占别的

pub async fn local_port(upstream: Upstream) -> Result<u16, String> {
  static RELAYS: OnceLock<Mutex<HashMap<Upstream, u16>>> = OnceLock::new();
  let relays = RELAYS.get_or_init(Default::default);
  if let Some(port) = relays.lock().map_err(|error| error.to_string())?.get(&upstream) {
    return Ok(*port);
  }
  let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| error.to_string())?;
  let port = listener.local_addr().map_err(|error| error.to_string())?.port();
  relays.lock().map_err(|error| error.to_string())?.insert(upstream.clone(), port);
  let upstream = Arc::new(upstream);
  tokio::spawn(async move {
    loop {
      let Ok((client, _)) = listener.accept().await else {
        continue;
      };
      let upstream = Arc::clone(&upstream);
      tokio::spawn(async move {
        if let Err(error) = relay(client, &upstream).await {
          log::warn!("openGauss relay: {error}");
        }
      });
    }
  });
  Ok(port)
}

/// 客户端发来的启动包（长度在内），以及它的码
async fn read_startup(stream: &mut TcpStream) -> std::io::Result<(Vec<u8>, u32)> {
  let length = stream.read_u32().await? as usize;
  if !(8..=MAX_STARTUP_LENGTH).contains(&length) {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidData,
      format!("startup packet length {length}"),
    ));
  }
  let mut packet = vec![0u8; length];
  packet[..4].copy_from_slice(&(length as u32).to_be_bytes());
  stream.read_exact(&mut packet[4..]).await?;
  let code = u32::from_be_bytes(be4(&packet[4..8]));
  Ok((packet, code))
}

/// 服务端的一条消息（类型字节、长度在内）
async fn read_message<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<Vec<u8>> {
  let kind = stream.read_u8().await?;
  let length = stream.read_u32().await? as usize;
  if length < 4 {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidData,
      format!("message length {length}"),
    ));
  }
  let mut message = Vec::with_capacity(length + 1);
  message.push(kind);
  message.extend_from_slice(&(length as u32).to_be_bytes());
  message.resize(length + 1, 0);
  stream.read_exact(&mut message[5..]).await?;
  Ok(message)
}

/// 给 sqlx 一条它会照原样报出来的错误（28P01：口令不对一类）
fn error_response(message: &str) -> Vec<u8> {
  let mut body = Vec::new();
  for (field, value) in [(b'S', "FATAL"), (b'V', "FATAL"), (b'C', "28P01"), (b'M', message)] {
    body.push(field);
    body.extend_from_slice(value.as_bytes());
    body.push(0);
  }
  body.push(0);
  let mut packet = vec![b'E'];
  packet.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
  packet.extend(body);
  packet
}

async fn relay(mut client: TcpStream, upstream: &Upstream) -> std::io::Result<()> {
  // sqlx 连转发口时按 `sslmode=disable` 不会先问 TLS；`prefer` 一类的客户端问了就答「不用」
  let (mut startup, mut code) = read_startup(&mut client).await?;
  while code == SSL_REQUEST || code == GSS_ENC_REQUEST {
    client.write_all(b"N").await?;
    (startup, code) = read_startup(&mut client).await?;
  }
  let mut server = match connect(upstream).await {
    Ok(server) => server,
    // 说给 sqlx 听：它等的是启动包的回答，一条错误消息会原样成为连接失败的原因
    Err(error) => {
      let reason = format!("openGauss relay could not reach the server: {error}");
      if code != CANCEL_REQUEST {
        client.write_all(&error_response(&reason)).await?;
      }
      return Err(std::io::Error::other(reason));
    }
  };
  if code == CANCEL_REQUEST {
    return server.write_all(&startup).await;
  }
  startup[4..8].copy_from_slice(&PROTOCOL_3_51.to_be_bytes());
  server.write_all(&startup).await?;
  authenticate(&mut client, &mut server, &upstream.password).await?;
  tokio::io::copy_bidirectional(&mut client, &mut server).await.map(|_| ())
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// 连上服务端，按 `sslmode` 先问 TLS（与 sqlx 的 `maybe_upgrade` 同一个流程）
async fn connect(upstream: &Upstream) -> Result<Box<dyn Stream>, String> {
  let mut tcp = TcpStream::connect((upstream.host.as_str(), upstream.port))
    .await
    .map_err(|error| error.to_string())?;
  if upstream.tls.mode == TlsMode::Disable {
    return Ok(Box::new(tcp));
  }
  let mut request = 8u32.to_be_bytes().to_vec();
  request.extend(SSL_REQUEST.to_be_bytes());
  tcp.write_all(&request).await.map_err(|error| error.to_string())?;
  match tcp.read_u8().await.map_err(|error| error.to_string())? {
    b'S' => {}
    b'N' if upstream.tls.mode == TlsMode::Prefer => return Ok(Box::new(tcp)),
    b'N' => return Err("server does not support TLS".to_string()),
    other => return Err(format!("unexpected response from SSLRequest: {other:#04x}")),
  }
  let config = tls_config(&upstream.tls)?;
  let name = rustls::pki_types::ServerName::try_from(upstream.host.clone())
    .map_err(|error| error.to_string())?;
  let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
    .connect(name, tcp)
    .await
    .map_err(|error| error.to_string())?;
  Ok(Box::new(stream))
}

/// 照 sqlx 的 `tls_rustls::handshake` 配：同一个加密实现（ring）、同一套根证书（webpki-roots
/// 加上 `sslrootcert`）、同样三档校验
fn tls_config(tls: &Tls) -> Result<rustls::ClientConfig, String> {
  use rustls::pki_types::pem::PemObject;
  use rustls::pki_types::{CertificateDer, PrivateKeyDer};

  let provider = Arc::new(rustls::crypto::ring::default_provider());
  let builder = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
    .with_safe_default_protocol_versions()
    .map_err(|error| error.to_string())?;
  let read = |path: &str| std::fs::read(path).map_err(|error| format!("{path}: {error}"));
  let client_auth = match (&tls.client_certificate, &tls.client_key) {
    (Some(certificate), Some(key)) => {
      let chain = CertificateDer::pem_slice_iter(&read(certificate)?)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("{certificate}: {error}"))?;
      let key =
        PrivateKeyDer::from_pem_slice(&read(key)?).map_err(|error| format!("{key}: {error}"))?;
      Some((chain, key))
    }
    (None, None) => None,
    _ => return Err("user auth key and certs must be given together".to_string()),
  };

  let verifier: Arc<dyn rustls::client::danger::ServerCertVerifier> = match tls.mode {
    TlsMode::Disable | TlsMode::Prefer | TlsMode::Require => Arc::new(AnyCertificate(provider)),
    TlsMode::VerifyCa | TlsMode::VerifyFull => {
      let mut roots =
        rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
      if let Some(path) = &tls.root_certificate {
        for certificate in CertificateDer::pem_slice_iter(&read(path)?) {
          let certificate = certificate.map_err(|error| format!("{path}: {error}"))?;
          roots.add(certificate).map_err(|error| format!("{path}: {error}"))?;
        }
      }
      let webpki =
        rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
          .build()
          .map_err(|error| error.to_string())?;
      match tls.mode {
        TlsMode::VerifyCa => Arc::new(AnyHostname(webpki)),
        _ => webpki,
      }
    }
  };
  let builder = builder.dangerous().with_custom_certificate_verifier(verifier);
  match client_auth {
    Some((chain, key)) => {
      builder.with_client_auth_cert(chain, key).map_err(|error| error.to_string())
    }
    None => Ok(builder.with_no_client_auth()),
  }
}

/// `prefer` / `require`：加密，不校验证书（sqlx 的 `DummyTlsVerifier`）。握手签名照常验
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
  fn verify_server_cert(
    &self,
    _end_entity: &rustls::pki_types::CertificateDer<'_>,
    _intermediates: &[rustls::pki_types::CertificateDer<'_>],
    _server_name: &rustls::pki_types::ServerName<'_>,
    _ocsp_response: &[u8],
    _now: rustls::pki_types::UnixTime,
  ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
    Ok(rustls::client::danger::ServerCertVerified::assertion())
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    certificate: &rustls::pki_types::CertificateDer<'_>,
    signature: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls12_signature(
      message,
      certificate,
      signature,
      &self.0.signature_verification_algorithms,
    )
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    certificate: &rustls::pki_types::CertificateDer<'_>,
    signature: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls13_signature(
      message,
      certificate,
      signature,
      &self.0.signature_verification_algorithms,
    )
  }

  fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
    self.0.signature_verification_algorithms.supported_schemes()
  }
}

/// `verify-ca`：校验证书链，不核主机名（sqlx 的 `NoHostnameTlsVerifier`）
#[derive(Debug)]
struct AnyHostname(Arc<rustls::client::WebPkiServerVerifier>);

impl rustls::client::danger::ServerCertVerifier for AnyHostname {
  fn verify_server_cert(
    &self,
    end_entity: &rustls::pki_types::CertificateDer<'_>,
    intermediates: &[rustls::pki_types::CertificateDer<'_>],
    server_name: &rustls::pki_types::ServerName<'_>,
    ocsp_response: &[u8],
    now: rustls::pki_types::UnixTime,
  ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
    match self.0.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now) {
      Err(rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName)) => {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
      }
      verdict => verdict,
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    certificate: &rustls::pki_types::CertificateDer<'_>,
    signature: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    self.0.verify_tls12_signature(message, certificate, signature)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    certificate: &rustls::pki_types::CertificateDer<'_>,
    signature: &rustls::DigitallySignedStruct,
  ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
    self.0.verify_tls13_signature(message, certificate, signature)
  }

  fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
    self.0.supported_verify_schemes()
  }
}

/// 答掉 sha256 的认证请求；别的消息（认证成功、报错、其他认证方式）原样交给客户端，此后的事归它
async fn authenticate<C, S>(client: &mut C, server: &mut S, password: &str) -> std::io::Result<()>
where
  C: AsyncWrite + Unpin,
  S: AsyncRead + AsyncWrite + Unpin,
{
  loop {
    let message = read_message(server).await?;
    let is_sha256 = message[0] == b'R'
      && message.len() >= 9
      && u32::from_be_bytes(be4(&message[5..9])) == AUTH_REQUEST_SHA256;
    if !is_sha256 {
      return client.write_all(&message).await;
    }
    match sha256_response(password, &message[9..]) {
      Ok(proof) => {
        let mut answer = vec![b'p'];
        answer.extend_from_slice(&((proof.len() + 5) as u32).to_be_bytes());
        answer.extend(proof);
        answer.push(0);
        server.write_all(&answer).await?;
      }
      Err(reason) => return client.write_all(&error_response(&reason)).await,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 期望值由 Node 的 crypto 按官方驱动的算法独立算出（`pbkdf2Sync(…, 'sha1')` 与两次 HMAC-SHA256）
  #[test]
  fn answers_like_the_reference_implementation() {
    let mut request = STORED_SHA256.to_be_bytes().to_vec();
    request.extend(format!("3f2a{}beef", "0".repeat(56)).as_bytes());
    request.extend(b"a1b2c3d4");
    request.extend(10_000u32.to_be_bytes());
    let proof = sha256_response("Test@123", &request).expect("answer");
    assert_eq!(
      String::from_utf8(proof).expect("hex"),
      "5563331295fc62e3ed709545b53caa69845010319eadb1aa6c8e8efd32ed45f0"
    );
  }

  #[test]
  fn refuses_short_requests_and_md5_storage() {
    // 3.0 的请求里没有迭代次数；转发口总是声明 3.51，真碰上就说清楚，不猜次数
    let mut request = STORED_SHA256.to_be_bytes().to_vec();
    request.extend([b'0'; 72]);
    assert!(sha256_response("p", &request).is_err());
    let mut md5 = 1u32.to_be_bytes().to_vec();
    md5.extend([b'0'; 76]);
    assert!(sha256_response("p", &md5).expect_err("md5").contains("method 1"));
  }

  #[test]
  fn recognizes_the_driver_message() {
    assert!(is_sha256_rejection(
      "error returned from database: unsupported SASL authentication mechanisms: "
    ));
    assert!(!is_sha256_rejection("password authentication failed for user \"u\""));
  }
}
