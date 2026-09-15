# Password protection and remote access

Build the client with `npm run build`, then run the API with `npm start`
(or the existing server supervisor). The API serves the built client on port
8787 by default. Open `http://localhost:8787` and set a password of at least
12 characters. Settings → Security changes the password and signs out all devices.

Point the Cloudflare Tunnel public hostname at `http://localhost:8787` and
use HTTPS on the public URL. Keep the incoming public Host and Cloudflare
forwarding headers intact. Do not expose the Vite development server or the
separate code-server/browser-bridge ports through this tunnel.

The API denies remote access until setup is complete. Passwords are stored
as salted scrypt hashes in `SESSION_DATA_DIR/security.json` (default:
`data/security.json`), with owner-only file permissions. Login cookies are
HttpOnly, SameSite=Strict, and Secure for remote access. A simple token carries
its expiry and an HMAC-SHA-256 signature; there is no user or session database.
One signing key, persisted in the owner-only security file, serves this single-user
app. The browser remembers the token in localStorage and restores its API cookie
automatically; passwords are never saved in browser storage. Tokens survive server
restarts and expire after 30 days, on sign-out, or when the password changes. Sign-out
rotates the signing key for all devices. Password changes
also close existing authenticated event streams. Login and password attempts
share a limit of 10 per minute across clients; forwarding IP headers do not
control the rate-limit key.

Direct local automation remains trusted: it must connect over loopback with
a localhost/loopback Host, no proxy/Cloudflare headers, no Origin, and no
browser Sec-Fetch-Site header. This supports the existing runner and local
tools. This is a single-user password gate, not isolation from other local
OS users. Never strip proxy headers or rewrite the public Host to localhost.

To recover a forgotten password, stop the server, remove only
`SESSION_DATA_DIR/security.json`, restart, and set the replacement password
from localhost. Remote requests remain blocked during setup.

References: [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [Cloudflare origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).
