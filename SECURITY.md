# Security Policy

pubface is a small library and CLI that resolves the public-facing network
interfaces of the current machine. For each local interface it makes an outbound
HTTPS request to a resolver service to learn the public IP address the outside
world sees, then performs a reverse-DNS (PTR) lookup. It does not store
credentials or accept inbound connections, but because it is embedded in other
applications (for example EmailEngine) we take security reports seriously and
aim to respond quickly.

## Supported Versions

Security fixes are released only against the latest version. We do not backport
patches to older releases - upgrading to the current release line is the
supported way to receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

If you are on an older version, please upgrade. See the release notes at
<https://github.com/postalsys/pubface/releases> before updating.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Report privately through one of the following channels:

1. **GitHub Security Advisories (preferred).** Open a private report at
   <https://github.com/postalsys/pubface/security/advisories/new>. This keeps the
   discussion private until a fix is published and lets us credit you.
2. **Email.** Send details to **andris@postalsys.com** (the contact listed in
   [`SECURITY.txt`](SECURITY.txt)). Encrypt sensitive details if possible.

When reporting, please include as much of the following as you can:

- The affected version(s) and environment (pubface version, Node.js version, OS,
  whether used as a library, the `pubface` CLI, or a prebuilt binary).
- A clear description of the issue and its impact (e.g. SSRF, injection,
  information disclosure, denial of service, remote code execution).
- A minimal proof of concept or reproduction steps.
- Any suggested remediation, if you have one.

We are a small team, so there is no guaranteed response time - sometimes reports
are handled within hours, sometimes they take longer. Accepted issues are fixed
in a new release and coordinated through a GitHub Security Advisory, and
reporters who wish to be named are credited.

## CVEs

We track and disclose vulnerabilities through GitHub Security Advisories. We do
not request or manage CVE identifiers ourselves. If you need a CVE assigned for a
reported issue, please request one yourself - for example, through GitHub's own
CVE request flow on the published advisory, or another CNA.

## Scope

In scope: the pubface source in this repository - the public-interface
resolution logic, the DNS/PTR handling, the outbound HTTPS request handling, and
the `pubface` CLI.

Out of scope:

- Vulnerabilities in your own application code that integrates with pubface.
- The remote resolver service that pubface queries (by default
  `https://api.nodemailer.com/`) and any DNS infrastructure it relies on.
- Misconfiguration of your environment - for example, pointing `RESOLV_URL` at an
  untrusted resolver endpoint.
- Issues that require an already-compromised host.
- Vulnerabilities in third-party dependencies that are already publicly known and
  have no pubface-specific impact (report those upstream).

Thank you for helping keep pubface and its users safe.
