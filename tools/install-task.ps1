# Registers FilmVaultBot as a scheduled task that starts with Windows and restarts on crash.
# Run once in PowerShell: powershell -ExecutionPolicy Bypass -File tools\install-task.ps1
$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

# Output goes to runtime.log in the bot folder.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" index.js >> runtime.log 2>&1`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT2M'
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'FilmVaultBot' -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'FilmVault Discord bot (Jellyfin stream)' -Force | Out-Null
Start-ScheduledTask -TaskName 'FilmVaultBot'
Get-ScheduledTask -TaskName 'FilmVaultBot' | Select-Object TaskName, State
