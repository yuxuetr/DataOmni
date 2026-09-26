//! 走 HTTP 的两家（Elasticsearch、ClickHouse）共用的一段：根地址与带 TLS 的客户端。
//!
//! 两家的驱动都是 reqwest，差别只在请求长什么样；地址怎么经隧道、证书按哪个主机名校验、
//! 四种 TLS 模式怎么落到 rustls 上，是同一个问题。错误只分两种，由各家换成自己的码。

use crate::models::{ConnectionProfile, TlsMode};
use reqwest::{Certificate, Client, Url};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum EndpointError {
  /// 地址拼不出来、客户端建不起来。带着原因
  Unreachable(String),
  /// CA 证书文件读不了或不是证书。带着路径与原因
  CertificateFile(String),
}

#[derive(Clone)]
pub struct HttpEndpoint {
  pub host: String,
  pub port: u16,
  pub tls: TlsMode,
  pub ca_certificate_path: Option<String>,
  /// 经 SSH 隧道时本地转发的端口
  pub tunnel_port: Option<u16>,
}

impl HttpEndpoint {
  /// 隧道端口单独传，不像另外几家那样把主机换成 127.0.0.1：HTTPS 要按原来的主机名校验证书
  pub fn from_profile(profile: &ConnectionProfile, tunnel_port: Option<u16>) -> Self {
    Self {
      host: profile.host.trim().to_string(),
      port: profile.port,
      tls: profile.effective_tls_mode(),
      ca_certificate_path: profile.ca_certificate_path.clone().filter(|path| !path.is_empty()),
      tunnel_port,
    }
  }

  /// 请求发往的根地址。经隧道、主机是 IP 时只能写 127.0.0.1（`resolve` 只管域名），
  /// 这时证书按 127.0.0.1 校验，校验不过就是那句 TLS 错误
  pub fn base_url(&self) -> Result<Url, EndpointError> {
    let scheme = if self.tls == TlsMode::Disabled { "http" } else { "https" };
    let host = match (self.tunnel_port, self.host.parse::<IpAddr>()) {
      (Some(_), Ok(_)) => "127.0.0.1".to_string(),
      (_, Ok(IpAddr::V6(address))) => format!("[{address}]"),
      _ => self.host.clone(),
    };
    let port = match (self.tunnel_port, self.host.parse::<IpAddr>()) {
      (Some(local), Ok(_)) => local,
      _ => self.port,
    };
    Url::parse(&format!("{scheme}://{host}:{port}"))
      .map_err(|error| EndpointError::Unreachable(format!("{}: {error}", self.host)))
  }

  pub fn client(&self, connect_timeout: Duration) -> Result<Client, EndpointError> {
    // 不走系统代理：数据库连接是直连的，另外几家的驱动都不认代理；经隧道时连的是 127.0.0.1，
    // 被代理接走就连不到了
    let mut builder = Client::builder().no_proxy().connect_timeout(connect_timeout);
    if let (Some(local), Err(_)) = (self.tunnel_port, self.host.parse::<IpAddr>()) {
      builder = builder.resolve(&self.host, SocketAddr::from(([127, 0, 0, 1], local)));
    }
    let certificates = match (&self.ca_certificate_path, self.tls) {
      (Some(path), TlsMode::VerifyCa | TlsMode::VerifyFull) => Some(read_certificates(path)?),
      _ => None,
    };
    // `Preferred` / `Required` 只加密不校验，与另外几家一致。`VerifyCa` 校验证书链、不管主机名——
    // rustls 只在「只信这份 CA」时才肯不管主机名；没给 CA 就按完整校验，往严里走
    builder = match (self.tls, certificates) {
      (TlsMode::Disabled, _) => builder,
      (TlsMode::Preferred | TlsMode::Required, _) => builder.tls_danger_accept_invalid_certs(true),
      (TlsMode::VerifyCa, Some(certificates)) => {
        builder.tls_certs_only(certificates).tls_danger_accept_invalid_hostnames(true)
      }
      (_, Some(certificates)) => builder.tls_certs_merge(certificates),
      (_, None) => builder,
    };
    builder.build().map_err(|error| EndpointError::Unreachable(error_chain(&error)))
  }
}

/// PEM 里的全部证书（CA 文件常常是一条链）
fn read_certificates(path: &str) -> Result<Vec<Certificate>, EndpointError> {
  let pem = std::fs::read(path)
    .map_err(|error| EndpointError::CertificateFile(format!("{path}: {error}")))?;
  let certificates = Certificate::from_pem_bundle(&pem)
    .map_err(|error| EndpointError::CertificateFile(format!("{path}: {error}")))?;
  if certificates.is_empty() {
    return Err(EndpointError::CertificateFile(path.to_string()));
  }
  Ok(certificates)
}

/// reqwest 的 Display 只说「error sending request」「builder error」，原因在 source 链上
pub fn error_chain(error: &reqwest::Error) -> String {
  let mut message = error.to_string();
  let mut source = std::error::Error::source(error);
  while let Some(cause) = source {
    message = format!("{message}: {cause}");
    source = cause.source();
  }
  message
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tunnels_keep_the_host_name_for_certificates() {
    let mut endpoint = HttpEndpoint {
      host: "es.internal".to_string(),
      port: 9200,
      tls: TlsMode::VerifyFull,
      ca_certificate_path: None,
      tunnel_port: Some(40001),
    };
    // 域名：地址不变，连接经 `resolve` 落到本地端口
    assert_eq!(endpoint.base_url().unwrap().as_str(), "https://es.internal:9200/");
    // IP：`resolve` 管不到，只能直接写本地端口
    endpoint.host = "10.0.0.5".to_string();
    assert_eq!(endpoint.base_url().unwrap().as_str(), "https://127.0.0.1:40001/");
    endpoint.tunnel_port = None;
    endpoint.tls = TlsMode::Disabled;
    assert_eq!(endpoint.base_url().unwrap().as_str(), "http://10.0.0.5:9200/");
    endpoint.host = "::1".to_string();
    assert_eq!(endpoint.base_url().unwrap().as_str(), "http://[::1]:9200/");
  }
}
