$env:PATH = "C:\Program Files\PostgreSQL\18\bin;C:\Program Files\PostgreSQL\18\pgAdmin 4\runtime;" + $env:PATH
Write-Host "Starting PostgreSQL database server..."
Start-Process -FilePath "postgres.exe" -ArgumentList "-D `"C:\Program Files\PostgreSQL\18\data`"" -NoNewWindow
Start-Sleep -Seconds 3

$tcpConn = Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue
if ($tcpConn) {
    Write-Host "PostgreSQL is running and listening on port 5432." -ForegroundColor Green
} else {
    Write-Host "PostgreSQL failed to start. Check C:\Program Files\PostgreSQL\18\data\log for details." -ForegroundColor Red
}
