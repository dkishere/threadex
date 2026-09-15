# Pre-open-source checklist

- [ ] Replace the pre-release notice and choose a public repository name.
- [x] Add LICENSE, CONTRIBUTING.md, and SECURITY.md.
- [x] Add CODE_OF_CONDUCT.md and a changelog.
- [ ] Test extension pairing in a clean Chrome profile on macOS, Linux, and Windows.
- [x] Add a website-grant listing and a revoke-all control in the extension popup.
- [ ] Add per-origin revocation before calling the website API production-ready.
- [ ] Add remaining integration coverage for expired website grants; pairing and cross-origin rejection are covered.
- [x] Verify the automatic page-context content script and legacy-compatible Web UI payload in Chrome.
- [ ] Consider a Unix-domain-socket transport for CLI commands on platforms where agent sandboxes permit it.
- [ ] Perform a permissions review: `debugger` gives powerful access to a tab once attached.
