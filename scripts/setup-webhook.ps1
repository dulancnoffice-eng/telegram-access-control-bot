param(
  [Parameter(Mandatory=$true)][string]$WorkerUrl,
  [Parameter(Mandatory=$true)][string]$SetupSecret
)
$WorkerUrl = $WorkerUrl.TrimEnd("/")
Write-Host "Setting Telegram webhook..."
Invoke-RestMethod -Method Post -Uri "$WorkerUrl/admin/setup-webhook" -Headers @{ Authorization = "Bearer $SetupSecret" }
Write-Host ""
Write-Host "Webhook info:"
Invoke-RestMethod -Method Get -Uri "$WorkerUrl/admin/webhook-info" -Headers @{ Authorization = "Bearer $SetupSecret" }
