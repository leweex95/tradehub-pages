# MT5 Background Service — Technical Notes

## Can MT5 Run as a Background Service?

**Short answer:** Partially. The Python API works as a Windows service, but MetaTrader 5 Terminal (the GUI application) must be running on the machine.

### Architecture

```
                     ┌──────────────────────┐
                     │  Windows Service      │
                     │  (TradeHub Forward)   │
                     │                       │
                     │  python -m tradehub   │
                     │    service start      │
                     └──────────┬───────────┘
                                │ MT5 Python API
                                │ (via mt5.initialize())
                     ┌──────────▼───────────┐
                     │  MetaTrader 5         │
                     │  Terminal (GUI)       │
                     │  ┌─────────────────┐  │
                     │  │ Must be running  │  │
                     │  │ (even minimized) │  │
                     │  └─────────────────┘  │
                     └──────────┬───────────┘
                                │ FIX/MT5 protocol
                     ┌──────────▼───────────┐
                     │  Broker Server        │
                     │  (FxPro, etc.)        │
                     └──────────────────────┘
```

### What Works

1. **Windows Service Mode** (`python -m tradehub service install/start`)
   - TradeHub itself runs as a proper Windows service via `pywin32`
   - Starts on boot, survives user logoff
   - Logs to `logs/tradehub_service.log`

2. **Console Mode** (`python -m tradehub forward`)
   - Runs in foreground with Ctrl+C graceful shutdown
   - Best for development/testing

### Limitations

| Feature | Status | Notes |
|---------|--------|-------|
| Run without user logged in | ⚠️ Partial | Service runs, but MT5 Terminal needs an active session |
| Headless operation | ❌ No | MT5 Terminal is a Win32 GUI app |
| Docker/Linux | ❌ No | MT5 is Windows-only |
| Multiple accounts | ✅ Yes | One terminal + multi-login via Python API |
| Auto-restart on crash | ✅ Yes | Windows service recovery handles this |

### Recommended Setup for 24/7 Operation

1. **Use a Windows VPS** (e.g., Contabo Windows VPS, ~$10/mo)
2. **Install MT5 Terminal** and keep it running (auto-login)
3. **Install TradeHub service:**
   ```powershell
   pip install pywin32
   python -m tradehub service install
   python -m tradehub service start
   ```
4. **Configure Windows auto-logon** so MT5 starts after reboot:
   ```powershell
   # Set auto-logon (run as admin)
   $regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
   Set-ItemProperty -Path $regPath -Name AutoAdminLogon -Value 1
   Set-ItemProperty -Path $regPath -Name DefaultUserName -Value "YOUR_USER"
   Set-ItemProperty -Path $regPath -Name DefaultPassword -Value "YOUR_PASS"
   ```
5. **Add MT5 to startup** (shell:startup → shortcut to terminal64.exe)
6. **Set service recovery:** Services → TradeHubForwardTester → Recovery → Restart on failure

### Deploy Winner Strategy

After running optimizer:
```bash
python -m tradehub deploy-winner \
  --results-dir reports/optimize/YYYYMMDD_HHMMSS \
  --instruments EURUSD \
  --start
```

This will:
1. Find the best STABLE candidate (all perturbations positive)
2. Generate `config/forward_test.yaml` with that config
3. Start the forward tester immediately (if `--start` is passed)

### Alternative: Task Scheduler

If you don't want a Windows service, use Task Scheduler:
```powershell
$action = New-ScheduledTaskAction -Execute "python" `
  -Argument "-m tradehub forward --config config/forward_test.yaml" `
  -WorkingDirectory "C:\Users\csibi\Desktop\tradehub"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "TradeHub" -Action $action -Trigger $trigger `
  -RunLevel Highest -User "SYSTEM"
```
