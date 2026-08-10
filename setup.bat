@echo off
setlocal EnableDelayedExpansion
title DSA Payroll - SSL Setup Automation

:: ============================================================
::  Self-elevate to Administrator if not already
:: ============================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -Command "Start-Process cmd.exe -ArgumentList '/c \"%~f0\"' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

echo.
echo ============================================================
echo   DSA PAYROLL - Local HTTPS Setup
echo ============================================================
echo.
echo ============================================================
echo   *** WARNING - READ BEFORE CONTINUING ***
echo ============================================================
echo.
echo   This script MUST be run ONLY on the designated SERVER
echo   machine. It will:
echo.
echo     - CHANGE your network adapter IPv4 to a static IP
echo     - This can disconnect you from your router/hotspot
echo       if run on the wrong machine or wrong network
echo.
echo   DO NOT run this on:
echo     - Your personal laptop or daily-use machine
echo     - Any machine NOT acting as the DSA Payroll server
echo     - A machine connected to a different network/router
echo.
echo   If you lost connection after running this by mistake:
echo     netsh interface ip set address name="Wi-Fi" dhcp
echo     netsh interface ip set address name="Ethernet" dhcp
echo.
echo ============================================================
echo.
set /p "CONFIRM=Are you on the SERVER machine? Type YES to continue: "
if /i "!CONFIRM!" neq "YES" (
    echo [ABORTED] Run this script only on the server machine.
    pause
    exit /b 0
)
echo.


:: ============================================================
:: STEP 0 — Stop existing DSA Payroll services and free ports
:: ============================================================
echo [0/8] Stopping existing DSA Payroll services...

schtasks /end /tn "DsaPayroll-App"   >nul 2>&1
schtasks /end /tn "DsaPayroll-Proxy" >nul 2>&1
echo [INFO] Stopped existing tasks (if running)

timeout /t 3 /nobreak >nul

:: Force kill port 7070 — always ours
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:7070 " ^| findstr /i "LISTENING"') do (
    echo [INFO] Killing process on port 7070 ^(PID %%A^)...
    taskkill /PID %%A /F >nul 2>&1
)

:: Port 443 — ask if something else is using it
set "P443_PID="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:443 " ^| findstr /i "LISTENING"') do (
    if not defined P443_PID set "P443_PID=%%A"
)
if defined P443_PID (
    set "P443_NAME=unknown"
    for /f "tokens=1" %%B in ('tasklist /fi "PID eq !P443_PID!" /fo csv /nh 2^>nul') do set "P443_NAME=%%B"
    echo [WARN] Port 443 is in use by !P443_NAME! ^(PID !P443_PID!^)
    echo   [1] Use a different HTTPS port ^(recommended: 8443^)
    echo   [2] Force kill it and use 443
    echo   [3] Abort
    set /p "C443=Choose [1/2/3]: "
    if "!C443!"=="1" (
        set /p "HTTPS_PORT=Enter alternative HTTPS port [8443]: "
        if not defined HTTPS_PORT set "HTTPS_PORT=8443"
        echo [OK] Will use HTTPS port !HTTPS_PORT!
    ) else if "!C443!"=="2" (
        taskkill /PID !P443_PID! /F >nul 2>&1
        set "HTTPS_PORT=443"
        echo [OK] Killed PID !P443_PID! — port 443 freed
    ) else (
        echo [ABORTED] Free port 443 manually then re-run.
        pause
        exit /b 0
    )
) else (
    set "HTTPS_PORT=443"
)

:: Port 80 — ask if something else is using it
set "P80_PID="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:80 " ^| findstr /i "LISTENING"') do (
    if not defined P80_PID set "P80_PID=%%A"
)
if defined P80_PID (
    set "P80_NAME=unknown"
    for /f "tokens=1" %%B in ('tasklist /fi "PID eq !P80_PID!" /fo csv /nh 2^>nul') do set "P80_NAME=%%B"
    echo [WARN] Port 80 is in use by !P80_NAME! ^(PID !P80_PID!^)
    echo   [1] Use a different HTTP port ^(recommended: 8080^)
    echo   [2] Force kill it and use 80
    echo   [3] Abort
    set /p "C80=Choose [1/2/3]: "
    if "!C80!"=="1" (
        set /p "HTTP_PORT=Enter alternative HTTP port [8080]: "
        if not defined HTTP_PORT set "HTTP_PORT=8080"
        echo [OK] Will use HTTP port !HTTP_PORT!
    ) else if "!C80!"=="2" (
        taskkill /PID !P80_PID! /F >nul 2>&1
        set "HTTP_PORT=80"
        echo [OK] Killed PID !P80_PID! — port 80 freed
    ) else (
        echo [ABORTED] Free port 80 manually then re-run.
        pause
        exit /b 0
    )
) else (
    set "HTTP_PORT=80"
)

set "APP_PORT=7070"

echo [OK] Ports — App:%APP_PORT%  HTTPS:%HTTPS_PORT%  HTTP:%HTTP_PORT%
timeout /t 2 /nobreak >nul


:: ============================================================
:: STEP 1 — Verify .env.local exists
:: ============================================================
echo.
echo [1/8] Checking .env.local...

set "ENV_FILE=%~dp0.env.local"
if not exist "%ENV_FILE%" (
    echo [ERROR] .env.local not found at %ENV_FILE%
    echo         Please create it before running this script.
    pause
    exit /b 1
)

echo [OK] .env.local found


:: ============================================================
:: STEP 2 — Auto-detect active adapter + current IP + gateway
:: ============================================================
echo.
echo [2/8] Detecting active network adapter and IP...

set "ADAPTER="
for /f "skip=2 tokens=1,2,3,*" %%A in ('netsh interface show interface') do (
    if /i "%%B"=="Connected" (
        if not defined ADAPTER set "ADAPTER=%%D"
    )
)

if not defined ADAPTER (
    echo [ERROR] Could not detect an active network adapter.
    pause
    exit /b 1
)

echo [OK] Adapter = %ADAPTER%

set "LOCAL_IP="
for /f "tokens=2 delims=:" %%A in ('netsh interface ip show address name^="%ADAPTER%" ^| findstr /i "IP Address"') do (
    for /f "tokens=1" %%B in ("%%A") do (
        if not defined LOCAL_IP set "LOCAL_IP=%%B"
    )
)

if not defined LOCAL_IP (
    echo [ERROR] Could not detect IP for adapter "%ADAPTER%".
    pause
    exit /b 1
)

echo [OK] Detected IP = %LOCAL_IP%

set "GATEWAY="
for /f "tokens=2 delims=:" %%A in ('netsh interface ip show address name^="%ADAPTER%" ^| findstr /i "Default Gateway"') do (
    for /f "tokens=1" %%B in ("%%A") do (
        if not defined GATEWAY set "GATEWAY=%%B"
    )
)

if not defined GATEWAY (
    echo [WARN] Could not detect gateway. Defaulting to 192.168.0.1
    set "GATEWAY=192.168.0.1"
) else (
    echo [OK] Gateway = %GATEWAY%
)


:: ============================================================
:: STEP 3 — Network binding mode
:: ============================================================
echo.
echo [3/8] Network binding mode...
echo.
echo   [1] localhost only  ^(MTN hotspot / testing — access from this machine only^)
echo   [2] LAN ^(0.0.0.0^)  ^(proper router — access from all machines on network^)
echo.
set /p "BIND_CHOICE=Choose [1/2]: "
if "!BIND_CHOICE!"=="2" (
    set "BIND_ADDRESS=0.0.0.0"
    echo [OK] Binding to all interfaces ^(LAN mode^)
) else (
    set "BIND_ADDRESS=127.0.0.1"
    echo [OK] Binding to localhost only
)


:: ============================================================
:: STEP 4 — Friendly .local domain name
:: ============================================================
echo.
echo [4/8] Friendly LAN domain name setup...
echo       Must end in .local ^(e.g. dsapayroll.local^)
echo.

set "EXISTING_DOMAIN="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    for /f "tokens=1 delims=# " %%C in ("%%B") do (
        if /i "%%A"=="LOCAL_DOMAIN" set "EXISTING_DOMAIN=%%C"
    )
)

if defined EXISTING_DOMAIN (
    echo [INFO] Existing domain found: %EXISTING_DOMAIN%
    set /p "KEEP_DOMAIN=Keep this domain? [Y/N]: "
    if /i "!KEEP_DOMAIN!"=="Y" (
        set "DOMAIN=%EXISTING_DOMAIN%"
        goto domain_ok
    )
)

:ask_domain
set /p "DOMAIN=Enter your preferred domain name: "
if /i "!DOMAIN:~-6!"==".local" goto domain_ok
echo [ERROR] Domain must end in .local - try again.
goto ask_domain
:domain_ok

echo [OK] Domain = %DOMAIN%


:: ============================================================
:: Write all env vars to .env.local and .env.production
:: ============================================================
echo.
echo [INFO] Writing env vars to .env.local and .env.production...

set "TEMP_PS=%TEMP%\write_env.ps1"

> "%TEMP_PS%" echo function Write-EnvVars($filePath, $ip, $domain, $bindAddress, $httpsPort, $httpPort) {
>> "%TEMP_PS%" echo     if (-not (Test-Path $filePath)) { return }
>> "%TEMP_PS%" echo     $lines = Get-Content $filePath ^| Where-Object {
>> "%TEMP_PS%" echo         $_ -notmatch '^LOCAL_IP=' -and
>> "%TEMP_PS%" echo         $_ -notmatch '^LOCAL_DOMAIN=' -and
>> "%TEMP_PS%" echo         $_ -notmatch '^BIND_ADDRESS=' -and
>> "%TEMP_PS%" echo         $_ -notmatch '^HTTPS_PORT=' -and
>> "%TEMP_PS%" echo         $_ -notmatch '^HTTP_PORT='
>> "%TEMP_PS%" echo     }
>> "%TEMP_PS%" echo     $out = @(); $written = $false
>> "%TEMP_PS%" echo     foreach ($line in $lines) {
>> "%TEMP_PS%" echo         $out += $line
>> "%TEMP_PS%" echo         if (-not $written -and $line -match '^SERVER_MODE=') {
>> "%TEMP_PS%" echo             $out += "LOCAL_IP=$ip"
>> "%TEMP_PS%" echo             $out += "LOCAL_DOMAIN=$domain"
>> "%TEMP_PS%" echo             $out += "BIND_ADDRESS=$bindAddress"
>> "%TEMP_PS%" echo             $out += "HTTPS_PORT=$httpsPort"
>> "%TEMP_PS%" echo             $out += "HTTP_PORT=$httpPort"
>> "%TEMP_PS%" echo             $written = $true
>> "%TEMP_PS%" echo         }
>> "%TEMP_PS%" echo     }
>> "%TEMP_PS%" echo     if (-not $written) {
>> "%TEMP_PS%" echo         $out += "LOCAL_IP=$ip"
>> "%TEMP_PS%" echo         $out += "LOCAL_DOMAIN=$domain"
>> "%TEMP_PS%" echo         $out += "BIND_ADDRESS=$bindAddress"
>> "%TEMP_PS%" echo         $out += "HTTPS_PORT=$httpsPort"
>> "%TEMP_PS%" echo         $out += "HTTP_PORT=$httpPort"
>> "%TEMP_PS%" echo     }
>> "%TEMP_PS%" echo     $out ^| Set-Content $filePath -Encoding UTF8
>> "%TEMP_PS%" echo }
>> "%TEMP_PS%" echo Write-EnvVars '%~dp0.env.local'      '%LOCAL_IP%' '%DOMAIN%' '%BIND_ADDRESS%' '%HTTPS_PORT%' '%HTTP_PORT%'
>> "%TEMP_PS%" echo Write-EnvVars '%~dp0.env.production' '%LOCAL_IP%' '%DOMAIN%' '%BIND_ADDRESS%' '%HTTPS_PORT%' '%HTTP_PORT%'

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_PS%"
del "%TEMP_PS%" >nul 2>&1

echo [OK] LOCAL_IP=%LOCAL_IP%
echo [OK] LOCAL_DOMAIN=%DOMAIN%
echo [OK] BIND_ADDRESS=%BIND_ADDRESS%
echo [OK] HTTPS_PORT=%HTTPS_PORT%
echo [OK] HTTP_PORT=%HTTP_PORT%
echo [OK] Written to .env.local and .env.production


:: ============================================================
:: STEP 5 — Generate SSL cert and key
:: ============================================================
echo.
echo [5/8] Generating SSL certificate and key...

set "KEY_FILE=%~dp0key.pem"
set "CERT_FILE=%~dp0cert.pem"

if exist "%KEY_FILE%" (
    del /f /q "%KEY_FILE%"
    echo [INFO] Removed old key.pem
)
if exist "%CERT_FILE%" (
    del /f /q "%CERT_FILE%"
    echo [INFO] Removed old cert.pem
)

set "OPENSSL_EXE="

:: 1) Check bundled bin/ folder first
if exist "%~dp0bin\openssl.exe" set "OPENSSL_EXE=%~dp0bin\openssl.exe"

:: 2) Check system PATH
if not defined OPENSSL_EXE (
    where openssl >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%P in ('where openssl') do (
            if not defined OPENSSL_EXE set "OPENSSL_EXE=%%P"
        )
    )
)

:: 3) Check common install locations
if not defined OPENSSL_EXE (
    for %%P in (
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"
        "C:\Program Files\OpenSSL\bin\openssl.exe"
        "C:\OpenSSL-Win64\bin\openssl.exe"
        "C:\Program Files\Git\usr\bin\openssl.exe"
        "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
        "C:\Git\usr\bin\openssl.exe"
    ) do (
        if not defined OPENSSL_EXE (
            if exist %%P set "OPENSSL_EXE=%%~P"
        )
    )
)

:: 4) Last resort — try winget
if not defined OPENSSL_EXE (
    echo [INFO] OpenSSL not found. Trying winget...
    winget install ShiningLight.OpenSSL.Light --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
    for /f "skip=2 tokens=3*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH') do set "SYS_PATH=%%A %%B"
    set "PATH=%SYS_PATH%;%PATH%"
    where openssl >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%P in ('where openssl') do (
            if not defined OPENSSL_EXE set "OPENSSL_EXE=%%P"
        )
    )
)

if not defined OPENSSL_EXE (
    echo [ERROR] OpenSSL not found.
    echo         Place openssl.exe + its DLLs in %~dp0bin\
    echo         Or install from: https://slproweb.com/products/Win32OpenSSL.html
    pause
    exit /b 1
)

echo [INFO] Using OpenSSL at: %OPENSSL_EXE%

:: Add OpenSSL dir to PATH so it finds its DLLs
for %%F in ("%OPENSSL_EXE%") do set "OPENSSL_DIR=%%~dpF"
set "PATH=%OPENSSL_DIR%;%PATH%"

:: Generate openssl.cnf with correct domain and IPs
set "OPENSSL_CONF=%~dp0bin\openssl.cnf"
echo [INFO] Generating openssl.cnf with domain and IP SANs...
(
    echo [req]
    echo distinguished_name = req_distinguished_name
    echo x509_extensions = v3_req
    echo prompt = no
    echo [req_distinguished_name]
    echo CN = %DOMAIN%
    echo [v3_req]
    echo keyUsage = critical, digitalSignature, keyEncipherment
    echo extendedKeyUsage = serverAuth
    echo subjectAltName = @alt_names
    echo [alt_names]
    echo DNS.1 = localhost
    echo DNS.2 = %DOMAIN%
    echo IP.1 = 127.0.0.1
    echo IP.2 = %LOCAL_IP%
) > "%OPENSSL_CONF%"
echo [OK] openssl.cnf generated

set MSYS_NO_PATHCONV=1
"%OPENSSL_EXE%" req -x509 -newkey rsa:2048 ^
  -keyout "%KEY_FILE%" ^
  -out "%CERT_FILE%" ^
  -days 3650 -nodes ^
  -config "%OPENSSL_CONF%" 2>&1

if errorlevel 1 (
    echo [ERROR] OpenSSL failed to generate certificate.
    echo         Ensure libssl-3-x64.dll and libcrypto-3-x64.dll are alongside openssl.exe
    pause
    exit /b 1
)

echo [OK] cert.pem and key.pem generated ^(valid 10 years^)


:: ============================================================
:: STEP 7 — Firewall rules
:: ============================================================
echo.
echo [6/8] Configuring firewall rules...

netsh advfirewall firewall delete rule name="DSA_PAYROLL_SSL"   >nul 2>&1
netsh advfirewall firewall delete rule name="DSA_PAYROLL_PROXY" >nul 2>&1
netsh advfirewall firewall delete rule name="DSA_PAYROLL_HTTP"  >nul 2>&1
netsh advfirewall firewall delete rule name="DSA_PAYROLL_MDNS"  >nul 2>&1
echo [INFO] Cleared existing DSA_PAYROLL firewall rules

netsh advfirewall firewall add rule name="DSA_PAYROLL_SSL"   dir=in action=allow protocol=TCP localport=%APP_PORT%   profile=any >nul 2>&1
echo [OK] Firewall — port %APP_PORT% ^(Node app^)

netsh advfirewall firewall add rule name="DSA_PAYROLL_PROXY" dir=in action=allow protocol=TCP localport=%HTTPS_PORT% profile=any >nul 2>&1
echo [OK] Firewall — port %HTTPS_PORT% ^(HTTPS proxy^)

netsh advfirewall firewall add rule name="DSA_PAYROLL_HTTP"  dir=in action=allow protocol=TCP localport=%HTTP_PORT%  profile=any >nul 2>&1
echo [OK] Firewall — port %HTTP_PORT% ^(HTTP redirect^)

:: Allow mDNS multicast (UDP 5353) so .local resolves on the LAN
netsh advfirewall firewall add rule name="DSA_PAYROLL_MDNS"  dir=in action=allow protocol=UDP localport=5353        profile=any >nul 2>&1
echo [OK] Firewall — port 5353 UDP ^(mDNS^)

echo [INFO] Reserving ports for NETWORK SERVICE...
netsh http add urlacl url=http://+:%HTTP_PORT%/   user="NT AUTHORITY\NETWORK SERVICE" >nul 2>&1
netsh http add urlacl url=https://+:%HTTPS_PORT%/ user="NT AUTHORITY\NETWORK SERVICE" >nul 2>&1
echo [OK] Port reservations set


:: ============================================================
:: STEP 8 — Add friendly domain to Windows hosts file
:: ============================================================
echo.
echo [7/8] Updating Windows hosts file...

set "HOSTS_FILE=%SystemRoot%\System32\drivers\etc\hosts"
set "HOSTS_ENTRY=%LOCAL_IP%    %DOMAIN%"
set "TEMP_HOSTS=%TEMP%\hosts_temp.txt"

findstr /v /i "%DOMAIN%" "%HOSTS_FILE%" > "%TEMP_HOSTS%"
copy /y "%TEMP_HOSTS%" "%HOSTS_FILE%" >nul
echo %HOSTS_ENTRY%>> "%HOSTS_FILE%"
del "%TEMP_HOSTS%" >nul 2>&1
echo [OK] Hosts file updated: %HOSTS_ENTRY%


:: ============================================================
:: STEP 9 — Install services
:: ============================================================
echo.
echo [8/8] Installing services...

:: Install OpenSSH Server if not present
echo [INFO] Checking OpenSSH Server...
sc query sshd >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing OpenSSH Server...
    powershell -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0" >nul 2>&1
    echo [OK] OpenSSH Server installed
) else (
    echo [OK] OpenSSH Server already installed
)

:: Start and enable SSH service
cmd /c "sc start sshd" >nul 2>&1
cmd /c "sc config sshd start= auto" >nul 2>&1
echo [OK] SSH service enabled and set to auto-start

:: Allow SSH through firewall
netsh advfirewall firewall delete rule name="DSA_PAYROLL_SSH" >nul 2>&1
netsh advfirewall firewall add rule name="DSA_PAYROLL_SSH" dir=in action=allow protocol=TCP localport=22 profile=any >nul 2>&1
echo [OK] Firewall — port 22 ^(SSH^)

echo.
echo   SSH Connection Details:
echo     Host : %LOCAL_IP%
echo     Port : 22
echo     User : %USERNAME%
echo.
echo   Add these to GitHub Secrets:
echo     SERVER_HOST     = %LOCAL_IP%
echo     SERVER_USER     = %USERNAME%
echo     SERVER_SSH_PORT = 22
echo     SERVER_SSH_KEY  = ^(your private key^)
echo.

:: Install WinSW services
echo.
echo [INFO] Setting up WinSW services...
cd /d "%~dp0"
node install-service.js
if errorlevel 1 (
    echo [WARN] WinSW setup failed. Place winsw.exe in project root then run: node install-service.js
) else (
    echo [OK] WinSW services registered and running
)

:: Install GitHub Actions Runner
echo.
echo [INFO] Checking GitHub Actions Runner...

:: Skip if runner is already installed and service is running
if exist "%~dp0actions-runner\run.cmd" (
    powershell -NoProfile -Command "if (Get-Service | Where-Object {$_.Name -like 'actions.runner*'}) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        echo [OK] GitHub Actions Runner already installed and service running — skipping.
        goto skip_runner
    )
    echo [INFO] Runner files found — service not running, will reinstall.
)

:: Skip if runner chunks not present — nothing to install
if not exist "%~dp0bin\runner\runner.part0" (
    echo [WARN] Runner chunks not found in bin\runner\ — skipping.
    echo        Run chunk-runner.ps1 on your dev machine first.
    goto skip_runner
)

:: Skip if no token available
set "GITHUB_PAT="
set "GITHUB_RUNNER_TOKEN="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="GITHUB_PAT"          set "GITHUB_PAT=%%B"
    if /i "%%A"=="GITHUB_RUNNER_TOKEN" set "GITHUB_RUNNER_TOKEN=%%B"
)

if not defined GITHUB_PAT (
    if not defined GITHUB_RUNNER_TOKEN (
        echo [WARN] Neither GITHUB_RUNNER_TOKEN nor GITHUB_PAT set in .env.local — skipping.
        echo        Add one of these to .env.local:
        echo          GITHUB_RUNNER_TOKEN=token_from_github   ^(expires in 1hr^)
        echo          GITHUB_PAT=your_personal_access_token   ^(auto-generates token^)
        echo        Then run: node install-runner.js
        goto skip_runner
    )
)

cd /d "%~dp0"
node install-runner.js
if errorlevel 1 (
    echo [WARN] Runner install failed. Run manually: node install-runner.js
) else (
    echo [OK] GitHub Actions Runner installed
)

:skip_runner


:: ============================================================
:: VERIFICATION
:: ============================================================
echo.
echo ============================================================
echo   Verification
echo ============================================================

timeout /t 5 /nobreak >nul

echo.
echo [TEST] Pinging %LOCAL_IP%...
ping -n 2 %LOCAL_IP% >nul 2>&1
if errorlevel 1 (
    echo [WARN] Ping failed — network may still be settling.
) else (
    echo [OK] Ping successful
)

echo.
echo [TEST] Health check via localhost...
powershell -NoProfile -Command ^
  "try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}; $r = Invoke-WebRequest -Uri 'https://localhost:%HTTPS_PORT%/health' -TimeoutSec 8 -UseBasicParsing; Write-Host '[OK] localhost:' $r.Content } catch { Write-Host '[WARN] localhost failed:' $_.Exception.Message }"

echo.
echo [TEST] Health check via domain ^(%DOMAIN%^)...
powershell -NoProfile -Command ^
  "try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12; [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}; $r = Invoke-WebRequest -Uri 'https://%DOMAIN%/health' -TimeoutSec 8 -UseBasicParsing; Write-Host '[OK] domain:' $r.Content } catch { Write-Host '[WARN] domain failed:' $_.Exception.Message }"

echo.
echo [TEST] Internet connectivity...
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'https://www.google.com' -TimeoutSec 5 -UseBasicParsing >$null; Write-Host '[OK] Internet reachable' } catch { Write-Host '[WARN] Internet check failed — verify gateway and DNS' }"


:: ============================================================
:: SUMMARY
:: ============================================================
echo.
echo ============================================================
echo   Setup Complete!
echo ============================================================
echo.
echo   Adapter      : %ADAPTER%
echo   IP           : %LOCAL_IP% ^(DHCP — may change on reconnect^)
echo   Gateway      : %GATEWAY%
echo   Bind Address : %BIND_ADDRESS%
echo.
echo   Ports:
echo     App ^(Node^)    : %APP_PORT%
echo     HTTPS proxy   : %HTTPS_PORT%
echo     HTTP redirect : %HTTP_PORT%
echo     mDNS          : 5353 UDP
echo.
if "%BIND_ADDRESS%"=="0.0.0.0" (
    echo   Access your app at:
    echo     https://%DOMAIN%         ^(LAN domain — no client config needed^)
    echo     http://%DOMAIN%          ^(redirects to HTTPS^)
    echo     https://%LOCAL_IP%:%HTTPS_PORT% ^(by IP^)
    echo     https://localhost:%HTTPS_PORT%  ^(this machine^)
) else (
    echo   Access your app at ^(localhost only — MTN/hotspot mode^):
    echo     https://localhost:%HTTPS_PORT%
    echo     http://localhost:%HTTP_PORT%    ^(redirects to HTTPS^)
    echo.
    echo   To enable LAN access later:
    echo     Set BIND_ADDRESS=0.0.0.0 in .env.local
    echo     Then restart DsaPayroll-Proxy service
)
echo.
echo   Windows Services ^(WinSW^):
echo     DsaPayroll-App.exe     status/start/stop/restart
echo     DsaPayroll-Proxy.exe   status/start/stop/restart
echo     DsaPayroll-Watcher.exe status/start/stop/restart
echo     DsaPayroll-mDNS.exe    status/start/stop/restart
echo     services.msc           ^(Windows Service Manager GUI^)
echo.
echo   Deploy ^(automatic on git push to master^):
echo     GitHub Actions deploys automatically via self-hosted runner
echo.
echo   Manual deploy on server:
echo     git pull ^&^& npm install ^&^& DsaPayroll-App.exe restart
echo.
echo   Manage:
echo     node install-service.js    ^(reinstall WinSW services^)
echo     node uninstall-service.js  ^(remove WinSW services^)
echo.
echo   .gitignore reminder:
echo     key.pem
echo     cert.pem
echo.
echo ============================================================
pause
