@echo off
setlocal
if defined CLAUDE_CONFIG_DIR (set "MC_CFG=%CLAUDE_CONFIG_DIR%") else (set "MC_CFG=%USERPROFILE%\.claude")
node "%MC_CFG%\skills\model-coordinator\cli.mjs" %*
