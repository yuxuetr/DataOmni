//! 调一次大模型：只有两种协议——Anthropic Messages 与 OpenAI 兼容的 Chat Completions。
//!
//! 国内常用的模型服务（DeepSeek、通义千问、智谱、Kimi）与本地的 Ollama 都给 OpenAI 兼容接口，
//! 所以两种就覆盖了（rfcs/editions-and-branching.md §6）。整个模块在 Cargo feature `ai` 后面：
//! 不开这个 feature 的构建里没有任何发往模型服务的代码。
//!
//! 这里只管「把一段系统提示和一段用户输入发出去、拿回文本」。发什么由前端的
//! `utils/aiDesign.ts` 决定，并原样展示给人看。

use crate::services::QueryError;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use std::time::Duration;

pub const AI_REQUEST_FAILED: &str = "DATAOMNI_AI_REQUEST_FAILED";
pub const AI_BAD_RESPONSE: &str = "DATAOMNI_AI_BAD_RESPONSE";

/// 一份设计十来张表、上百列，输出要几千个 token；A0 实验里单次中位数 4.6 秒，
/// 慢的模型再翻几倍。超过两分钟多半是服务端卡住了
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Anthropic 要求显式给上限。一份设计远用不到这么多，给足是为了不在半截 JSON 处被截断
const MAX_OUTPUT_TOKENS: u32 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProtocol {
  Anthropic,
  Openai,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
  pub protocol: AiProtocol,
  /// Anthropic 写到域名（`https://api.anthropic.com`）；OpenAI 兼容写到 `/chat/completions`
  /// 之前那一段（`https://api.deepseek.com`、`http://localhost:11434/v1`），各家文档给的就是这一段
  pub base_url: String,
  pub model: String,
  pub system: String,
  pub user: String,
}

pub async fn complete(request: &AiRequest, api_key: &str) -> Result<String, QueryError> {
  // 生产环境不关代理：模型服务在公网上，很多人正是靠代理才连得上
  let client = reqwest::Client::builder()
    .timeout(REQUEST_TIMEOUT)
    .build()
    .map_err(|error| QueryError::message(format!("{AI_REQUEST_FAILED}: {error}")))?;
  complete_with(&client, request, api_key).await
}

pub async fn complete_with(
  client: &reqwest::Client,
  request: &AiRequest,
  api_key: &str,
) -> Result<String, QueryError> {
  let base = request.base_url.trim().trim_end_matches('/');
  let (builder, body) = match request.protocol {
    AiProtocol::Anthropic => (
      client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01"),
      json!({
        "model": request.model,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "system": request.system,
        "messages": [{ "role": "user", "content": request.user }],
      }),
    ),
    // 不发 `response_format`：OpenAI 兼容的各家不是都认，不认的直接 400。
    // 提示里已经要求只输出 JSON，读的那一侧也容忍一层代码块
    AiProtocol::Openai => (
      client.post(format!("{base}/chat/completions")).bearer_auth(api_key),
      json!({
        "model": request.model,
        "messages": [
          { "role": "system", "content": request.system },
          { "role": "user", "content": request.user },
        ],
      }),
    ),
  };

  // reqwest 没开 `json` feature（别处用不上），请求体手写序列化
  let response = builder
    .header("content-type", "application/json")
    .body(body.to_string())
    .send()
    .await
    .map_err(|error| QueryError::message(format!("{AI_REQUEST_FAILED}: {error}")))?;
  let status = response.status();
  let body = response
    .text()
    .await
    .map_err(|error| QueryError::message(format!("{AI_REQUEST_FAILED}: {error}")))?;
  if !status.is_success() {
    // 服务端的原话最有用（Key 错、模型名错、余额不足），截一段带上
    return Err(QueryError::message(format!(
      "{AI_REQUEST_FAILED}: HTTP {} · {}",
      status.as_u16(),
      body.chars().take(500).collect::<String>()
    )));
  }
  let value: JsonValue = serde_json::from_str(&body)
    .map_err(|error| QueryError::message(format!("{AI_BAD_RESPONSE}: {error}")))?;
  response_text(request.protocol, &value).ok_or_else(|| {
    QueryError::message(format!(
      "{AI_BAD_RESPONSE}: {}",
      body.chars().take(500).collect::<String>()
    ))
  })
}

/// 两家回复里放文本的位置。Anthropic 的 `content` 是分块的数组，只取 text 块拼起来
fn response_text(protocol: AiProtocol, value: &JsonValue) -> Option<String> {
  match protocol {
    AiProtocol::Anthropic => {
      let blocks = value.get("content")?.as_array()?;
      let text = blocks
        .iter()
        .filter(|block| block.get("type").and_then(JsonValue::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(JsonValue::as_str))
        .collect::<String>();
      (!text.is_empty()).then_some(text)
    }
    AiProtocol::Openai => {
      value.get("choices")?.get(0)?.get("message")?.get("content")?.as_str().map(str::to_string)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Read, Write};
  use std::net::TcpListener;

  /// 起一个只回一次的 HTTP 服务，返回地址和「收到的请求原文」
  fn serve_once(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = format!("http://{}", listener.local_addr().expect("addr"));
    let response =
      format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
    let handle = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().expect("accept");
      let mut received = Vec::new();
      let mut buffer = [0u8; 4096];
      // 读到请求体收齐为止：头里有 content-length
      loop {
        let read = stream.read(&mut buffer).expect("read");
        received.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&received).to_string();
        if let Some((head, rest)) = text.split_once("\r\n\r\n") {
          let length = head
            .lines()
            .find_map(|line| {
              line.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_string)
            })
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
          if rest.len() >= length {
            break;
          }
        }
        if read == 0 {
          break;
        }
      }
      stream.write_all(response.as_bytes()).expect("write");
      String::from_utf8_lossy(&received).to_string()
    });
    (address, handle)
  }

  fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().expect("test client")
  }

  fn request(protocol: AiProtocol, base_url: String) -> AiRequest {
    AiRequest {
      protocol,
      base_url,
      model: "m-1".into(),
      system: "只输出 JSON".into(),
      user: "博客".into(),
    }
  }

  #[tokio::test]
  async fn openai_compatible_sends_bearer_and_reads_the_first_choice() {
    let (base, server) = serve_once(
      "200 OK",
      r#"{"choices":[{"message":{"role":"assistant","content":"{\"tables\":[]}"}}]}"#,
    );
    let text =
      complete_with(&client(), &request(AiProtocol::Openai, format!("{base}/v1/")), "sk-test")
        .await
        .expect("complete");
    assert_eq!(text, r#"{"tables":[]}"#);
    let received = server.join().expect("server");
    assert!(received.starts_with("POST /v1/chat/completions "), "{received}");
    assert!(received.to_ascii_lowercase().contains("authorization: bearer sk-test"));
    assert!(received.contains(r#""role":"system","content":"只输出 JSON""#), "{received}");
    assert!(!received.contains("response_format"), "不是每家都认 response_format");
  }

  #[tokio::test]
  async fn anthropic_sends_its_headers_and_joins_the_text_blocks() {
    let (base, server) = serve_once(
      "200 OK",
      r#"{"content":[{"type":"text","text":"{\"tables\":"},{"type":"thinking","thinking":"x"},{"type":"text","text":"[]}"}]}"#,
    );
    let text = complete_with(&client(), &request(AiProtocol::Anthropic, base), "sk-ant")
      .await
      .expect("complete");
    assert_eq!(text, r#"{"tables":[]}"#);
    let received = server.join().expect("server").to_ascii_lowercase();
    assert!(received.starts_with("post /v1/messages "), "{received}");
    assert!(received.contains("x-api-key: sk-ant"));
    assert!(received.contains("anthropic-version: 2023-06-01"));
    assert!(received.contains(r#""max_tokens":8192"#));
  }

  #[tokio::test]
  async fn a_server_error_carries_the_status_and_what_the_server_said() {
    let (base, server) =
      serve_once("401 Unauthorized", r#"{"error":{"message":"Invalid API key"}}"#);
    let error = complete_with(&client(), &request(AiProtocol::Openai, base), "bad")
      .await
      .expect_err("should fail");
    server.join().expect("server");
    assert!(error.message.starts_with(AI_REQUEST_FAILED), "{}", error.message);
    assert!(error.message.contains("HTTP 401"));
    assert!(error.message.contains("Invalid API key"));
  }

  #[tokio::test]
  async fn a_reply_without_text_is_a_bad_response_not_an_empty_design() {
    let (base, server) = serve_once("200 OK", r#"{"choices":[]}"#);
    let error = complete_with(&client(), &request(AiProtocol::Openai, base), "k")
      .await
      .expect_err("should fail");
    server.join().expect("server");
    assert!(error.message.starts_with(AI_BAD_RESPONSE), "{}", error.message);
  }
}
