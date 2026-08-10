# DSA Payroll — Physical Server Install

Same procedure as NAVY-PAYROLL. Run everything on the **designated server machine only**.

## 1. Prerequisites on the server

- Windows (Server or Pro), Administrator access
- Node.js LTS
- MySQL installed and registered as a Windows service (the installer aborts if no `MySQL*` service is found)
- Git

## 2. Binaries that must be present in `bin/`

These are binary files and are **not** created by this port. Copy them from the NAVY-PAYROLL
project (or re-download):

```
bin\winsw.exe
bin\openssl.exe
bin\libssl-3-x64.dll
bin\libcrypto-3-x64.dll
bin\runner\runner.part0
bin\runner\runner.part1
```

Copy from an existing NAVY checkout:

```cmd
xcopy /E /I /Y C:\NAVY-PAYROLL\bin C:\DSA-PAYROLL\bin
```

Alternatively:

- `winsw.exe` — `install-service.js` auto-downloads it if missing (needs internet).
- `openssl.exe` + DLLs — https://slproweb.com/products/Win32OpenSSL.html, or `setup.bat` falls
  back to winget.
- Runner chunks — run `.\chunk-runner.ps1` once on a dev machine, then commit `bin/runner/`.

Note: `bin/runner/runner.part*` from NAVY is the generic GitHub Actions runner zip, so it is
safe to reuse as-is.

## 3. Environment files

`server.js`, `proxy.js` and `mdns.js` load `.env.local` (or `.env.production` when
`NODE_ENV=production`) **from the project root**, not from `config/`. Create both at the root
using `.env.example` as the template.

Required for a server install:

```
NODE_ENV=production
PORT=7070
SERVER_MODE=auto
GITHUB_REPO=hicadsystems/DSA-PAYROLL
GITHUB_PAT=...            # or GITHUB_RUNNER_TOKEN
RUNNER_LABEL=dsa-payroll
```

`LOCAL_IP`, `LOCAL_DOMAIN`, `BIND_ADDRESS`, `HTTPS_PORT` and `HTTP_PORT` are written
automatically by `setup.bat`.

## 4. Run the installer

```cmd
cd C:\DSA-PAYROLL
npm install --omit=dev
.\setup.bat
```

`setup.bat` self-elevates and will:

1. Stop existing DSA services, free ports 7070 / 443 / 80
2. Detect the active adapter, IP and gateway
3. Ask for bind mode (localhost vs LAN `0.0.0.0`)
4. Ask for a `.local` domain (e.g. `dsapayroll.local`) and write env vars
5. Generate `cert.pem` / `key.pem` (10-year self-signed, SANs for localhost, domain, IP)
6. Add firewall rules `DSA_PAYROLL_SSL/PROXY/HTTP/MDNS/SSH` and urlacl reservations
7. Add the domain to the Windows hosts file
8. Enable OpenSSH, install the WinSW services, install the GitHub Actions runner

## 5. Windows services created

| Service | Script | Purpose |
| --- | --- | --- |
| `DsaPayroll-App` | `server.js` | Express app on port 7070 |
| `DsaPayroll-Proxy` | `proxy.js` | HTTPS 443 → app, HTTP 80 → redirect |
| `DsaPayroll-Watcher` | `watcher.js` | Restarts the app on backend file changes |
| `DsaPayroll-mDNS` | `mdns.js` | Advertises the `.local` domain on the LAN |

Manage with `DsaPayroll-App.exe status|start|stop|restart` (same for the others) or
`services.msc`. Logs land in `logs/`.

Reinstall: `node install-service.js` · Remove: `node uninstall-service.js`

## 6. Auto-deploy

`.github/workflows/deploy.yml` runs on push to `main` on the self-hosted runner: robocopy
into `SERVER_PROJECT_PATH`, `npm install --omit=dev`, then `DsaPayroll-App.exe restart`.

GitHub repo secrets required:

- `SERVER_PROJECT_PATH` (e.g. `C:\DSA-PAYROLL`)
- `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_PORT`, `SERVER_SSH_KEY` (printed by `setup.bat`)

Manual deploy on the server:

```cmd
git pull && npm install && DsaPayroll-App.exe restart
```
