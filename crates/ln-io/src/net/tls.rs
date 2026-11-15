//! rustls wiring: one cached [`ClientConfig`]/[`ServerConfig`] per distinct option set.
//!
//! TLS is a **transport wrapper**, not a third protocol (ADR-0006 §2.9). A connection that asked
//! for TLS performs its handshake inside its own task — the connect task for a client, the
//! per-accepted-connection child task for a server, so a slow or hostile handshake can never stall
//! the accept loop — and afterwards hands the two directions to the same [`Connection`] state
//! machine as a plain socket. Nothing in `connection.rs` names a rustls type: it sees
//! `transport::Reader`/`Writer`, exactly like TCP and Unix.
//!
//! [`Connection`]: super::connection::Connection
//!
//! ## Why a process-wide cache
//!
//! A `https.Agent` with `maxSockets: 100` opens 100 connections with the *same* options. Parsing
//! the PEM chain, building the root store and assembling a `rustls::ClientConfig` costs hundreds of
//! microseconds and several allocations, per socket. The cache is keyed by a content hash of the
//! options a caller actually supplied — not by handle — so one `Agent` builds one config, and two
//! callers with equal options share it. It is lazy: nothing here runs until the first TLS
//! connection exists, which is what keeps cold start unchanged (m4-plan §8).
//!
//! ## What is deliberately not here
//!
//! No renegotiation (rustls does not implement it), no session resumption/tickets beyond rustls'
//! defaults, no client certificates, no per-connection `minVersion`/`maxVersion`, and no `ca`
//! *replacement*: an explicit `ca` is **appended** to the bundled Mozilla roots rather than
//! replacing them, unlike OpenSSL. These are recorded in `docs/compat.md` D41.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ln_error::NodeError;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, ProtocolVersion, RootCertStore,
    ServerConfig, SignatureScheme,
};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::error::from_io;
use super::transport::{TlsKind, Transport};
use super::TlsClientOptions;
use super::TlsServerOptions;

/// Cache key salt. Bump when the *meaning* of the options changes (a new field joins the hash, a
/// default changes), so a stale cached config can never outlive the code that built it.
const CONFIG_SALT: u64 = 1;

/// Process-wide client configs, keyed by [`client_key`]. `OnceLock` so the map itself costs
/// nothing until the first TLS connection.
static CLIENT_CONFIGS: OnceLock<Mutex<HashMap<u64, Arc<ClientConfig>>>> = OnceLock::new();
/// Process-wide server configs, keyed by [`server_key`].
static SERVER_CONFIGS: OnceLock<Mutex<HashMap<u64, Arc<ServerConfig>>>> = OnceLock::new();

/// Poisoning only means another task panicked while holding the map. Every mutation is a single
/// insert, so the map is consistent; recover instead of panicking a second time.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Content hashes
// ---------------------------------------------------------------------------

/// A content hash of the client options that affect the built config.
///
/// `servername` is **not** part of it: the name is supplied per connection to
/// `TlsConnector::connect`, so two connections to different names share one config, exactly like
/// Node's `SecureContext` cache.
fn client_key(options: &TlsClientOptions) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    CONFIG_SALT.hash(&mut hasher);
    b"client".hash(&mut hasher);
    options.reject_unauthorized.hash(&mut hasher);
    options.ca_pem.hash(&mut hasher);
    options.alpn.hash(&mut hasher);
    hasher.finish()
}

fn server_key(options: &TlsServerOptions) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    CONFIG_SALT.hash(&mut hasher);
    b"server".hash(&mut hasher);
    options.cert_pem.hash(&mut hasher);
    options.key_pem.hash(&mut hasher);
    options.alpn.hash(&mut hasher);
    hasher.finish()
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

/// The cached `ClientConfig` for `options`, building it on first use.
pub(crate) fn client_config(options: &TlsClientOptions) -> Result<Arc<ClientConfig>, NodeError> {
    let key = client_key(options);
    let configs = CLIENT_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(config) = lock(configs).get(&key) {
        return Ok(config.clone());
    }
    let config = Arc::new(build_client_config(options)?);
    // A concurrent task may have won the race; either config is equivalent by construction.
    Ok(lock(configs).entry(key).or_insert(config).clone())
}

/// The cached `ServerConfig` for `options`, building it on first use.
///
/// A malformed chain or key is `ERR_TLS_INVALID_CERT`/`ERR_TLS_INVALID_KEY`, never a panic: the
/// listener turns it into the server's `error` event (m4-plan §4).
pub(crate) fn server_config(options: &TlsServerOptions) -> Result<Arc<ServerConfig>, NodeError> {
    let key = server_key(options);
    let configs = SERVER_CONFIGS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(config) = lock(configs).get(&key) {
        return Ok(config.clone());
    }
    let config = Arc::new(build_server_config(options)?);
    Ok(lock(configs).entry(key).or_insert(config).clone())
}

/// Node's default trust anchors (the bundled Mozilla store), plus an explicit `ca` **appended**.
fn build_client_config(options: &TlsClientOptions) -> Result<ClientConfig, NodeError> {
    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    if let Some(pem) = options.ca_pem.as_deref() {
        for certificate in parse_certificates(pem, "ERR_TLS_CA_INVALID", "options.ca")? {
            roots
                .add(certificate)
                .map_err(|error| invalid_ca(error.to_string()))?;
        }
    }

    let provider = Arc::new(ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| {
            NodeError::new(
                "ERR_TLS_INVALID_CONFIG",
                format!("no usable TLS protocol version: {error}"),
            )
        })?;
    let mut config = if options.reject_unauthorized {
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        // `rejectUnauthorized: false`: the handshake succeeds for any chain and any name. The
        // signature checks still run (they prove the peer holds the key it presented), only the
        // chain/name validation is skipped — the same split OpenSSL's `SSL_VERIFY_NONE` makes.
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCertificate::new(provider)))
            .with_no_client_auth()
    };
    config.alpn_protocols = alpn_wire(&options.alpn);
    Ok(config)
}

fn build_server_config(options: &TlsServerOptions) -> Result<ServerConfig, NodeError> {
    let certificates =
        parse_certificates(&options.cert_pem, "ERR_TLS_INVALID_CERT", "options.cert")?;
    let mut key_reader = &options.key_pem[..];
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|error| {
            NodeError::new(
                "ERR_TLS_INVALID_KEY",
                format!("options.key is not a valid PEM private key: {error}"),
            )
        })?
        .ok_or_else(|| {
            NodeError::new(
                "ERR_TLS_INVALID_KEY",
                "options.key contains no PEM private key",
            )
        })?;

    let provider = Arc::new(ring::default_provider());
    let builder = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| {
            NodeError::new(
                "ERR_TLS_INVALID_CONFIG",
                format!("no usable TLS protocol version: {error}"),
            )
        })?;
    let mut config = builder
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .map_err(|error| {
            // rustls rejects a key that does not match the leaf certificate here.
            NodeError::new(
                "ERR_TLS_INVALID_KEY",
                format!("options.key does not match options.cert: {error}"),
            )
        })?;
    config.alpn_protocols = alpn_wire(&options.alpn);
    Ok(config)
}

/// Parse every certificate in `pem`, rejecting an empty file: an empty chain can never be what the
/// caller meant, and Node treats it as an invalid certificate rather than "trust nothing".
fn parse_certificates(
    pem: &[u8],
    code: &'static str,
    argument: &str,
) -> Result<Vec<CertificateDer<'static>>, NodeError> {
    let mut reader = pem;
    let certificates = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            NodeError::new(
                code,
                format!("{argument} is not valid PEM certificate data: {error}"),
            )
        })?;
    if certificates.is_empty() {
        return Err(NodeError::new(
            code,
            format!("{argument} contains no PEM CERTIFICATE block"),
        ));
    }
    Ok(certificates)
}

fn invalid_ca(detail: String) -> NodeError {
    NodeError::new(
        "ERR_TLS_CA_INVALID",
        format!("options.ca contains a certificate that is not a usable CA: {detail}"),
    )
}

fn alpn_wire(protocols: &[String]) -> Vec<Vec<u8>> {
    protocols
        .iter()
        .map(|protocol| protocol.as_bytes().to_vec())
        .collect()
}

/// A verifier that accepts every chain and every name (`rejectUnauthorized: false`).
///
/// It still verifies the handshake signature: skipping that would accept a peer that does not hold
/// the private key for the certificate it presented, which is a different (and pointless) hole.
#[derive(Debug)]
struct AcceptAnyServerCertificate {
    provider: Arc<CryptoProvider>,
}

impl AcceptAnyServerCertificate {
    fn new(provider: Arc<CryptoProvider>) -> Self {
        Self { provider }
    }
}

impl ServerCertVerifier for AcceptAnyServerCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ---------------------------------------------------------------------------
// Handshakes
// ---------------------------------------------------------------------------

/// A server-side config, ready for the accept loop.
///
/// Opaque on purpose: `connection.rs` and `listener.rs` must not name a rustls type, and a
/// listener builds this exactly once (so a malformed chain is one server error, not one per
/// accepted connection).
#[derive(Clone)]
pub(crate) struct ServerTls(Arc<ServerConfig>);

/// Build (or fetch from the cache) the server config the listener will use.
pub(crate) fn server_tls(options: &TlsServerOptions) -> Result<ServerTls, NodeError> {
    Ok(ServerTls(server_config(options)?))
}

/// What a finished handshake adds to the transport.
pub(crate) struct Accepted {
    pub(crate) transport: Transport,
    /// The negotiated ALPN protocol (`"http/1.1"`), or `None`.
    pub(crate) alpn: Option<String>,
    /// `"TLSv1.3"`/`"TLSv1.2"`, as `socket.getProtocol()` reports it.
    pub(crate) protocol: Option<String>,
}

/// Client handshake over an established TCP stream.
///
/// `fallback_name` is the connect host, used when the caller did not pass `servername` — Node's
/// default. An IP literal becomes `ServerName::IpAddress`, so verification checks the IP SANs and
/// rustls sends no SNI, exactly like Node.
pub(crate) async fn connect(
    stream: TcpStream,
    options: &TlsClientOptions,
    fallback_name: &str,
) -> Result<Accepted, NodeError> {
    let config = client_config(options)?;
    let name = options
        .servername
        .as_deref()
        .unwrap_or(fallback_name)
        .to_owned();
    let server_name = ServerName::try_from(name.clone()).map_err(|_| {
        NodeError::invalid_arg_value(
            "options.servername",
            &name,
            "is not a valid DNS name or IP address",
        )
    })?;

    let connector = TlsConnector::from(config);
    let stream = connector
        .connect(server_name, stream)
        .await
        .map_err(|error| handshake_error(&name, error))?;
    let (_, session) = stream.get_ref();
    let alpn = alpn_string(session.alpn_protocol());
    let protocol = protocol_string(session.protocol_version());
    Ok(Accepted {
        transport: Transport::Tls(Box::new(TlsKind::Client(stream))),
        alpn,
        protocol,
    })
}

/// Server handshake over an accepted TCP stream. Called from the child task, never the acceptor.
///
/// The config is passed in (built once when the listener starts) so a malformed chain is one
/// server error rather than one error per accepted connection.
pub(crate) async fn accept(stream: TcpStream, config: ServerTls) -> Result<Accepted, NodeError> {
    let acceptor = TlsAcceptor::from(config.0);
    let stream = acceptor
        .accept(stream)
        .await
        .map_err(|error| handshake_error("", error))?;
    let (_, session) = stream.get_ref();
    let alpn = alpn_string(session.alpn_protocol());
    let protocol = protocol_string(session.protocol_version());
    Ok(Accepted {
        transport: Transport::Tls(Box::new(TlsKind::Server(stream))),
        alpn,
        protocol,
    })
}

fn alpn_string(protocol: Option<&[u8]>) -> Option<String> {
    protocol
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(str::to_owned)
}

/// Node's spelling (`"TLSv1.3"`), not the Rust enum's (`"TLSv1_3"`).
fn protocol_string(version: Option<ProtocolVersion>) -> Option<String> {
    version.map(|version| match version {
        ProtocolVersion::TLSv1_3 => "TLSv1.3".to_owned(),
        ProtocolVersion::TLSv1_2 => "TLSv1.2".to_owned(),
        ProtocolVersion::TLSv1_1 => "TLSv1.1".to_owned(),
        ProtocolVersion::TLSv1_0 => "TLSv1".to_owned(),
        other => format!("{other:?}"),
    })
}

/// Map a failed handshake to a Node-shaped error.
///
/// Node reports OpenSSL's codes (`ERR_OSSL_*`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, ...) directly;
/// rustls exposes structured [`CertificateError`]s instead, so this is a translation, not a copy.
/// The codes chosen here are the ones Node produces for the same failure wherever one exists; D41
/// records where the mapping is an approximation.
fn handshake_error(peer: &str, error: io::Error) -> NodeError {
    let Some(rustls_error) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    else {
        // A socket-level failure (`ECONNRESET` mid-handshake, an unexpected EOF) keeps its errno.
        return from_io(&error, "connect");
    };
    match rustls_error {
        rustls::Error::InvalidCertificate(certificate) => certificate_error(certificate, peer),
        rustls::Error::InvalidMessage(_) => NodeError::new(
            "ERR_SSL_WRONG_VERSION_NUMBER",
            format!("wrong version number: the peer is not speaking TLS ({rustls_error})"),
        ),
        other => NodeError::new(
            "ERR_SSL_HANDSHAKE_FAILURE",
            format!("TLS handshake failed: {other}"),
        ),
    }
}

fn certificate_error(error: &CertificateError, peer: &str) -> NodeError {
    match error {
        CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
            NodeError::new(
                "ERR_TLS_CERT_ALTNAME_INVALID",
                format!("Hostname/IP does not match certificate's altnames: Host: {peer}"),
            )
        }
        CertificateError::Expired => NodeError::new(
            "CERT_HAS_EXPIRED",
            format!("certificate has expired ({peer})"),
        ),
        CertificateError::NotValidYet => NodeError::new(
            "CERT_NOT_YET_VALID",
            format!("certificate is not yet valid ({peer})"),
        ),
        CertificateError::UnknownIssuer => NodeError::new(
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "unable to verify the first certificate",
        ),
        CertificateError::BadEncoding => NodeError::new(
            "ERR_TLS_INVALID_CERT",
            "the peer certificate could not be decoded",
        ),
        other => NodeError::new(
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            format!("certificate verification failed: {other:?}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// `AsyncReadExt::read_exact` for the crate's `Reader` enum, which is not `AsyncRead`
    /// (it is a hand-rolled two-half wrapper, not a stream).
    async fn read_exact(reader: &mut super::super::transport::Reader, buffer: &mut [u8]) {
        let mut filled = 0;
        while filled < buffer.len() {
            let count = reader.read(&mut buffer[filled..]).await.expect("read");
            assert_ne!(count, 0, "unexpected EOF");
            filled += count;
        }
    }

    /// The error of a failed handshake (the success value is not `Debug`, so `expect_err` is out).
    fn failure(result: Result<Accepted, NodeError>) -> NodeError {
        match result {
            Ok(_) => panic!("the handshake unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    const CA: &[u8] = include_bytes!("../../../../test/fixtures/tls/ca-cert.pem");
    const SERVER_CERT: &[u8] = include_bytes!("../../../../test/fixtures/tls/server-cert.pem");
    const SERVER_KEY: &[u8] = include_bytes!("../../../../test/fixtures/tls/server-key.pem");
    const OTHER_CA: &[u8] = include_bytes!("../../../../test/fixtures/tls/other-ca-cert.pem");

    fn server_options() -> TlsServerOptions {
        TlsServerOptions {
            cert_pem: SERVER_CERT.to_vec(),
            key_pem: SERVER_KEY.to_vec(),
            alpn: vec!["http/1.1".to_owned()],
        }
    }

    fn verified_client() -> TlsClientOptions {
        TlsClientOptions {
            servername: None,
            reject_unauthorized: true,
            ca_pem: Some(CA.to_vec()),
            alpn: vec!["http/1.1".to_owned()],
        }
    }

    #[test]
    fn a_client_config_is_cached_by_content_not_by_handle() {
        let first = client_config(&verified_client()).expect("client config");
        let second = client_config(&verified_client()).expect("second lookup");
        assert!(
            Arc::ptr_eq(&first, &second),
            "equal options share one config"
        );

        let mut different_alpn = verified_client();
        different_alpn.alpn = vec!["h2".to_owned()];
        let third = client_config(&different_alpn).expect("client config");
        assert!(!Arc::ptr_eq(&first, &third), "ALPN is part of the key");

        let mut unverified = verified_client();
        unverified.reject_unauthorized = false;
        let fourth = client_config(&unverified).expect("client config");
        assert!(
            !Arc::ptr_eq(&first, &fourth),
            "rejectUnauthorized is part of the key"
        );

        let mut other_roots = verified_client();
        other_roots.ca_pem = Some(OTHER_CA.to_vec());
        let fifth = client_config(&other_roots).expect("client config");
        assert!(!Arc::ptr_eq(&first, &fifth), "ca is part of the key");
    }

    #[test]
    fn a_server_config_is_cached_by_content() {
        let first = server_config(&server_options()).expect("server config");
        let second = server_config(&server_options()).expect("server config");
        assert!(Arc::ptr_eq(&first, &second));

        let mut different = server_options();
        different.alpn.clear();
        let third = server_config(&different).expect("server config");
        assert!(!Arc::ptr_eq(&first, &third));
    }

    #[test]
    fn alpn_is_wired_in_preference_order() {
        let mut options = verified_client();
        options.alpn = vec!["h2".to_owned(), "http/1.1".to_owned()];
        let config = client_config(&options).expect("client config");
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );

        let server = server_config(&server_options()).expect("server config");
        assert_eq!(server.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn malformed_pem_reports_its_own_code() {
        let mut cert = server_options();
        cert.cert_pem = b"not a certificate".to_vec();
        assert_eq!(
            server_config(&cert).expect_err("bad cert").code,
            "ERR_TLS_INVALID_CERT"
        );

        let mut key = server_options();
        key.key_pem = b"not a key".to_vec();
        assert_eq!(
            server_config(&key).expect_err("bad key").code,
            "ERR_TLS_INVALID_KEY"
        );

        let mut empty = server_options();
        empty.cert_pem = Vec::new();
        assert_eq!(
            server_config(&empty).expect_err("empty cert").code,
            "ERR_TLS_INVALID_CERT"
        );

        // A certificate is not a key: the pair mismatch is reported as a key problem.
        let mut swapped = server_options();
        swapped.key_pem = SERVER_CERT.to_vec();
        assert!(server_config(&swapped).is_err());

        let mut ca = verified_client();
        ca.ca_pem =
            Some(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".to_vec());
        assert_eq!(
            client_config(&ca).expect_err("bad ca").code,
            "ERR_TLS_CA_INVALID"
        );
    }

    #[test]
    fn an_explicit_ca_is_appended_to_the_bundled_roots() {
        // Both builds must succeed: the bundled store is always present, so a caller that supplies
        // only a private CA still trusts the public web (a deliberate divergence from OpenSSL,
        // which replaces the store; D41).
        assert!(client_config(&verified_client()).is_ok());
        let mut without_ca = verified_client();
        without_ca.ca_pem = None;
        assert!(client_config(&without_ca).is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_real_tls_pair_echoes_and_negotiates_alpn() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.expect("accept");
            let accepted = accept(stream, server_tls(&server_options()).expect("config"))
                .await
                .expect("server handshake");
            assert_eq!(accepted.alpn.as_deref(), Some("http/1.1"));
            let (mut reader, mut writer) = accepted.transport.into_halves();
            let mut buffer = [0_u8; 16];
            let count = reader.read(&mut buffer).await.expect("read");
            writer.write_all(&buffer[..count]).await.expect("echo");
            writer.shutdown().await.expect("shutdown");
        });

        let stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let client = connect(stream, &verified_client(), "127.0.0.1")
            .await
            .expect("client handshake");
        assert_eq!(client.alpn.as_deref(), Some("http/1.1"));
        assert!(
            client
                .protocol
                .as_deref()
                .is_some_and(|protocol| protocol.starts_with("TLSv")),
            "getProtocol reports a TLS version: {:?}",
            client.protocol
        );

        let (mut reader, mut writer) = client.transport.into_halves();
        writer.write_all(b"ping").await.expect("write");
        let mut buffer = [0_u8; 4];
        read_exact(&mut reader, &mut buffer).await;
        assert_eq!(&buffer, b"ping");
        server.await.expect("server task");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_untrusted_chain_fails_when_verification_is_on() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.expect("accept");
            let _ = accept(stream, server_tls(&server_options()).expect("config")).await;
        });

        let mut options = verified_client();
        options.ca_pem = Some(OTHER_CA.to_vec());
        let stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let error = failure(connect(stream, &options, "127.0.0.1").await);
        assert_eq!(error.code, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
        let _ = server.await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_name_mismatch_is_err_tls_cert_altname_invalid() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.expect("accept");
            let _ = accept(stream, server_tls(&server_options()).expect("config")).await;
        });

        let mut options = verified_client();
        options.servername = Some("wrong.example".to_owned());
        let stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let error = failure(connect(stream, &options, "127.0.0.1").await);
        assert_eq!(error.code, "ERR_TLS_CERT_ALTNAME_INVALID");
        let _ = server.await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reject_unauthorized_false_completes_the_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.expect("accept");
            let accepted = accept(stream, server_tls(&server_options()).expect("config"))
                .await
                .expect("server handshake");
            let (mut reader, mut writer) = accepted.transport.into_halves();
            let mut buffer = [0_u8; 4];
            let count = reader.read(&mut buffer).await.expect("read");
            writer.write_all(&buffer[..count]).await.expect("echo");
        });

        let mut options = verified_client();
        options.reject_unauthorized = false;
        options.ca_pem = None;
        options.servername = Some("wrong.example".to_owned());
        let stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let accepted = connect(stream, &options, "127.0.0.1")
            .await
            .expect("unverified handshake");
        let (mut reader, mut writer) = accepted.transport.into_halves();
        writer.write_all(b"ping").await.expect("write");
        let mut buffer = [0_u8; 4];
        read_exact(&mut reader, &mut buffer).await;
        assert_eq!(&buffer, b"ping");
        let _ = server.await;
    }
}
