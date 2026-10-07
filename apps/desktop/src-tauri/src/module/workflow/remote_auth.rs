//! Authentication is resolved from local configuration, never from workflow State.
use crate::config::{IWorkrun, RemoteCredentialKind, decrypt_data, remote_credential_origin};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri_plugin_http::reqwest::{
    Client,
    header::{HeaderMap, HeaderName, HeaderValue},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteAuthentication {
    None,
    Bearer { credential_id: String },
    ApiKey { credential_id: String, header_name: String },
}

#[derive(Clone, Default)]
pub(super) struct RemoteAuth {
    kind: Option<RemoteCredentialKind>,
    header_name: Option<String>,
    secret: Option<String>,
}

pub(crate) fn validate_remote_secret(kind: &RemoteCredentialKind, secret: &str) -> Result<()> {
    if secret.is_empty() || secret.len() > 8192 || !secret.bytes().all(|b| b.is_ascii_graphic() || b == b' ') {
        bail!("Credential must be nonempty printable ASCII without control characters (maximum 8192 bytes)");
    }
    if *kind == RemoteCredentialKind::Bearer && secret.contains(' ') {
        bail!("Enter only the Bearer token, without a prefix or spaces");
    }
    Ok(())
}

fn api_header(name: &str) -> Result<HeaderName> {
    let header = HeaderName::from_bytes(name.as_bytes()).context("Invalid API Key header name")?;
    if matches!(
        header.as_str(),
        "host"
            | "content-length"
            | "content-type"
            | "transfer-encoding"
            | "connection"
            | "cookie"
            | "accept"
            | "te"
            | "trailer"
            | "upgrade"
    ) || header.as_str().starts_with("a2a-")
        || header.as_str().starts_with("proxy-")
        || header.as_str().starts_with("sec-")
    {
        bail!("API Key header cannot override transport, routing or protocol headers");
    }
    Ok(header)
}

impl RemoteAuth {
    pub(super) fn resolve(auth: Option<&RemoteAuthentication>, url: &str, config: &IWorkrun) -> Result<Self> {
        Self::resolve_with(auth, url, config, |encrypted| {
            decrypt_data(encrypted)
                .map_err(|_| anyhow::anyhow!("Cannot decrypt A2A credential; save it again on this installation"))
        })
    }

    fn resolve_with(
        auth: Option<&RemoteAuthentication>,
        url: &str,
        config: &IWorkrun,
        decrypt: impl FnOnce(&str) -> Result<String>,
    ) -> Result<Self> {
        let (id, kind, header) = match auth {
            None | Some(RemoteAuthentication::None) => return Ok(Self::default()),
            Some(RemoteAuthentication::Bearer { credential_id }) => {
                (credential_id, RemoteCredentialKind::Bearer, "authorization".to_string())
            },
            Some(RemoteAuthentication::ApiKey {
                credential_id,
                header_name,
            }) => (
                credential_id,
                RemoteCredentialKind::ApiKey,
                api_header(header_name)?.to_string(),
            ),
        };
        let origin = remote_credential_origin(url)?;
        let credential = config
            .remote_agent_credentials
            .iter()
            .find(|c| &c.id == id)
            .context("A2A credential missing; select a local credential on this installation")?;
        if credential.kind != kind {
            bail!("A2A credential type does not match the node's authentication mode");
        }
        if credential.origin != origin {
            bail!("A2A credential is bound to a different service origin");
        }
        let secret = decrypt(&credential.encrypted_secret)?;
        validate_remote_secret(&kind, &secret)?;
        Ok(Self {
            kind: Some(kind),
            header_name: Some(header),
            secret: Some(secret),
        })
    }

    #[cfg(test)]
    pub(super) fn testing(kind: Option<RemoteCredentialKind>) -> Self {
        Self {
            header_name: kind.as_ref().map(|k| {
                if *k == RemoteCredentialKind::Bearer {
                    "authorization".into()
                } else {
                    "x-api-key".into()
                }
            }),
            secret: kind.as_ref().map(|_| "test-secret".into()),
            kind,
        }
    }

    pub(super) fn client(&self) -> Result<Client> {
        let mut headers = HeaderMap::new();
        if let Some(secret) = &self.secret {
            let name = HeaderName::from_bytes(self.header_name.as_ref().unwrap().as_bytes())?;
            let value = if self.kind == Some(RemoteCredentialKind::Bearer) {
                format!("Bearer {secret}")
            } else {
                secret.clone()
            };
            let mut value =
                HeaderValue::from_str(&value).map_err(|_| anyhow::anyhow!("Invalid A2A credential header value"))?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        Ok(Client::builder()
            .default_headers(headers)
            .redirect(tauri_plugin_http::reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()?)
    }

    pub(super) fn validate_card(&self, card: &Value) -> Result<()> {
        let Some(requirements) = card.get("securityRequirements") else {
            return Ok(());
        };
        let requirements = requirements.as_array().context("Invalid A2A security requirements")?;
        if requirements.is_empty() {
            return Ok(());
        }
        // Requirement alternatives are OR; all schemes inside one alternative
        // are AND. This phase has one credential, so multi-scheme alternatives
        // cannot be satisfied by matching only one of their entries.
        for requirement in requirements {
            let requirement = requirement.as_object().context("Invalid A2A security requirement")?;
            let empty = serde_json::Map::new();
            let schemes = match requirement.get("schemes") {
                Some(value) => value.as_object().context("Invalid A2A requirement schemes")?,
                None if requirement.is_empty() => &empty,
                None => bail!("Invalid v1.0.1 security requirement: expected schemes"),
            };
            if schemes.is_empty() {
                return Ok(());
            }
            if schemes.len() != 1 {
                continue;
            }
            let (name, scopes) = schemes.iter().next().unwrap();
            let scopes = scopes.as_object().context("Invalid A2A security scopes")?;
            if let Some(list) = scopes.get("list") {
                let list = list.as_array().context("Invalid A2A security scope list")?;
                if list.iter().any(|scope| !scope.is_string()) {
                    bail!("Invalid A2A security scope value");
                }
            }
            if scopes
                .get("list")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
            {
                continue;
            }
            let Some(scheme) = card.get("securitySchemes").and_then(|s| s.get(name)) else {
                continue;
            };
            let variants = [
                "httpAuthSecurityScheme",
                "apiKeySecurityScheme",
                "oauth2SecurityScheme",
                "openIdConnectSecurityScheme",
                "mtlsSecurityScheme",
            ];
            if variants
                .iter()
                .filter(|variant| scheme.get(**variant).is_some())
                .count()
                != 1
            {
                continue;
            }
            let matched = match self.kind {
                Some(RemoteCredentialKind::Bearer) => scheme
                    .get("httpAuthSecurityScheme")
                    .and_then(|s| s.get("scheme"))
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.eq_ignore_ascii_case("bearer")),
                Some(RemoteCredentialKind::ApiKey) => scheme.get("apiKeySecurityScheme").is_some_and(|s| {
                    s.get("location").and_then(Value::as_str) == Some("header")
                        && s.get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| self.header_name.as_ref().is_some_and(|h| name.eq_ignore_ascii_case(h)))
                }),
                None => false,
            };
            if matched {
                return Ok(());
            }
        }
        bail!(
            "Configured A2A authentication does not satisfy Agent Card requirements (supported: Bearer or header API Key)"
        )
    }

    pub(super) fn redact(&self, value: &str) -> String {
        match &self.secret {
            Some(secret) => value.replace(secret, "[REDACTED]"),
            None => value.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{RemoteAgentCredential, decrypt_data_with_key, encrypt_data_with_key};
    use serde_json::json;

    #[test]
    fn encrypted_configuration_roundtrip_resolves_only_matching_local_reference() {
        let key = [7u8; 32];
        let config = IWorkrun {
            remote_agent_credentials: vec![RemoteAgentCredential {
                id: "credential-id".into(),
                name: "Production service".into(),
                kind: RemoteCredentialKind::Bearer,
                origin: "https://agent.example".into(),
                encrypted_secret: encrypt_data_with_key("test-secret", &key).unwrap(),
            }],
            ..Default::default()
        };
        let yaml = serde_yaml_ng::to_string(&config).unwrap();
        assert!(!yaml.contains("test-secret"));
        assert!(!format!("{:?}", config).contains("test-secret"));
        let config: IWorkrun = serde_yaml_ng::from_str(&yaml).unwrap();
        let summaries = config
            .remote_agent_credentials
            .iter()
            .map(|c| c.summary())
            .collect::<Vec<_>>();
        let public = serde_json::to_string(&summaries).unwrap();
        assert!(!public.contains("encryptedSecret"));
        assert!(!public.contains("test-secret"));
        let auth = RemoteAuthentication::Bearer {
            credential_id: "credential-id".into(),
        };
        let encoded = serde_json::to_string(&auth).unwrap();
        assert!(!encoded.contains("test-secret"));
        let decrypt =
            |encrypted: &str| decrypt_data_with_key(encrypted, &key).map_err(|_| anyhow::anyhow!("Cannot decrypt"));
        let resolved = RemoteAuth::resolve_with(Some(&auth), "https://agent.example/path", &config, decrypt).unwrap();
        assert_eq!(resolved.redact("Server echoed test-secret"), "Server echoed [REDACTED]");
        assert!(RemoteAuth::resolve_with(Some(&auth), "https://other.example", &config, decrypt).is_err());
        let missing = RemoteAuthentication::Bearer {
            credential_id: "missing".into(),
        };
        assert!(RemoteAuth::resolve_with(Some(&missing), "https://agent.example", &config, decrypt).is_err());
        let wrong = RemoteAuthentication::ApiKey {
            credential_id: "credential-id".into(),
            header_name: "X-API-Key".into(),
        };
        assert!(RemoteAuth::resolve_with(Some(&wrong), "https://agent.example", &config, decrypt).is_err());
        assert!(
            serde_json::from_value::<RemoteAuthentication>(
                json!({"type":"bearer","credentialId":"id","token":"plaintext"})
            )
            .is_err()
        );
    }

    fn card(requirements: Value) -> Value {
        json!({"securitySchemes":{
            "bearer":{"httpAuthSecurityScheme":{"scheme":"Bearer"}},
            "key":{"apiKeySecurityScheme":{"location":"header","name":"X-API-Key"}},
            "query":{"apiKeySecurityScheme":{"location":"query","name":"key"}},
            "oauth":{"oauth2SecurityScheme":{"flows":{}}}
        },"securityRequirements":requirements})
    }

    #[test]
    fn security_requirements_honor_or_and_header_names_and_supported_schemes() {
        let none = RemoteAuth::default();
        let bearer = RemoteAuth::testing(Some(RemoteCredentialKind::Bearer));
        let key = RemoteAuth::testing(Some(RemoteCredentialKind::ApiKey));
        let single = card(json!([{"schemes":{"bearer":{}}}]));
        assert!(bearer.validate_card(&single).is_ok());
        assert!(none.validate_card(&single).is_err());
        assert!(key.validate_card(&single).is_err());
        let alternatives = card(json!([{"schemes":{"bearer":{}}},{"schemes":{"key":{"list":[]}}}]));
        assert!(bearer.validate_card(&alternatives).is_ok());
        assert!(key.validate_card(&alternatives).is_ok());
        let combined = card(json!([{"schemes":{"bearer":{},"key":{}}}]));
        assert!(bearer.validate_card(&combined).is_err());
        assert!(key.validate_card(&combined).is_err());
        assert!(
            bearer
                .validate_card(&card(json!([{"schemes":{"bearer":null}}])))
                .is_err()
        );
        let mut invalid_union = single.clone();
        invalid_union["securitySchemes"]["bearer"]["oauth2SecurityScheme"] = json!({"flows":{}});
        assert!(bearer.validate_card(&invalid_union).is_err());
        assert!(none.validate_card(&card(json!([{}]))).is_ok());
        assert!(none.validate_card(&card(json!([{"schemes":{}}]))).is_ok());
        for scheme in ["query", "oauth", "unknown"] {
            assert!(key.validate_card(&card(json!([{"schemes":{(scheme):{}}}]))).is_err());
        }
        assert!(
            bearer
                .validate_card(&card(json!([{"schemes":{"bearer":{"list":["scope"]}}}])))
                .is_err()
        );
        let mut wrong = card(json!([{"schemes":{"key":{}}}]));
        wrong["securitySchemes"]["key"]["apiKeySecurityScheme"]["name"] = json!("Other-Key");
        assert!(key.validate_card(&wrong).is_err());
    }

    #[test]
    fn headers_and_credential_transport_reject_injection_and_routing_overrides() {
        for header in [
            "Host",
            "Content-Length",
            "Content-Type",
            "Connection",
            "A2A-Version",
            "Cookie",
            "Proxy-Authorization",
            "Sec-Fetch-Site",
            "X-Key\r\nHost: evil",
        ] {
            assert!(api_header(header).is_err(), "{header}");
        }
        assert_eq!(api_header("X-API-Key").unwrap().as_str(), "x-api-key");
        for secret in ["", "token\r\nX-Key: value", "token\0", "Bearer token"] {
            assert!(validate_remote_secret(&RemoteCredentialKind::Bearer, secret).is_err());
        }
        assert!(crate::config::remote_credential_origin("http://example.com").is_err());
        assert!(crate::config::remote_credential_origin("http://127.0.0.1:8088").is_ok());
        assert!(crate::config::remote_credential_origin("http://[::1]:8088").is_ok());
        assert!(crate::config::remote_credential_origin("https://user:secret@example.com").is_err());
        assert!(crate::config::remote_credential_origin("https://example.com?token=secret").is_err());
    }
}
